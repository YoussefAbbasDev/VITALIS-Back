/**
 * DEV TOOL ONLY - simulates external monitoring processes.
 *
 * Every 2 seconds it inserts new rows (health readings, environment, radiation)
 * so Socket.IO and the live UI can be tested. It deliberately does NOT create
 * alerts: every alert in the demo comes from scripts/seed.js, and this stream
 * protects the metric/astronaut pairs behind active alerts so the newest rows
 * can never contradict an alert that is currently on screen.
 *
 * The application itself never generates readings; this script stands in for
 * the external sensor pipeline and is not imported by the server.
 */
import { pool, query, queryOne } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

if (env.NODE_ENV === 'production') {
  console.error('Refusing to run seed-live.js with NODE_ENV=production.');
  process.exit(1);
}

const HEALTH_METRICS = [
  { metric: 'heart_rate', unit: 'bpm', mean: 68, sd: 6, device: 'cardio-patch-01', decimals: 0 },
  { metric: 'spo2', unit: '%', mean: 97.6, sd: 0.7, device: 'pulse-ox-02', decimals: 0 },
  { metric: 'bp_systolic', unit: 'mmHg', mean: 117, sd: 7, device: 'bp-cuff-01', decimals: 0 },
  { metric: 'bp_diastolic', unit: 'mmHg', mean: 75, sd: 5, device: 'bp-cuff-01', decimals: 0 },
  { metric: 'body_temp', unit: '°C', mean: 36.55, sd: 0.18, device: 'temp-core-01', decimals: 1 },
  { metric: 'resp_rate', unit: 'breaths/min', mean: 14.8, sd: 1.4, device: 'resp-band-01', decimals: 0 },
];

const ENV_METRICS = [
  { metric: 'o2', unit: '%', mean: 20.9, sd: 0.06, decimals: 2 },
  { metric: 'co2', unit: 'ppm', mean: 820, sd: 20, decimals: 0 },
  { metric: 'pressure', unit: 'kPa', mean: 101.3, sd: 0.12, decimals: 2 },
  { metric: 'temperature', unit: '°C', mean: 22.4, sd: 0.35, decimals: 1 },
  { metric: 'humidity', unit: '%', mean: 45, sd: 2.5, decimals: 1 },
  { metric: 'air_quality', unit: 'AQI', mean: 19, sd: 3, decimals: 0 },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const gaussian = () => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const round = (v, d) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

let astronauts = [];
let medicalId = null;
let tick = 0;
let envIndex = 0;
let hasFaultOfType = new Set();
// "astronautId:metric" pairs that an active alert depends on. The live stream
// never writes to these, so the newest trusted value keeps matching the alert.
let protectedMetrics = new Set();
let envRanges = {};

async function loadContext() {
  astronauts = await query(
    `SELECT u.id FROM users u WHERE u.role = 'astronaut' AND u.is_active = 1 ORDER BY u.id`,
  );
  medicalId = (await queryOne(`SELECT id FROM users WHERE role = 'medical' AND is_active = 1 LIMIT 1`))?.id ?? null;
  hasFaultOfType = new Set(
    (await query('SELECT DISTINCT fault_type FROM sensor_faults')).map((r) => r.fault_type),
  );

  protectedMetrics = new Set();
  const activeAlerts = await query(
    `SELECT astronaut_id, related_metrics FROM alerts WHERE resolved_at IS NULL`,
  );
  for (const alert of activeAlerts) {
    let metrics = alert.related_metrics;
    if (typeof metrics === 'string') {
      try {
        metrics = JSON.parse(metrics);
      } catch {
        metrics = [];
      }
    }
    for (const metric of metrics ?? []) {
      const key = alert.astronaut_id === null ? `cabin:${metric}` : `${alert.astronaut_id}:${metric}`;
      protectedMetrics.add(key);
    }
  }

  envRanges = Object.fromEntries(
    (await query(`SELECT metric, safe_min, safe_max FROM metric_ranges WHERE scope = 'environment'`))
      .map((row) => [row.metric, { min: Number(row.safe_min), max: Number(row.safe_max) }]),
  );

  console.log(
    `Loaded ${astronauts.length} astronauts, medical officer ${medicalId ?? 'none'}, ${protectedMetrics.size} protected metric pair(s).`,
  );
}

async function insertReading(astronautId) {
  const def = pick(HEALTH_METRICS);
  if (protectedMetrics.has(`${astronautId}:${def.metric}`)) return false;

  const baseline = await queryOne(
    'SELECT mean, std FROM baselines WHERE astronaut_id = ? AND metric = ?',
    [astronautId, def.metric],
  );
  const mean = baseline ? Number(baseline.mean) : def.mean;
  const sd = baseline ? Math.max(Number(baseline.std), 0.1) : def.sd;
  const suspect = Math.random() < 0.06;
  const value = round(mean + gaussian() * sd * (suspect ? 2.2 : 0.7), def.decimals);

  await pool.execute(
    `INSERT INTO readings
       (astronaut_id, metric, value, unit, ts, confidence, trust_status, trust_reason, raw_value, source_device)
     VALUES (?, ?, ?, ?, NOW(3), ?, ?, ?, ?, ?)`,
    [
      astronautId,
      def.metric,
      value,
      def.unit,
      suspect ? round(0.5 + Math.random() * 0.2, 2) : round(0.95 + Math.random() * 0.04, 2),
      suspect ? 'suspect' : 'trusted',
      suspect ? 'Live stream variance above threshold' : null,
      suspect ? value : null,
      `${def.device}-live`,
    ],
  );
  return true;
}

async function insertEnvironment() {
  const def = ENV_METRICS[envIndex % ENV_METRICS.length];
  envIndex += 1;
  if (protectedMetrics.has(`cabin:${def.metric}`)) return false;
  const range = envRanges[def.metric];
  const value = range
    ? clamp(def.mean + gaussian() * def.sd, range.min, range.max)
    : def.mean + gaussian() * def.sd;
  await pool.execute(
    `INSERT INTO environment_readings
       (metric, value, unit, ts, confidence, trust_status, trust_reason, source)
     VALUES (?, ?, ?, NOW(3), ?, 'trusted', NULL, 'cabin-env-live')`,
    [def.metric, round(value, def.decimals), def.unit, 0.97],
  );
  return true;
}

async function insertRadiation(astronautId) {
  if (protectedMetrics.has(`${astronautId}:radiation`)) return false;
  const last = await queryOne(
    `SELECT rate_usv_per_h, cumulative_msv, ts FROM radiation_readings
     WHERE astronaut_id = ? AND trust_status = 'trusted' ORDER BY ts DESC LIMIT 1`,
    [astronautId],
  );
  // Continue from the astronaut's own recent level instead of a fixed 55.
  const mean = last ? Number(last.rate_usv_per_h) : 55;
  const rate = round(clamp(mean + gaussian() * 5, 20, 130), 3);
  const elapsedHours = last ? Math.max(0.001, (Date.now() - new Date(last.ts).getTime()) / 3600000) : 1;
  const cumulative = last ? Number(last.cumulative_msv) + (rate / 1000) * Math.min(elapsedHours, 1) : 35;
  await pool.execute(
    `INSERT INTO radiation_readings
       (astronaut_id, rate_usv_per_h, cumulative_msv, ts, confidence, trust_status, trust_reason)
     VALUES (?, ?, ?, NOW(3), 0.97, 'trusted', NULL)`,
    [astronautId, rate, round(cumulative, 4)],
  );
  return true;
}

async function insertFault() {
  const types = ['noise', 'missing', 'drift', 'artifact', 'abnormal', 'conflict'];
  const unused = types.filter((t) => !hasFaultOfType.has(t));
  const type = unused.length ? unused[0] : pick(types);
  await pool.execute(
    `INSERT INTO sensor_faults (astronaut_id, device, metric, fault_type, details, detected_at)
     VALUES (?, 'live-sensor-01', 'heart_rate', ?, 'Simulated fault from the dev live stream.', NOW(3))`,
    [Math.random() < 0.7 ? pick(astronauts).id : null, type],
  );
  hasFaultOfType.add(type);
}

async function acknowledgeOneAlert() {
  if (!medicalId) return;
  const alert = await queryOne(
    `SELECT id FROM alerts
     WHERE acknowledged_at IS NULL AND resolved_at IS NULL AND astronaut_id IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  );
  if (!alert) return;
  await pool.execute(
    'UPDATE alerts SET acknowledged_by = ?, acknowledged_at = NOW(3) WHERE id = ?',
    [medicalId, alert.id],
  );
}

async function tickOnce() {
  tick += 1;
  const astronautA = pick(astronauts);
  const astronautB = pick(astronauts);

  const wroteA = await insertReading(astronautA.id);
  const wroteB = await insertReading(astronautB.id);
  const wroteEnv = await insertEnvironment();
  const wroteRadiation = await insertRadiation(pick(astronauts).id);

  if (tick % 15 === 0) await insertFault();
  if (tick % 11 === 0) await acknowledgeOneAlert();

  const wrote = [
    wroteA || wroteB ? 'readings' : null,
    wroteEnv ? 'env' : null,
    wroteRadiation ? 'radiation' : null,
  ].filter(Boolean);
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] tick ${tick}: ${wrote.length ? wrote.join(', ') : 'protected metrics only'}${tick % 11 === 0 ? ', ack' : ''}`);
}

async function main() {
  await loadContext();
  console.log('Live dev stream running. Press Ctrl+C to stop.');
  await tickOnce();
  const timer = setInterval(() => {
    tickOnce().catch((err) => console.error('live tick failed:', err.message));
  }, 2000);

  const stop = async () => {
    clearInterval(timer);
    console.log('\nStopping live stream...');
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(async (err) => {
  console.error('seed-live failed:', err);
  await pool.end();
  process.exit(1);
});
