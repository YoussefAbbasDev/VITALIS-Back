import { query, queryOne } from '../db/pool.js';
import { getMetricRanges, METRIC_LABELS } from './readings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ENV_METRICS = new Set(['o2', 'co2', 'pressure', 'temperature', 'humidity', 'air_quality']);
const SEVERITY_ORDER = { critical: 0, warning: 1, normal: 2 };

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function mapAlert(row, { redacted = false } = {}) {
  const mapped = {
    id: Number(row.id),
    category: row.category,
    severity: row.severity,
    astronautId: row.astronaut_id ? Number(row.astronaut_id) : null,
    astronautName: row.astronaut_name ?? null,
    title: row.title,
    description: row.description,
    possibleCauses: parseJson(row.possible_causes, []),
    recommendation: row.recommendation,
    confidence: Number(row.confidence),
    basisText: row.basis_text,
    confirmedSensorCount: row.confirmed_sensor_count === null ? null : Number(row.confirmed_sensor_count),
    relatedMetrics: parseJson(row.related_metrics, []),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    acknowledgedBy: row.acknowledged_by ? Number(row.acknowledged_by) : null,
    acknowledgedAt: row.acknowledged_at,
    escalatedAt: row.escalated_at,
    status: row.resolved_at
      ? 'resolved'
      : row.escalated_at
        ? 'escalated'
        : row.acknowledged_at
          ? 'acknowledged'
          : 'active',
  };

  // Admin responses never include clinical context, causes or recommendations.
  if (redacted) {
    return {
      id: mapped.id,
      category: mapped.category,
      severity: mapped.severity,
      title: mapped.title,
      status: mapped.status,
      createdAt: mapped.createdAt,
      resolvedAt: mapped.resolvedAt,
    };
  }
  return mapped;
}

// Redacted shape for the admin room/API: operational facts only.
export function redactAlert(alert) {
  return {
    id: alert.id,
    category: alert.category,
    severity: alert.severity,
    title: alert.title,
    status: alert.status,
    createdAt: alert.createdAt,
    resolvedAt: alert.resolvedAt,
  };
}

const ALERT_SELECT = `
  SELECT a.*, u.name AS astronaut_name
  FROM alerts a
  LEFT JOIN users u ON u.id = a.astronaut_id
`;

// ---------------------------------------------------------------------------
// Data-consistency layer (read-only)
//
// An alert row can still be open while the underlying monitoring data has
// already returned to normal. We never write to the monitoring tables; instead
// every API response annotates such an alert with dataRecovered and treats it
// as resolved-by-data, removing it from active counts and the overall status.
// ---------------------------------------------------------------------------
export function countAlertsBySeverity(alerts) {
  const counts = { normal: 0, warning: 0, critical: 0, total: 0 };
  for (const alert of alerts) {
    if (alert.status === 'resolved' || alert.dataRecovered) continue;
    if (counts[alert.severity] !== undefined && alert.severity !== 'total') {
      counts[alert.severity] += 1;
    }
    counts.total += 1;
  }
  return counts;
}

/** Severity first, then confidence, sensor corroboration, then recency. */
export function sortAlertsByPriority(alerts) {
  return [...alerts].sort((a, b) => {
    const severity = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (severity !== 0) return severity;
    const confidence = Number(b.confidence ?? 0) - Number(a.confidence ?? 0);
    if (confidence !== 0) return confidence;
    const sensors = Number(b.confirmedSensorCount ?? 0) - Number(a.confirmedSensorCount ?? 0);
    if (sensors !== 0) return sensors;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

async function radiationContext(astronautId) {
  const latest = await queryOne(
    `SELECT rate_usv_per_h, cumulative_msv, ts FROM radiation_readings
     WHERE astronaut_id = ? AND trust_status = 'trusted'
     ORDER BY ts DESC, id DESC LIMIT 1`,
    [astronautId],
  );
  if (!latest) return null;

  const first = await queryOne(
    `SELECT cumulative_msv, ts FROM radiation_readings
     WHERE astronaut_id = ? AND trust_status = 'trusted' AND ts >= ?
     ORDER BY ts ASC, id ASC LIMIT 1`,
    [astronautId, new Date(Date.now() - 7 * DAY_MS)],
  );

  let averageDailyDoseLast7d = null;
  if (first) {
    const elapsedDays = Math.max(
      0.01,
      (new Date(latest.ts).getTime() - new Date(first.ts).getTime()) / DAY_MS,
    );
    averageDailyDoseLast7d =
      (Number(latest.cumulative_msv) - Number(first.cumulative_msv)) / elapsedDays;
  } else {
    averageDailyDoseLast7d = (Number(latest.rate_usv_per_h) / 1000) * 24;
  }

  const averageRate = (averageDailyDoseLast7d * 1000) / 24;
  return {
    currentRate: Number(latest.rate_usv_per_h),
    ts: latest.ts,
    averageDailyDoseLast7d,
    averageRate,
    percentAboveAverage: averageRate > 0
      ? ((Number(latest.rate_usv_per_h) - averageRate) / averageRate) * 100
      : 0,
  };
}

async function buildConsistencyContext(alerts) {
  const astronautIds = [...new Set(alerts.map((a) => a.astronautId).filter((id) => id !== null))];
  const healthMetrics = new Set();
  const envMetrics = new Set();
  let needsRadiation = false;

  for (const alert of alerts) {
    for (const metric of alert.relatedMetrics ?? []) {
      if (metric === 'radiation') needsRadiation = true;
      else if (ENV_METRICS.has(metric)) envMetrics.add(metric);
      else healthMetrics.add(metric);
    }
    if (alert.category === 'radiation') needsRadiation = true;
  }

  const context = {
    ranges: await getMetricRanges(),
    health: new Map(),
    environment: new Map(),
    radiation: new Map(),
  };

  if (astronautIds.length && healthMetrics.size) {
    const idPlaceholders = astronautIds.map(() => '?').join(', ');
    const metricPlaceholders = [...healthMetrics].map(() => '?').join(', ');
    const rows = await query(
      `SELECT * FROM (
         SELECT r.*, ROW_NUMBER() OVER (PARTITION BY astronaut_id, metric ORDER BY ts DESC, id DESC) AS rn
         FROM readings r
         WHERE trust_status = 'trusted'
           AND astronaut_id IN (${idPlaceholders})
           AND metric IN (${metricPlaceholders})
       ) x WHERE rn = 1`,
      [...astronautIds, ...healthMetrics],
    );
    for (const row of rows) {
      context.health.set(`${row.astronaut_id}:${row.metric}`, {
        value: Number(row.value),
        unit: row.unit,
        ts: row.ts,
      });
    }
  }

  if (envMetrics.size) {
    const metricPlaceholders = [...envMetrics].map(() => '?').join(', ');
    const rows = await query(
      `SELECT * FROM (
         SELECT e.*, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY ts DESC, id DESC) AS rn
         FROM environment_readings e
         WHERE trust_status = 'trusted' AND metric IN (${metricPlaceholders})
       ) x WHERE rn = 1`,
      [...envMetrics],
    );
    for (const row of rows) {
      context.environment.set(row.metric, {
        value: Number(row.value),
        unit: row.unit,
        ts: row.ts,
      });
    }
  }

  if (needsRadiation) {
    for (const astronautId of astronautIds) {
      const rad = await radiationContext(astronautId);
      if (rad) context.radiation.set(astronautId, rad);
    }
  }

  return context;
}

function latestMetricEntry(alert, metric, context) {
  const range = context.ranges[metric];
  let row = null;
  if (metric === 'radiation') {
    const rad = context.radiation.get(alert.astronautId);
    if (!rad) return null;
    return {
      metric,
      label: 'Dose rate',
      value: rad.currentRate,
      unit: 'µSv/h',
      ts: rad.ts,
      inRange: rad.percentAboveAverage <= 10,
      averageRate: rad.averageRate,
      percentAboveAverage: rad.percentAboveAverage,
    };
  }
  if (ENV_METRICS.has(metric)) row = context.environment.get(metric);
  else if (alert.astronautId !== null) row = context.health.get(`${alert.astronautId}:${metric}`);
  if (!row) return null;

  return {
    metric,
    label: METRIC_LABELS[metric] ?? metric,
    value: row.value,
    unit: row.unit ?? range?.unit ?? null,
    ts: row.ts,
    safeMin: range?.safeMin ?? null,
    safeMax: range?.safeMax ?? null,
    inRange: range ? row.value >= range.safeMin && row.value <= range.safeMax : null,
  };
}

function isAlertRecoveredByData(alert, context) {
  const metrics = alert.relatedMetrics ?? [];
  if (!metrics.length) return false;

  if (alert.category === 'radiation' || metrics.includes('radiation')) {
    const rad = context.radiation.get(alert.astronautId);
    if (!rad || !Number.isFinite(rad.averageRate) || rad.averageRate <= 0) return false;
    return rad.currentRate <= rad.averageRate * 1.1;
  }

  const checks = metrics.map((metric) => latestMetricEntry(alert, metric, context));
  if (checks.some((entry) => entry === null)) return false;
  return checks.every((entry) => entry.inRange === true);
}

export async function annotateAlertsConsistency(alerts) {
  if (!alerts.length) return alerts;
  const context = await buildConsistencyContext(alerts);

  for (const alert of alerts) {
    alert.currentMetrics = (alert.relatedMetrics ?? [])
      .map((metric) => latestMetricEntry(alert, metric, context))
      .filter(Boolean);

    const recovered = !alert.resolvedAt && isAlertRecoveredByData(alert, context);
    alert.dataRecovered = recovered;
    if (recovered) {
      alert.resolvedByData = true;
      alert.status = 'resolved';
      alert.resolvedAt = alert.currentMetrics.find((metric) => metric.ts)?.ts ?? new Date().toISOString();
    }
  }

  return alerts;
}

export async function getAlertById(id) {
  const row = await queryOne(`${ALERT_SELECT} WHERE a.id = ?`, [id]);
  if (!row) return null;
  const [alert] = await annotateAlertsConsistency([mapAlert(row)]);
  return alert;
}

// Admin: operational categories only. Medical: cabin-wide + assigned crew.
// Astronaut: own alerts + cabin-wide alerts.
export async function canAccessAlert(user, alert) {
  if (!alert) return false;
  if (user.role === 'admin') {
    return alert.category === 'device' || alert.category === 'environment';
  }
  if (user.role === 'astronaut') {
    return alert.astronautId === null || alert.astronautId === user.id;
  }
  if (user.role === 'medical') {
    if (alert.astronautId === null) return true;
    const assignment = await queryOne(
      'SELECT 1 AS ok FROM assignments WHERE astronaut_id = ? AND medical_officer_id = ?',
      [alert.astronautId, user.id],
    );
    return Boolean(assignment);
  }
  return false;
}

export async function listAlertsForUser(user, filters) {
  const where = [];
  const params = [];

  if (user.role === 'admin') {
    where.push("a.category IN ('device', 'environment')");
    if (filters.category && !['device', 'environment'].includes(filters.category)) {
      return [];
    }
  } else if (user.role === 'medical') {
    where.push(
      '(a.astronaut_id IS NULL OR a.astronaut_id IN (SELECT astronaut_id FROM assignments WHERE medical_officer_id = ?))',
    );
    params.push(user.id);
  } else if (user.role === 'astronaut') {
    where.push('(a.astronaut_id IS NULL OR a.astronaut_id = ?)');
    params.push(user.id);
  } else {
    return [];
  }

  if (filters.category) {
    where.push('a.category = ?');
    params.push(filters.category);
  }
  if (filters.severity) {
    where.push('a.severity = ?');
    params.push(filters.severity);
  }
  if (filters.status === 'active') where.push('a.resolved_at IS NULL');
  if (filters.status === 'resolved') where.push('a.resolved_at IS NOT NULL');
  if (filters.astronautId) {
    where.push('a.astronaut_id = ?');
    params.push(filters.astronautId);
  }

  const rows = await query(
    `${ALERT_SELECT}
     WHERE ${where.join(' AND ')}
     ORDER BY a.resolved_at IS NOT NULL ASC,
              FIELD(a.severity, 'critical', 'warning', 'normal'),
              a.created_at DESC`,
    params,
  );

  let mapped = rows.map((row) => mapAlert(row, { redacted: user.role === 'admin' }));
  // Admin responses are operational only and never carry clinical context.
  if (user.role !== 'admin') mapped = await annotateAlertsConsistency(mapped);

  if (filters.status === 'active') {
    mapped = mapped.filter((alert) => !alert.dataRecovered);
  }

  const total = mapped.length;
  return {
    alerts: mapped.slice(0, filters.limit ?? 100),
    total,
  };
}

/** Active alerts exactly as the UI lists them (personal + cabin-wide). */
export async function getActiveAlertsForAstronaut(astronautId, { limit = null } = {}) {
  const rows = await query(
    `${ALERT_SELECT}
     WHERE (a.astronaut_id = ? OR a.astronaut_id IS NULL) AND a.resolved_at IS NULL
     ORDER BY FIELD(a.severity, 'critical', 'warning', 'normal'), a.created_at DESC`,
    [astronautId],
  );
  const alerts = await annotateAlertsConsistency(rows.map((row) => mapAlert(row)));
  const active = sortAlertsByPriority(alerts.filter((alert) => !alert.dataRecovered));
  return limit ? active.slice(0, limit) : active;
}

/** One shared active-alert list per astronaut, used by summary, crew and counts. */
export async function getActiveAlertsForMany(astronautIds) {
  const map = new Map(astronautIds.map((id) => [id, []]));
  if (!astronautIds.length) return map;

  const placeholders = astronautIds.map(() => '?').join(', ');
  const rows = await query(
    `${ALERT_SELECT}
     WHERE (a.astronaut_id IN (${placeholders}) OR a.astronaut_id IS NULL)
       AND a.resolved_at IS NULL
     ORDER BY FIELD(a.severity, 'critical', 'warning', 'normal'), a.created_at DESC`,
    astronautIds,
  );
  const alerts = await annotateAlertsConsistency(rows.map((row) => mapAlert(row)));
  const active = sortAlertsByPriority(alerts.filter((alert) => !alert.dataRecovered));

  for (const alert of active) {
    if (alert.astronautId === null) {
      for (const id of astronautIds) map.get(id).push(alert);
    } else if (map.has(alert.astronautId)) {
      map.get(alert.astronautId).push(alert);
    }
  }
  return map;
}

export async function getActiveAlertCounts(astronautId) {
  const alerts = await getActiveAlertsForAstronaut(astronautId);
  return countAlertsBySeverity(alerts);
}

export async function getActiveAlertCountsForMany(astronautIds) {
  const map = new Map(
    astronautIds.map((id) => [id, { normal: 0, warning: 0, critical: 0, total: 0 }]),
  );
  const alertsByAstronaut = await getActiveAlertsForMany(astronautIds);
  for (const [id, alerts] of alertsByAstronaut) {
    map.set(id, countAlertsBySeverity(alerts));
  }
  return map;
}

export async function getRecentAlertsForAstronaut(astronautId, limit = 5) {
  const alerts = await getActiveAlertsForAstronaut(astronautId, { limit });
  return alerts;
}
