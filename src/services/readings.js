import { query, queryOne } from '../db/pool.js';

export const HEALTH_METRIC_ORDER = [
  'heart_rate',
  'spo2',
  'bp_systolic',
  'bp_diastolic',
  'body_temp',
  'resp_rate',
];

export const METRIC_LABELS = {
  heart_rate: 'Heart rate',
  spo2: 'SpO2',
  bp_systolic: 'Systolic BP',
  bp_diastolic: 'Diastolic BP',
  body_temp: 'Body temperature',
  resp_rate: 'Respiration',
  o2: 'Oxygen (O2)',
  co2: 'Carbon dioxide (CO2)',
  pressure: 'Cabin pressure',
  temperature: 'Cabin temperature',
  humidity: 'Humidity',
  air_quality: 'Air quality',
};

export const RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

export function rangeStart(range) {
  return new Date(Date.now() - (RANGE_MS[range] ?? RANGE_MS['24h']));
}

function mapTrusted(row) {
  return row ? { value: Number(row.value), ts: row.ts } : null;
}

export function mapReading(row, lastTrusted) {
  return {
    id: Number(row.id),
    metric: row.metric,
    value: Number(row.value),
    unit: row.unit,
    ts: row.ts,
    confidence: Number(row.confidence),
    trustStatus: row.trust_status,
    trustReason: row.trust_reason ?? null,
    sourceDevice: row.source_device,
    lastTrusted: lastTrusted ?? null,
  };
}

export async function getBaselines(astronautId) {
  const rows = await query(
    'SELECT metric, mean, std FROM baselines WHERE astronaut_id = ?',
    [astronautId],
  );
  const map = {};
  for (const row of rows) {
    map[row.metric] = { mean: Number(row.mean), std: Number(row.std) };
  }
  return map;
}

export async function getMetricRanges(scope = null) {
  const rows = scope
    ? await query('SELECT * FROM metric_ranges WHERE scope = ?', [scope])
    : await query('SELECT * FROM metric_ranges');
  const map = {};
  for (const row of rows) {
    map[row.metric] = {
      metric: row.metric,
      scope: row.scope,
      safeMin: Number(row.safe_min),
      safeMax: Number(row.safe_max),
      criticalMin: Number(row.critical_min),
      criticalMax: Number(row.critical_max),
      unit: row.unit,
    };
  }
  return map;
}

// Latest row per metric (window function, works on MySQL 8 and MariaDB 10.4).
export async function getLatestReadings(astronautId) {
  const latestRows = await query(
    `SELECT * FROM (
       SELECT r.*, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY ts DESC, id DESC) AS rn
       FROM readings r WHERE astronaut_id = ?
     ) x WHERE rn = 1`,
    [astronautId],
  );

  const trustedRows = await query(
    `SELECT * FROM (
       SELECT r.*, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY ts DESC, id DESC) AS rn
       FROM readings r WHERE astronaut_id = ? AND trust_status = 'trusted'
     ) x WHERE rn = 1`,
    [astronautId],
  );

  const trustedByMetric = Object.fromEntries(trustedRows.map((r) => [r.metric, r]));
  const byMetric = Object.fromEntries(latestRows.map((r) => [r.metric, r]));

  return HEALTH_METRIC_ORDER.filter((m) => byMetric[m]).map((metric) => {
    const row = byMetric[metric];
    const trusted = staticLastTrusted(row, trustedByMetric[metric]);
    return mapReading(row, trusted);
  });
}

function staticLastTrusted(row, trustedRow) {
  if (row.trust_status === 'trusted') {
    return { value: Number(row.value), ts: row.ts };
  }
  return mapTrusted(trustedRow);
}

// A metric series with a carry-forward lastTrusted value for every point, so a
// suspect/excluded point always has the last good value next to it.
export async function getReadingSeries(astronautId, metric, range) {
  const since = rangeStart(range);
  const rows = await query(
    `SELECT * FROM readings
     WHERE astronaut_id = ? AND metric = ? AND ts >= ?
     ORDER BY ts ASC, id ASC`,
    [astronautId, metric, since],
  );
  if (!rows.length) return [];

  const previous = await queryOne(
    `SELECT value, ts FROM readings
     WHERE astronaut_id = ? AND metric = ? AND trust_status = 'trusted' AND ts < ?
     ORDER BY ts DESC, id DESC LIMIT 1`,
    [astronautId, metric, since],
  );

  let carry = mapTrusted(previous);
  return rows.map((row) => {
    const item = mapReading(row, carry);
    if (row.trust_status === 'trusted') {
      carry = { value: Number(row.value), ts: row.ts };
    }
    return item;
  });
}

// A paginated/filterable table for the Health page and the audit view.
export async function getReadingsTable(astronautId, { metric, range, trustStatus, limit = 200 }) {
  const where = ['astronaut_id = ?'];
  const params = [astronautId];
  if (metric) {
    where.push('metric = ?');
    params.push(metric);
  }
  if (trustStatus) {
    where.push('trust_status = ?');
    params.push(trustStatus);
  }
  if (range) {
    where.push('ts >= ?');
    params.push(rangeStart(range));
  }
  params.push(limit);

  const rows = await query(
    `SELECT * FROM readings WHERE ${where.join(' AND ')}
     ORDER BY ts DESC, id DESC LIMIT ?`,
    params,
  );
  return rows.map((row) => ({
    ...mapReading(row, null),
    rawValue: row.raw_value === null ? null : Number(row.raw_value),
    lastTrusted: row.trust_status === 'trusted'
      ? { value: Number(row.value), ts: row.ts }
      : null,
  }));
}

export async function getLatestEcg(astronautId) {
  const row = await queryOne(
    `SELECT id, ts_start, sample_rate_hz, samples, artifact_ranges, confidence
     FROM ecg_segments WHERE astronaut_id = ?
     ORDER BY ts_start DESC LIMIT 1`,
    [astronautId],
  );
  if (!row) return null;

  let samples = row.samples;
  let artifacts = row.artifact_ranges;
  if (typeof samples === 'string') {
    try {
      samples = JSON.parse(samples);
    } catch {
      samples = [];
    }
  }
  if (typeof artifacts === 'string') {
    try {
      artifacts = JSON.parse(artifacts);
    } catch {
      artifacts = null;
    }
  }
  return {
    id: Number(row.id),
    tsStart: row.ts_start,
    sampleRateHz: Number(row.sample_rate_hz),
    samples,
    artifactRanges: artifacts ?? [],
    confidence: Number(row.confidence),
  };
}

export async function getLatestEnvironment() {
  const latestRows = await query(
    `SELECT * FROM (
       SELECT e.*, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY ts DESC, id DESC) AS rn
       FROM environment_readings e
     ) x WHERE rn = 1`,
  );
  const trustedRows = await query(
    `SELECT * FROM (
       SELECT e.*, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY ts DESC, id DESC) AS rn
       FROM environment_readings e WHERE trust_status = 'trusted'
     ) x WHERE rn = 1`,
  );
  const trustedByMetric = Object.fromEntries(trustedRows.map((r) => [r.metric, r]));
  const ranges = await getMetricRanges('environment');
  const order = ['o2', 'co2', 'pressure', 'temperature', 'humidity', 'air_quality'];

  return order.filter((m) => ranges[m]).map((metric) => {
    const row = latestRows.find((r) => r.metric === metric);
    if (!row) {
      return {
        metric,
        label: METRIC_LABELS[metric],
        value: null,
        unit: ranges[metric].unit,
        ts: null,
        confidence: null,
        trustStatus: null,
        trustReason: null,
        range: ranges[metric],
        lastTrusted: null,
      };
    }
    return {
      id: Number(row.id),
      metric,
      label: METRIC_LABELS[metric],
      value: Number(row.value),
      unit: row.unit,
      ts: row.ts,
      confidence: Number(row.confidence),
      trustStatus: row.trust_status,
      trustReason: row.trust_reason ?? null,
      range: ranges[metric],
      lastTrusted: row.trust_status === 'trusted'
        ? { value: Number(row.value), ts: row.ts }
        : mapTrusted(trustedByMetric[metric]),
    };
  });
}

export async function getEnvironmentSeries(metric, range) {
  const since = rangeStart(range);
  const rows = await query(
    `SELECT * FROM environment_readings
     WHERE metric = ? AND ts >= ? ORDER BY ts ASC, id ASC`,
    [metric, since],
  );
  if (!rows.length) return [];

  const previous = await queryOne(
    `SELECT value, ts FROM environment_readings
     WHERE metric = ? AND trust_status = 'trusted' AND ts < ?
     ORDER BY ts DESC, id DESC LIMIT 1`,
    [metric, since],
  );

  let carry = mapTrusted(previous);
  return rows.map((row) => {
    const item = {
      id: Number(row.id),
      metric: row.metric,
      value: Number(row.value),
      unit: row.unit,
      ts: row.ts,
      confidence: Number(row.confidence),
      trustStatus: row.trust_status,
      trustReason: row.trust_reason ?? null,
      source: row.source,
      lastTrusted: carry,
    };
    if (row.trust_status === 'trusted') {
      carry = { value: Number(row.value), ts: row.ts };
    }
    return item;
  });
}
