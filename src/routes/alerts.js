import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { query } from '../db/pool.js';
import { canAccessAlert, getAlertById, listAlertsForUser, redactAlert } from '../services/alerts.js';
import { forbidden, notFound } from '../utils/errors.js';

const router = Router();
router.use(authenticate);

const listQuery = z.object({
  category: z.enum(['health', 'environment', 'radiation', 'device', 'wellness']).optional(),
  severity: z.enum(['normal', 'warning', 'critical']).optional(),
  status: z.enum(['active', 'resolved', 'all']).default('active'),
  astronautId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(300).default(100),
});

async function loadAccessibleAlert(req) {
  const alert = await getAlertById(Number(req.params.id));
  if (!alert) throw notFound('Alert not found');
  const allowed = await canAccessAlert(req.user, alert);
  if (!allowed) throw forbidden('This alert is not available to you');
  return alert;
}

router.get('/', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const { alerts, total } = await listAlertsForUser(req.user, req.validatedQuery);
    return res.json({ alerts, total });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const alert = await loadAccessibleAlert(req);
    return res.json({ alert: req.user.role === 'admin' ? redactAlert(alert) : alert });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/acknowledge', async (req, res, next) => {
  try {
    if (req.user.role === 'admin') throw forbidden('Mission command cannot acknowledge clinical alerts');
    await loadAccessibleAlert(req);

    await query(
      `UPDATE alerts
       SET acknowledged_by = COALESCE(acknowledged_by, ?),
           acknowledged_at = COALESCE(acknowledged_at, NOW(3))
       WHERE id = ?`,
      [req.user.id, Number(req.params.id)],
    );
    const alert = await loadAccessibleAlert(req);
    return res.json({ alert });
  } catch (err) {
    return next(err);
  }
});

// Astronauts escalate their own alerts to the assigned medical officer.
router.post('/:id/escalate', requireRole('astronaut'), async (req, res, next) => {
  try {
    const existing = await getAlertById(Number(req.params.id));
    if (!existing) throw notFound('Alert not found');
    if (existing.astronautId !== req.user.id) {
      throw forbidden('You can only escalate your own alerts');
    }
    await query(
      'UPDATE alerts SET escalated_at = COALESCE(escalated_at, NOW(3)) WHERE id = ?',
      [existing.id],
    );
    const alert = await loadAccessibleAlert(req);
    return res.json({ alert });
  } catch (err) {
    return next(err);
  }
});

// Resolve is a medical action and mirrors the "resolve" control required on the
// medical alerts page (the endpoint list omitted it, the page spec requires it).
router.post('/:id/resolve', requireRole('medical'), async (req, res, next) => {
  try {
    await loadAccessibleAlert(req);
    await query(
      'UPDATE alerts SET resolved_at = COALESCE(resolved_at, NOW(3)) WHERE id = ?',
      [Number(req.params.id)],
    );
    const alert = await loadAccessibleAlert(req);
    return res.json({ alert });
  } catch (err) {
    return next(err);
  }
});

export default router;
