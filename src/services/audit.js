import { query, queryOne } from '../db/pool.js';
import { getReadingsTable, rangeStart } from './readings.js';

/**
 * Data-reliability view for the medical officer:
 *  - sensor faults affecting this astronaut (plus cabin-wide faults)
 *  - recent readings with raw_value and trust reasons
 *  - confidence distribution for the last 7 days
 */
export async function buildAudit(astronautId, { metric, trustStatus, range = '24h' } = {}) {
  const faults = await query(
    `SELECT id, astronaut_id, device, metric, fault_type, details, detected_at
     FROM sensor_faults
     WHERE astronaut_id = ? OR astronaut_id IS NULL
     ORDER BY detected_at DESC LIMIT 60`,
    [astronautId],
  );

  const readings = await getReadingsTable(astronautId, {
    metric,
    trustStatus,
    range,
    limit: 300,
  });

  const bucketRows = await query(
    `SELECT LEAST(FLOOR(confidence * 5), 4) AS bucket, COUNT(*) AS count
     FROM readings
     WHERE astronaut_id = ? AND ts >= ?
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [astronautId, rangeStart(range)],
  );

  const buckets = ['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'].map((label, index) => ({
    bucket: label,
    count: Number(bucketRows.find((r) => Number(r.bucket) === index)?.count ?? 0),
  }));

  const trustRows = await query(
    `SELECT trust_status, COUNT(*) AS count
     FROM readings WHERE astronaut_id = ? AND ts >= ?
     GROUP BY trust_status`,
    [astronautId, rangeStart(range)],
  );

  const trustDistribution = { trusted: 0, suspect: 0, excluded: 0 };
  for (const row of trustRows) trustDistribution[row.trust_status] = Number(row.count);

  const excludedCount = trustDistribution.excluded;
  const total = Object.values(trustDistribution).reduce((a, b) => a + b, 0);

  return {
    faults: faults.map((f) => ({
      id: Number(f.id),
      astronautId: f.astronaut_id ? Number(f.astronaut_id) : null,
      device: f.device,
      metric: f.metric,
      faultType: f.fault_type,
      details: f.details,
      detectedAt: f.detected_at,
      scope: f.astronaut_id ? 'astronaut' : 'cabin',
    })),
    readings,
    confidenceDistribution: buckets,
    trustDistribution,
    reliability: {
      total,
      excludedCount,
      excludedPercent: total ? Math.round((excludedCount / total) * 1000) / 10 : 0,
    },
    range,
    filters: { metric: metric ?? null, trustStatus: trustStatus ?? null },
  };
}

export async function getAstronautProfile(astronautId) {
  const row = await queryOne(
    `SELECT u.id, u.name, u.email, r.status AS readiness_status,
            m.name AS medical_officer_name
     FROM users u
     LEFT JOIN readiness r ON r.astronaut_id = u.id
     LEFT JOIN assignments a ON a.astronaut_id = u.id
     LEFT JOIN users m ON m.id = a.medical_officer_id
     WHERE u.id = ? AND u.role = 'astronaut'`,
    [astronautId],
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    readiness: row.readiness_status ?? null,
    medicalOfficerName: row.medical_officer_name ?? null,
  };
}
