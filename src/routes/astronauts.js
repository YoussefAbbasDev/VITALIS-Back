import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAstronautAccess, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  getBaselines,
  getLatestEcg,
  getMetricRanges,
  getReadingSeries,
  HEALTH_METRIC_ORDER,
  METRIC_LABELS,
} from '../services/readings.js';
import { buildAstronautSummary } from '../services/summary.js';
import { getRadiationSummary } from '../services/radiation.js';
import { getWellness } from '../services/wellness.js';
import { buildAudit } from '../services/audit.js';
import { query, queryOne } from '../db/pool.js';
import { badRequest, notFound } from '../utils/errors.js';

const router = Router();
router.use(authenticate);

const readingQuerySchema = z.object({
  metric: z.enum(HEALTH_METRIC_ORDER),
  range: z.enum(['1h', '24h', '7d']).default('24h'),
});

const radiationQuerySchema = z.object({
  range: z.enum(['1h', '24h', '7d']).default('7d'),
});

const auditQuerySchema = z.object({
  metric: z.enum(HEALTH_METRIC_ORDER).optional(),
  trustStatus: z.enum(['trusted', 'suspect', 'excluded']).optional(),
  range: z.enum(['1h', '24h', '7d']).default('24h'),
});

const noteSchema = z.object({
  kind: z.enum(['note', 'instruction']),
  body: z.string().trim().min(3).max(4000),
});

const readinessSchema = z.object({
  status: z.enum(['fit', 'limited', 'unfit']),
});

router.get('/:id/summary', requireAstronautAccess, async (req, res, next) => {
  try {
    const summary = await buildAstronautSummary(req.astronautId);
    if (!summary) throw notFound('Astronaut not found');
    return res.json(summary);
  } catch (err) {
    return next(err);
  }
});

router.get(
  '/:id/readings',
  requireAstronautAccess,
  validate({ query: readingQuerySchema }),
  async (req, res, next) => {
    try {
      const { metric, range } = req.validatedQuery;
      const [series, baselines, ranges] = await Promise.all([
        getReadingSeries(req.astronautId, metric, range),
        getBaselines(req.astronautId),
        getMetricRanges('health'),
      ]);
      return res.json({
        astronautId: req.astronautId,
        metric,
        label: METRIC_LABELS[metric],
        range,
        unit: ranges[metric]?.unit ?? series[0]?.unit ?? null,
        series,
        baseline: baselines[metric] ?? null,
        metricRange: ranges[metric] ?? null,
      });
    } catch (err) {
      return next(err);
    }
  },
);

router.get('/:id/baselines', requireAstronautAccess, async (req, res, next) => {
  try {
    const [baselines, ranges] = await Promise.all([
      getBaselines(req.astronautId),
      getMetricRanges('health'),
    ]);
    return res.json({ baselines, ranges });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/ecg/latest', requireAstronautAccess, async (req, res, next) => {
  try {
    const ecg = await getLatestEcg(req.astronautId);
    return res.json({ ecg });
  } catch (err) {
    return next(err);
  }
});

router.get(
  '/:id/radiation',
  requireAstronautAccess,
  validate({ query: radiationQuerySchema }),
  async (req, res, next) => {
    try {
      const radiation = await getRadiationSummary(req.astronautId, req.validatedQuery.range);
      return res.json({ range: req.validatedQuery.range, ...radiation });
    } catch (err) {
      return next(err);
    }
  },
);

router.get('/:id/wellness', requireAstronautAccess, async (req, res, next) => {
  try {
    const wellness = await getWellness(req.astronautId);
    return res.json(wellness);
  } catch (err) {
    return next(err);
  }
});

// Audit / reliability is a medical-officer view. Admin is already rejected by
// requireAstronautAccess; astronauts are rejected by requireRole.
router.get(
  '/:id/audit',
  requireAstronautAccess,
  requireRole('medical'),
  validate({ query: auditQuerySchema }),
  async (req, res, next) => {
    try {
      const { metric, trustStatus, range } = req.validatedQuery;
      const audit = await buildAudit(req.astronautId, { metric, trustStatus, range });
      return res.json(audit);
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  '/:id/notes',
  requireAstronautAccess,
  requireRole('medical'),
  async (req, res, next) => {
    try {
      const rows = await query(
        `SELECT n.id, n.astronaut_id, n.author_id, n.kind, n.body, n.created_at, n.read_at,
                a.name AS author_name
         FROM medical_notes n JOIN users a ON a.id = n.author_id
         WHERE n.astronaut_id = ?
         ORDER BY n.created_at DESC LIMIT 100`,
        [req.astronautId],
      );
      return res.json({
        notes: rows.map((n) => ({
          id: Number(n.id),
          astronautId: Number(n.astronaut_id),
          authorId: Number(n.author_id),
          authorName: n.author_name,
          kind: n.kind,
          body: n.body,
          createdAt: n.created_at,
          readAt: n.read_at,
        })),
      });
    } catch (err) {
      return next(err);
    }
  },
);

router.post(
  '/:id/notes',
  requireAstronautAccess,
  requireRole('medical'),
  validate({ body: noteSchema }),
  async (req, res, next) => {
    try {
      const { kind, body } = req.body;
      const result = await query(
        `INSERT INTO medical_notes (astronaut_id, author_id, kind, body)
         VALUES (?, ?, ?, ?)`,
        [req.astronautId, req.user.id, kind, body],
      );
      const note = await queryOne(
        `SELECT n.*, a.name AS author_name FROM medical_notes n
         JOIN users a ON a.id = n.author_id WHERE n.id = ?`,
        [result.insertId],
      );
      return res.status(201).json({
        note: {
          id: Number(note.id),
          astronautId: Number(note.astronaut_id),
          authorId: Number(note.author_id),
          authorName: note.author_name,
          kind: note.kind,
          body: note.body,
          createdAt: note.created_at,
          readAt: note.read_at,
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

router.put(
  '/:id/readiness',
  requireAstronautAccess,
  requireRole('medical'),
  validate({ body: readinessSchema }),
  async (req, res, next) => {
    try {
      const { status } = req.body;
      await query(
        `INSERT INTO readiness (astronaut_id, status, updated_by, updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE status = VALUES(status), updated_by = VALUES(updated_by), updated_at = NOW()`,
        [req.astronautId, status, req.user.id],
      );
      const row = await queryOne(
        'SELECT status, updated_at FROM readiness WHERE astronaut_id = ?',
        [req.astronautId],
      );
      return res.json({
        readiness: { status: row.status, updatedAt: row.updated_at },
      });
    } catch (err) {
      return next(err);
    }
  },
);

// Small helper used by the medical detail header.
router.get(
  '/:id/profile',
  requireAstronautAccess,
  requireRole('medical'),
  async (req, res, next) => {
    try {
      const row = await queryOne(
        `SELECT u.id, u.name, u.email, r.status AS readiness,
                a.medical_officer_id, m.name AS medical_officer_name
         FROM users u
         LEFT JOIN readiness r ON r.astronaut_id = u.id
         LEFT JOIN assignments a ON a.astronaut_id = u.id
         LEFT JOIN users m ON m.id = a.medical_officer_id
         WHERE u.id = ?`,
        [req.astronautId],
      );
      if (!row) throw badRequest('Astronaut not found');
      return res.json({
        profile: {
          id: Number(row.id),
          name: row.name,
          email: row.email,
          readiness: row.readiness ?? null,
          medicalOfficerId: row.medical_officer_id ? Number(row.medical_officer_id) : null,
          medicalOfficerName: row.medical_officer_name ?? null,
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
