import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { queryOne } from '../db/pool.js';
import { buildReport, REPORT_TYPES, streamReportPdf } from '../services/reports.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';

const router = Router();
router.use(authenticate, requireRole('medical'));

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const reportQuerySchema = z.object({
  astronautId: z.coerce.number().int().positive().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

function resolveRange(query) {
  const to = query.to ?? new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const from = query.from ?? defaultFrom;

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw badRequest('Invalid date range');
  }
  if (fromDate > toDate) throw badRequest('The start date must be before the end date');
  const spanDays = Math.round((toDate - fromDate) / (24 * 60 * 60 * 1000));
  if (spanDays > 90) throw badRequest('Reports are limited to 90 days');
  return { from, to };
}

async function assertAssigned(astronautId, medicalOfficerId) {
  const assignment = await queryOne(
    'SELECT 1 AS ok FROM assignments WHERE astronaut_id = ? AND medical_officer_id = ?',
    [astronautId, medicalOfficerId],
  );
  if (!assignment) throw forbidden('This astronaut is not assigned to you');
}

async function prepare(req) {
  const type = req.params.type;
  if (!Object.hasOwn(REPORT_TYPES, type)) {
    throw notFound(`Unknown report type "${type}"`);
  }
  const { astronautId } = req.validatedQuery;
  const range = resolveRange(req.validatedQuery);

  if ((type === 'daily-health' || type === 'radiation' || type === 'data-reliability') && !astronautId) {
    throw badRequest('astronautId is required for this report type');
  }
  if (astronautId) await assertAssigned(astronautId, req.user.id);

  return {
    type,
    astronautId: astronautId ?? null,
    ...range,
  };
}

router.get(
  '/:type/pdf',
  validate({ query: reportQuerySchema }),
  async (req, res, next) => {
    try {
      const options = await prepare(req);
      const report = await buildReport(options.type, options);
      streamReportPdf(report, res);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/:type',
  validate({ query: reportQuerySchema }),
  async (req, res, next) => {
    try {
      const options = await prepare(req);
      const report = await buildReport(options.type, options);
      return res.json({ report });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
