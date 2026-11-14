import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { createInvite } from '../services/invites.js';
import { getMission } from '../services/mission.js';
import { badRequest, conflict, notFound, forbidden } from '../utils/errors.js';

const router = Router();

// Every admin route requires an authenticated admin. Clinical data is never
// selected in this file.
router.use(authenticate, requireRole('admin'));

const userBaseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(190),
  role: z.enum(['medical', 'astronaut']),
});

const patchUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.isActive !== undefined, {
    message: 'Provide name or isActive',
  });

const assignmentSchema = z.object({
  astronautId: z.coerce.number().int().positive(),
  medicalOfficerId: z.coerce.number().int().positive().nullable(),
});

const missionSchema = z.object({
  name: z.string().trim().min(2).max(160),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  radiationLimitMsv: z.coerce.number().positive().max(10000),
  exerciseTargetMinPerDay: z.coerce.number().int().min(0).max(600),
});

function mapUser(row) {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    readiness: row.readiness_status ?? null,
    medicalOfficerId: row.medical_officer_id ? Number(row.medical_officer_id) : null,
    medicalOfficerName: row.medical_officer_name ?? null,
    hasPendingInvite: Boolean(Number(row.has_pending_invite)),
  };
}

async function findUser(id) {
  return queryOne(
    'SELECT id, name, email, role, is_active, password_hash FROM users WHERE id = ?',
    [id],
  );
}

router.get('/overview', async (req, res, next) => {
  try {
    const mission = await getMission();
    const crew = await query(
      `SELECT u.id, u.name, u.role, r.status AS readiness_status
       FROM users u
       LEFT JOIN readiness r ON r.astronaut_id = u.id
       WHERE u.role = 'astronaut' AND u.is_active = 1
       ORDER BY FIELD(r.status, 'unfit', 'limited', 'fit') DESC, u.name ASC`,
    );

    // Operational alerts only, with no clinical context.
    const alerts = await query(
      `SELECT id, title, category, severity, created_at
       FROM alerts
       WHERE resolved_at IS NULL AND category IN ('device', 'environment')
       ORDER BY created_at DESC
       LIMIT 30`,
    );

    return res.json({
      mission,
      crew: crew.map((c) => ({
        id: Number(c.id),
        name: c.name,
        role: c.role,
        readiness: c.readiness_status ?? null,
        isActive: true,
      })),
      alerts: alerts.map((a) => ({
        id: Number(a.id),
        title: a.title,
        category: a.category,
        severity: a.severity,
        createdAt: a.created_at,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
              a.medical_officer_id, m.name AS medical_officer_name,
              r.status AS readiness_status,
              EXISTS (
                SELECT 1 FROM invites i
                WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > NOW()
              ) AS has_pending_invite
       FROM users u
       LEFT JOIN assignments a ON a.astronaut_id = u.id
       LEFT JOIN users m ON m.id = a.medical_officer_id
       LEFT JOIN readiness r ON r.astronaut_id = u.id
       ORDER BY FIELD(u.role, 'admin', 'medical', 'astronaut'), u.name ASC`,
    );
    return res.json({ users: rows.map(mapUser) });
  } catch (err) {
    return next(err);
  }
});

router.post('/users', validate({ body: userBaseSchema }), async (req, res, next) => {
  try {
    const { name, email, role } = req.body;
    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) throw conflict('A member with this email already exists');

    const result = await query(
      'INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, ?, NULL)',
      [name, email, role],
    );
    const userId = Number(result.insertId);
    const invite = await createInvite(userId);

    return res.status(201).json({
      user: { id: userId, name, email, role, isActive: true, readiness: null },
      invite,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/users/:id/reinvite', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = await findUser(id);
    if (!user) throw notFound('Member not found');
    if (!user.is_active) throw badRequest('Reactivate the member before sending an invite');
    if (!['medical', 'astronaut'].includes(user.role)) {
      throw forbidden('Admins do not use invite links');
    }

    const invite = await createInvite(id);
    return res.json({ invite });
  } catch (err) {
    return next(err);
  }
});

router.patch('/users/:id', validate({ body: patchUserSchema }), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = await findUser(id);
    if (!user) throw notFound('Member not found');

    if (id === req.user.id && req.body.isActive === false) {
      throw badRequest('You cannot deactivate your own account');
    }

    if (user.role === 'admin' && req.body.isActive === false) {
      throw badRequest('The mission commander account cannot be deactivated');
    }

    const fields = [];
    const params = [];
    if (req.body.name !== undefined) {
      fields.push('name = ?');
      params.push(req.body.name);
    }
    if (req.body.isActive !== undefined) {
      fields.push('is_active = ?');
      params.push(req.body.isActive ? 1 : 0);
    }
    params.push(id);
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);

    const updated = await queryOne(
      `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
              r.status AS readiness_status
       FROM users u LEFT JOIN readiness r ON r.astronaut_id = u.id
       WHERE u.id = ?`,
      [id],
    );
    return res.json({ user: mapUser(updated) });
  } catch (err) {
    return next(err);
  }
});

router.put('/assignments', validate({ body: assignmentSchema }), async (req, res, next) => {
  try {
    const { astronautId, medicalOfficerId } = req.body;

    const astronaut = await findUser(astronautId);
    if (!astronaut || astronaut.role !== 'astronaut' || !astronaut.is_active) {
      throw badRequest('Choose an active astronaut');
    }

    if (medicalOfficerId === null) {
      await query('DELETE FROM assignments WHERE astronaut_id = ?', [astronautId]);
      return res.json({ assignment: null });
    }

    const officer = await findUser(medicalOfficerId);
    if (!officer || officer.role !== 'medical' || !officer.is_active) {
      throw badRequest('Choose an active medical officer');
    }

    await query(
      `INSERT INTO assignments (astronaut_id, medical_officer_id) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE medical_officer_id = VALUES(medical_officer_id)`,
      [astronautId, medicalOfficerId],
    );

    return res.json({
      assignment: {
        astronautId,
        medicalOfficerId,
        medicalOfficerName: officer.name,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/mission', async (req, res, next) => {
  try {
    const mission = await getMission();
    if (!mission) throw notFound('No mission configured');
    return res.json({ mission });
  } catch (err) {
    return next(err);
  }
});

router.patch('/mission', validate({ body: missionSchema }), async (req, res, next) => {
  try {
    const mission = await getMission();
    if (!mission) throw notFound('No mission configured');
    if (req.body.endDate < req.body.startDate) {
      throw badRequest('End date must be on or after the start date');
    }

    await query(
      `UPDATE missions
       SET name = ?, start_date = ?, end_date = ?, radiation_limit_msv = ?, exercise_target_min_per_day = ?
       WHERE id = ?`,
      [
        req.body.name,
        req.body.startDate,
        req.body.endDate,
        req.body.radiationLimitMsv,
        req.body.exerciseTargetMinPerDay,
        mission.id,
      ],
    );

    const updated = await getMission();
    return res.json({ mission: updated });
  } catch (err) {
    return next(err);
  }
});

export default router;
