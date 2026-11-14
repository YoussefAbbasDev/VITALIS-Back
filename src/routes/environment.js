import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  getEnvironmentSeries,
  getLatestEnvironment,
  getMetricRanges,
  METRIC_LABELS,
} from '../services/readings.js';

const router = Router();

// Cabin-wide environment is visible to astronauts and medical officers only.
router.use(authenticate, requireRole('astronaut', 'medical'));

const metricEnum = z.enum(['o2', 'co2', 'pressure', 'temperature', 'humidity', 'air_quality']);

const readingsQuery = z.object({
  metric: metricEnum,
  range: z.enum(['1h', '24h', '7d']).default('24h'),
});

router.get('/latest', async (req, res, next) => {
  try {
    const metrics = await getLatestEnvironment();
    return res.json({ metrics, updatedAt: metrics.find((m) => m.ts)?.ts ?? null });
  } catch (err) {
    return next(err);
  }
});

router.get('/readings', validate({ query: readingsQuery }), async (req, res, next) => {
  try {
    const { metric, range } = req.validatedQuery;
    const [series, ranges] = await Promise.all([
      getEnvironmentSeries(metric, range),
      getMetricRanges('environment'),
    ]);
    return res.json({
      metric,
      label: METRIC_LABELS[metric],
      range,
      unit: ranges[metric]?.unit ?? series[0]?.unit ?? null,
      metricRange: ranges[metric] ?? null,
      series,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
