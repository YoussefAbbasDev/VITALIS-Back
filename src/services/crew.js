import { query } from '../db/pool.js';
import { getBaselines, getMetricRanges } from './readings.js';
import { computeOverallStatus, getAlertCountsForMany, getLatestReadingsForMany } from './status.js';

const READINESS_ORDER = { unfit: 0, limited: 1, fit: 2 };
const LEVEL_ORDER = { critical: 0, warning: 1, normal: 2 };

/**
 * Crew list for the medical officer: only assigned astronauts, newest data
 * summarised into an overall status, active alert counts and readiness.
 */
export async function buildCrew(medicalOfficerId) {
  const astronauts = await query(
    `SELECT u.id, u.name, u.email, r.status AS readiness_status, r.updated_at AS readiness_updated_at
     FROM users u
     JOIN assignments a ON a.astronaut_id = u.id
     LEFT JOIN readiness r ON r.astronaut_id = u.id
     WHERE a.medical_officer_id = ? AND u.role = 'astronaut' AND u.is_active = 1
     ORDER BY u.name ASC`,
    [medicalOfficerId],
  );

  if (!astronauts.length) return [];

  const ids = astronauts.map((a) => Number(a.id));
  const placeholders = ids.map(() => '?').join(', ');

  const [latestMap, alertCounts, ranges, lastUpdates] = await Promise.all([
    getLatestReadingsForMany(ids),
    getAlertCountsForMany(ids),
    getMetricRanges('health'),
    query(
      `SELECT astronaut_id, MAX(ts) AS last_update
       FROM readings WHERE astronaut_id IN (${placeholders})
       GROUP BY astronaut_id`,
      ids,
    ),
  ]);

  const lastUpdateMap = new Map(
    lastUpdates.map((r) => [Number(r.astronaut_id), r.last_update]),
  );

  // Baselines differ per astronaut; fetch them in one query and group in JS.
  const baselineRows = await query(
    `SELECT astronaut_id, metric, mean, std FROM baselines WHERE astronaut_id IN (${placeholders})`,
    ids,
  );
  const baselinesByAstronaut = new Map(ids.map((id) => [id, {}]));
  for (const row of baselineRows) {
    const map = baselinesByAstronaut.get(Number(row.astronaut_id));
    if (map) map[row.metric] = { mean: Number(row.mean), std: Number(row.std) };
  }

  const crew = astronauts.map((astronaut) => {
    const id = Number(astronaut.id);
    const counts = alertCounts.get(id) ?? { normal: 0, warning: 0, critical: 0, total: 0 };
    const readings = latestMap.get(id) ?? [];
    const overall = computeOverallStatus({
      readings,
      ranges,
      baselines: baselinesByAstronaut.get(id),
      readiness: astronaut.readiness_status,
      alertCounts: counts,
    });

    return {
      id,
      name: astronaut.name,
      email: astronaut.email,
      readiness: astronaut.readiness_status ?? null,
      readinessUpdatedAt: astronaut.readiness_updated_at ?? null,
      overall,
      activeAlerts: counts,
      lastUpdate: lastUpdateMap.get(id) ?? null,
      metrics: readings.map((r) => ({
        metric: r.metric,
        value: r.value,
        unit: r.unit,
        trustStatus: r.trustStatus,
        ts: r.ts,
      })),
    };
  });

  crew.sort((a, b) => {
    const level = LEVEL_ORDER[a.overall.level] - LEVEL_ORDER[b.overall.level];
    if (level !== 0) return level;
    const readiness =
      (READINESS_ORDER[a.readiness] ?? 3) - (READINESS_ORDER[b.readiness] ?? 3);
    if (readiness !== 0) return readiness;
    return a.name.localeCompare(b.name);
  });

  return crew;
}
