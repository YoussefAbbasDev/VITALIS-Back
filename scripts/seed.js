/**
 * DEV TOOL ONLY - not part of the application runtime.
 *
 * Creates a clean, schema-valid VITALIS demo dataset:
 *   - 1 admin, 1 medical officer, 6 astronauts
 *   - a single 180-day mission, 14 days of monitoring history
 *     (5-minute cadence, 1-minute cadence for the last 24 hours)
 *   - trust anomalies, sensor faults, alerts of every category
 *   - 14 days of sleep, check-ins and exercises
 *
 * WARNING: this TRUNCATES all VITALIS tables before seeding.
 * It refuses to run when NODE_ENV=production.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { env, SERVER_ROOT } from '../src/config/env.js';

const DEV_PASSWORD = 'Vitalis!2026';
const DAY_MS = 24 * 60 * 60 * 1000;

if (env.NODE_ENV === 'production') {
  console.error('Refusing to run seed.js with NODE_ENV=production.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Deterministic-ish helpers
// ---------------------------------------------------------------------------
function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round = (v, decimals = 0) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return dateKey(d);
}

/** Insert rows in chunks using a single multi-row statement per chunk. */
async function insertRows(conn, prefix, columns, rows, chunkSize = 700) {
  if (!rows.length) return;
  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const sql = `${prefix} VALUES ${chunk.map(() => placeholders).join(', ')}`;
    const params = chunk.flat();
    await conn.query(sql, params);
  }
}

// ---------------------------------------------------------------------------
// Domain definitions
// ---------------------------------------------------------------------------
const HEALTH_METRICS = [
  { metric: 'heart_rate', unit: 'bpm', mean: 68, sd: 6, safe: [50, 100], critical: [40, 130], decimals: 0, amp: 5 },
  { metric: 'spo2', unit: '%', mean: 97.6, sd: 0.7, safe: [95, 100], critical: [88, 100], decimals: 0, amp: 0.3 },
  { metric: 'bp_systolic', unit: 'mmHg', mean: 117, sd: 7, safe: [90, 130], critical: [80, 160], decimals: 0, amp: 3 },
  { metric: 'bp_diastolic', unit: 'mmHg', mean: 75, sd: 5, safe: [60, 85], critical: [50, 100], decimals: 0, amp: 2 },
  { metric: 'body_temp', unit: '°C', mean: 36.55, sd: 0.18, safe: [36.1, 37.5], critical: [35.5, 38.5], decimals: 1, amp: 0.12 },
  { metric: 'resp_rate', unit: 'breaths/min', mean: 14.8, sd: 1.4, safe: [10, 20], critical: [8, 24], decimals: 0, amp: 1 },
];

const ENV_METRICS = [
  { metric: 'o2', unit: '%', mean: 20.9, sd: 0.06, safe: [19.5, 23.5], critical: [16, 25], decimals: 2 },
  { metric: 'co2', unit: 'ppm', mean: 760, sd: 25, safe: [400, 1000], critical: [400, 5000], decimals: 0 },
  { metric: 'pressure', unit: 'kPa', mean: 101.3, sd: 0.12, safe: [95, 103], critical: [85, 110], decimals: 2 },
  { metric: 'temperature', unit: '°C', mean: 22.4, sd: 0.35, safe: [18, 27], critical: [10, 35], decimals: 1 },
  { metric: 'humidity', unit: '%', mean: 45, sd: 2.5, safe: [30, 70], critical: [10, 90], decimals: 1 },
  { metric: 'air_quality', unit: 'AQI', mean: 19, sd: 4, safe: [0, 50], critical: [0, 150], decimals: 0 },
];

const DEVICE_BY_METRIC = {
  heart_rate: 'cardio-patch-01',
  spo2: 'pulse-ox-02',
  bp_systolic: 'bp-cuff-01',
  bp_diastolic: 'bp-cuff-01',
  body_temp: 'temp-core-01',
  resp_rate: 'resp-band-01',
};

const TRUST_REASONS = [
  'Signal noise above threshold',
  'Motion artifact detected',
  'Conflicts with redundant sensor',
  'Drift against personal baseline',
  'Inconsistent with heart rate and respiration',
  'Dropout recovered from buffer',
];

const PEOPLE = {
  admin: { name: 'Cmdr. Elena Vasquez', email: 'admin@vitalis.dev' },
  medical: { name: 'Dr. Marcus Chen', email: 'medical@vitalis.dev' },
  astronauts: [
    { name: 'Aiko Tanaka', email: 'astronaut1@vitalis.dev' },
    { name: 'Jonas Weber', email: 'astronaut2@vitalis.dev' },
    { name: 'Priya Raghavan', email: 'astronaut3@vitalis.dev' },
    { name: 'Diego Alvarez', email: 'astronaut4@vitalis.dev' },
    { name: 'Amara Okafor', email: 'astronaut5@vitalis.dev' },
    { name: 'Liam O’Connor', email: 'astronaut6@vitalis.dev' },
  ],
};

// Small personal offsets so baselines are not identical.
const SHIFTS = [
  { hr: -5, spo2: 0.5, sys: -4, dia: -2, temp: -0.05, rr: -0.6, rad: 0.9 },
  { hr: 7, spo2: -0.5, sys: 6, dia: 3, temp: 0.12, rr: 1.1, rad: 1.1 },
  { hr: 0, spo2: 0.2, sys: 0, dia: 0, temp: 0, rr: 0, rad: 1.0 },
  { hr: 9, spo2: -0.2, sys: 8, dia: 4, temp: 0.08, rr: 0.8, rad: 1.05 },
  { hr: -3, spo2: 0.3, sys: -3, dia: -1, temp: -0.02, rr: -0.4, rad: 0.95 },
  { hr: 4, spo2: -0.7, sys: 3, dia: 2, temp: 0.04, rr: 0.5, rad: 1.15 },
];

// Every astronaut follows one explicit story so the seeded alerts can be
// derived from the seeded rows instead of being independent hard-coded text.
//   spo2-decline   : Aiko has a real, trusted SpO2 decline corroborated by HR
//                    and respiration, plus a related pulse-oximeter fault.
//   normal         : Jonas is the fully normal control (zero active alerts).
//   radiation      : Priya has a real dose-rate elevation above her 7-day mean.
//   recovered-heat : Diego had a temperature excursion that has since recovered.
const SCENARIOS = ['spo2-decline', 'normal', 'radiation', 'recovered-heat', 'normal', 'normal'];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startedAt = Date.now();
  console.log(`Seeding VITALIS database "${env.DB_NAME}" (${env.DB_HOST}:${env.DB_PORT})...`);

  const admin = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    multipleStatements: true,
  });
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await admin.end();

  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    multipleStatements: true,
    timezone: 'Z',
    dateStrings: ['DATE'],
  });

  try {
    await conn.query("SET time_zone = '+00:00'");
    const schemaSql = await fs.readFile(path.join(SERVER_ROOT, 'db', 'schema.sql'), 'utf8');
    await conn.query(schemaSql);

    const tables = [
      'assistant_messages', 'medical_notes', 'exercise_logs', 'checkins', 'alerts',
      'sensor_faults', 'baselines', 'metric_ranges', 'sleep_records',
      'radiation_readings', 'environment_readings', 'ecg_segments', 'readings',
      'readiness', 'assignments', 'invites', 'missions', 'users',
    ];
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of tables) {
      await conn.query(`TRUNCATE TABLE \`${table}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    // -----------------------------------------------------------------------
    // People
    // -----------------------------------------------------------------------
    const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);

    const [adminResult] = await conn.query(
      `INSERT INTO users (name, email, password_hash, role, is_active) VALUES (?, ?, ?, 'admin', 1)`,
      [PEOPLE.admin.name, PEOPLE.admin.email, passwordHash],
    );
    const adminId = Number(adminResult.insertId);

    const [medicalResult] = await conn.query(
      `INSERT INTO users (name, email, password_hash, role, is_active) VALUES (?, ?, ?, 'medical', 1)`,
      [PEOPLE.medical.name, PEOPLE.medical.email, passwordHash],
    );
    const medicalId = Number(medicalResult.insertId);

    const astronautIds = [];
    for (const person of PEOPLE.astronauts) {
      const [result] = await conn.query(
        `INSERT INTO users (name, email, password_hash, role, is_active) VALUES (?, ?, ?, 'astronaut', 1)`,
        [person.name, person.email, passwordHash],
      );
      astronautIds.push(Number(result.insertId));
    }

    // All six astronauts are assigned to the single medical officer.
    for (const astronautId of astronautIds) {
      await conn.query(
        'INSERT INTO assignments (astronaut_id, medical_officer_id) VALUES (?, ?)',
        [astronautId, medicalId],
      );
    }

    const readinessByIndex = ['limited', 'fit', 'fit', 'limited', 'fit', 'unfit'];
    for (let i = 0; i < astronautIds.length; i += 1) {
      await conn.query(
        'INSERT INTO readiness (astronaut_id, status, updated_by, updated_at) VALUES (?, ?, ?, ?)',
        [astronautIds[i], readinessByIndex[i], medicalId, minutesAgo(60 * (i + 2))],
      );
    }

    // -----------------------------------------------------------------------
    // Mission + reference ranges
    // -----------------------------------------------------------------------
    const missionStart = new Date(Date.now() - 35 * DAY_MS);
    missionStart.setUTCHours(0, 0, 0, 0);
    const missionEnd = new Date(missionStart.getTime() + 179 * DAY_MS);
    await conn.query(
      `INSERT INTO missions (name, start_date, end_date, radiation_limit_msv, exercise_target_min_per_day)
       VALUES (?, ?, ?, ?, ?)`,
      ['Ares Horizon I', dateKey(missionStart), dateKey(missionEnd), 600, 30],
    );

    const rangeRows = [
      ...HEALTH_METRICS.map((m) => [m.metric, 'health', m.safe[0], m.safe[1], m.critical[0], m.critical[1], m.unit]),
      ...ENV_METRICS.map((m) => [m.metric, 'environment', m.safe[0], m.safe[1], m.critical[0], m.critical[1], m.unit]),
    ];
    await insertRows(
      conn,
      'INSERT INTO metric_ranges (metric, scope, safe_min, safe_max, critical_min, critical_max, unit)',
      ['metric', 'scope', 'safe_min', 'safe_max', 'critical_min', 'critical_max', 'unit'],
      rangeRows,
    );

    // -----------------------------------------------------------------------
    // Time grid: 5-minute cadence, 1-minute for the last 24h
    // -----------------------------------------------------------------------
    const nowMinute = new Date(Math.floor(Date.now() / 60000) * 60000);
    const fourteenDaysAgo = nowMinute.getTime() - 14 * DAY_MS;
    const last24h = nowMinute.getTime() - DAY_MS;

    /** @returns {Date[]} */
    function buildTimestamps() {
      const out = [];
      const cursor = new Date(fourteenDaysAgo);
      while (cursor.getTime() <= nowMinute.getTime()) {
        out.push(new Date(cursor));
        const stepMs = cursor.getTime() < last24h ? 5 * 60000 : 60000;
        cursor.setTime(cursor.getTime() + stepMs);
      }
      return out;
    }
    const timestamps = buildTimestamps();

    // -----------------------------------------------------------------------
    // Health readings
    // -----------------------------------------------------------------------
    const specialRows = [];

    for (let a = 0; a < astronautIds.length; a += 1) {
      const astronautId = astronautIds[a];
      const shift = SHIFTS[a];
      const scenario = SCENARIOS[a];
      await conn.beginTransaction();

      for (const def of HEALTH_METRICS) {
        const personalMean =
          def.metric === 'heart_rate' ? def.mean + shift.hr
            : def.metric === 'spo2' ? def.mean + shift.spo2
              : def.metric === 'bp_systolic' ? def.mean + shift.sys
                : def.metric === 'bp_diastolic' ? def.mean + shift.dia
                  : def.metric === 'body_temp' ? def.mean + shift.temp
                    : def.mean + shift.rr;

        const device = `${DEVICE_BY_METRIC[def.metric]}-a${a + 1}`;
        const rows = [];
        let drift = 0;

        for (const ts of timestamps) {
          const hour = ts.getUTCHours() + ts.getUTCMinutes() / 60;
          const minutesFromNow = (nowMinute.getTime() - ts.getTime()) / 60000;
          // Circadian component: lower at night, slightly higher in the morning.
          const circadian = Math.sin(((hour - 6) / 24) * 2 * Math.PI) * def.amp;
          drift = clamp(drift + gaussian() * def.sd * 0.035, -2.2 * def.sd, 2.2 * def.sd);

          let value = personalMean + circadian + gaussian() * def.sd * 0.45 + drift;
          let trust = 'trusted';
          let confidence = round(clamp(0.94 + Math.random() * 0.05, 0, 1), 2);
          let reason = null;
          let rawValue = null;

          // Random trust anomalies live in the older history only. The recent
          // 24 h is deterministic so "all normal" astronauts really are normal
          // and the SpO2 story is the only recent clinical event.
          const allowRandomAnomaly = minutesFromNow > 24 * 60;
          const roll = allowRandomAnomaly ? Math.random() : 1;
          if (roll < 0.0022) {
            // Excluded: a clear outlier that the trust layer rejected.
            const direction = Math.random() < 0.5 ? -1 : 1;
            value = personalMean + direction * def.sd * (6 + Math.random() * 4);
            rawValue = value;
            trust = 'excluded';
            confidence = round(0.16 + Math.random() * 0.2, 2);
            reason = TRUST_REASONS[Math.floor(Math.random() * TRUST_REASONS.length)];
          } else if (roll < 0.013) {
            // Suspect: plausible but low-confidence, kept for review.
            value = personalMean + (Math.random() < 0.5 ? -1 : 1) * def.sd * (1.8 + Math.random() * 1.4);
            rawValue = round(value + gaussian() * def.sd, def.decimals);
            trust = 'suspect';
            confidence = round(0.45 + Math.random() * 0.24, 2);
            reason = TRUST_REASONS[Math.floor(Math.random() * TRUST_REASONS.length)];
          }

          // Aiko's coherent story: a genuine, trusted SpO2 decline over the
          // last 30 minutes, corroborated by rising heart rate and respiration.
          let inStory = false;
          if (scenario === 'spo2-decline' && minutesFromNow <= 30) {
            const progress = 1 - minutesFromNow / 30;
            if (def.metric === 'spo2') {
              value = 96.4 - progress * 5.2 + gaussian() * 0.15;
              inStory = true;
            } else if (def.metric === 'heart_rate') {
              value = 94 + progress * 8 + gaussian() * 1.2;
              inStory = true;
            } else if (def.metric === 'resp_rate') {
              value = 19 + progress * 2.8 + gaussian() * 0.5;
              inStory = true;
            }
            if (inStory) {
              trust = 'trusted';
              confidence = round(clamp(0.94 + Math.random() * 0.04, 0, 1), 2);
              reason = null;
              rawValue = null;
            }
          }

          if (def.metric === 'spo2') value = clamp(value, 60, 100);
          if (def.metric === 'heart_rate') value = clamp(value, 30, 210);
          if (def.metric === 'resp_rate') value = clamp(value, 4, 45);
          if (def.metric === 'body_temp') value = clamp(value, 34, 42);
          if (def.metric === 'bp_systolic') value = clamp(value, 70, 200);
          if (def.metric === 'bp_diastolic') value = clamp(value, 40, 130);

          // Normal trusted readings stay strictly inside the configured safe
          // band (SpO2 is capped at 99 because 100 is the critical boundary).
          if (trust === 'trusted' && !inStory) {
            value = clamp(value, def.safe[0], def.metric === 'spo2' ? 99 : def.safe[1]);
          }

          rows.push([
            astronautId,
            def.metric,
            round(value, def.decimals),
            def.unit,
            ts,
            confidence,
            trust,
            reason,
            rawValue === null ? null : round(rawValue, def.decimals),
            device,
          ]);
        }

        await insertRows(
          conn,
          `INSERT INTO readings
             (astronaut_id, metric, value, unit, ts, confidence, trust_status, trust_reason, raw_value, source_device)`,
          ['astronaut_id', 'metric', 'value', 'unit', 'ts', 'confidence', 'trust_status', 'trust_reason', 'raw_value', 'source_device'],
          rows,
        );
      }

      await conn.commit();
      console.log(`  health readings: astronaut ${a + 1}/${astronautIds.length}`);
    }

    // Explicit trust anomalies that support the recent stories. Their
    // timestamps are offset by a few seconds so they sit beside the minute grid
    // without replacing the latest trusted reading.
    const aiko = astronautIds[0];
    specialRows.push(
      [aiko, 'spo2', 88.5, '%', minutesAgo(41), 0.61, 'suspect',
        'Pulse-oximeter signal inconsistent with heart rate and respiration', 89.2, 'pulse-ox-02-b'],
      [aiko, 'spo2', 84, '%', minutesAgo(55), 0.28, 'excluded',
        'Pulse-oximeter signal lost; sample rejected by the trust layer', 84, 'pulse-ox-02-c'],
    );
    // Diego's recovered temperature excursion (latest reading is normal again).
    [38.2, 38.4, 38.4, 38.3, 38.1, 37.9].forEach((temp, index) => {
      specialRows.push([
        astronautIds[3], 'body_temp', temp, '°C', minutesAgo(235 - index * 2), 0.96, 'trusted',
        null, null, 'temp-core-01-a4',
      ]);
    });
    const specialFixed = specialRows.map((r) => {
      // Add seconds to avoid clashing with the minute-aligned grid.
      const ts = new Date(r[4].getTime() + 17 * 1000);
      return [...r.slice(0, 4), ts, ...r.slice(5)];
    });
    await insertRows(
      conn,
      `INSERT INTO readings
         (astronaut_id, metric, value, unit, ts, confidence, trust_status, trust_reason, raw_value, source_device)`,
      ['astronaut_id', 'metric', 'value', 'unit', 'ts', 'confidence', 'trust_status', 'trust_reason', 'raw_value', 'source_device'],
      specialFixed,
      100,
    );

    // -----------------------------------------------------------------------
    // ECG segments (last 2 hours, 2-second synthetic strips at 250 Hz)
    // -----------------------------------------------------------------------
    const ecgRows = [];
    for (let a = 0; a < astronautIds.length; a += 1) {
      for (let s = 23; s >= 0; s -= 1) {
        const sampleRate = 250;
        const samples = [];
        const beatsPerSecond = 1.05;
        for (let n = 0; n < 500; n += 1) {
          const t = n / sampleRate;
          const phase = (t * beatsPerSecond) % 1;
          let mv = 0;
          if (phase > 0.08 && phase < 0.18) mv += 0.12 * Math.sin(((phase - 0.08) / 0.1) * Math.PI);
          if (phase > 0.27 && phase < 0.31) mv -= 0.16 * Math.sin(((phase - 0.27) / 0.04) * Math.PI);
          if (phase >= 0.31 && phase < 0.36) mv += 0.95 * Math.sin(((phase - 0.31) / 0.05) * Math.PI);
          if (phase > 0.44 && phase < 0.6) mv += 0.25 * Math.sin(((phase - 0.44) / 0.16) * Math.PI);
          samples.push(round(mv + gaussian() * 0.012, 3));
        }
        const artifact = a === 0 && s === 2 ? [{ start: 0.65, end: 0.95 }] : null;
        ecgRows.push([
          astronautIds[a],
          minutesAgo(s * 5 + 1),
          sampleRate,
          JSON.stringify(samples),
          artifact ? JSON.stringify(artifact) : null,
          artifact ? 0.62 : round(0.93 + Math.random() * 0.05, 2),
        ]);
      }
    }
    await insertRows(
      conn,
      'INSERT INTO ecg_segments (astronaut_id, ts_start, sample_rate_hz, samples, artifact_ranges, confidence)',
      ['astronaut_id', 'ts_start', 'sample_rate_hz', 'samples', 'artifact_ranges', 'confidence'],
      ecgRows,
      100,
    );

    // -----------------------------------------------------------------------
    // Environment (5-minute cadence, 14 days)
    // -----------------------------------------------------------------------
    const envTimestamps = [];
    for (let t = fourteenDaysAgo; t <= nowMinute.getTime(); t += 5 * 60000) {
      envTimestamps.push(new Date(t));
    }
    const envRows = [];
    for (const def of ENV_METRICS) {
      let drift = 0;
      for (const ts of envTimestamps) {
        const progress = (ts.getTime() - fourteenDaysAgo) / (nowMinute.getTime() - fourteenDaysAgo);
        const minutesFromNow = (nowMinute.getTime() - ts.getTime()) / 60000;
        let level = def.mean;
        if (def.metric === 'co2') {
          level = 690 + progress * 150; // slow rise over the window
          // A 3-hour CO2 excursion 6-9 hours ago that has since recovered.
          if (minutesFromNow <= 9 * 60 && minutesFromNow >= 6 * 60) {
            const frac = (9 * 60 - minutesFromNow) / (3 * 60);
            level += 340 * Math.sin(Math.PI * frac);
          }
        }
        if (def.metric === 'air_quality' && minutesFromNow <= 5 * 60 && minutesFromNow >= 4 * 60) {
          // A one-hour air-quality spike 4-5 hours ago, now recovered.
          const frac = (5 * 60 - minutesFromNow) / (1 * 60);
          level += 76 * Math.sin(Math.PI * frac);
        }
        if (def.metric === 'temperature') level += Math.sin(progress * Math.PI * 8) * 0.5;
        if (def.metric === 'humidity') level += Math.sin(progress * Math.PI * 6) * 3;
        drift = clamp(drift + gaussian() * def.sd * 0.08, -1.5 * def.sd, 1.5 * def.sd);
        let value = level + drift + gaussian() * def.sd * 0.6;
        // Historic values stay inside the configured band; the recent window
        // carries the crafted CO2/AQI excursions and then recovers.
        if (minutesFromNow > 12 * 60) value = clamp(value, def.safe[0], def.safe[1]);

        let trust = 'trusted';
        let confidence = round(clamp(0.95 + Math.random() * 0.04, 0, 1), 2);
        let reason = null;
        // Keep the recent environment deterministic and inside the safe band,
        // so the active cabin cards always agree with the (resolved) history.
        const roll = minutesFromNow > 12 * 60 ? Math.random() : 1;
        if (roll < 0.004) {
          trust = 'suspect';
          confidence = round(0.5 + Math.random() * 0.2, 2);
          reason = 'Sensor conflict between redundant environment nodes';
        } else if (roll < 0.006) {
          trust = 'excluded';
          confidence = round(0.2 + Math.random() * 0.15, 2);
          reason = 'Reading outside physical plausibility bounds';
        }
        envRows.push([def.metric, round(value, def.decimals), def.unit, ts, confidence, trust, reason, 'cabin-env-01']);
      }
    }

    await insertRows(
      conn,
      `INSERT INTO environment_readings
         (metric, value, unit, ts, confidence, trust_status, trust_reason, source)`,
      ['metric', 'value', 'unit', 'ts', 'confidence', 'trust_status', 'trust_reason', 'source'],
      envRows,
    );

    // -----------------------------------------------------------------------
    // Radiation (30-minute cadence, 14 days)
    // -----------------------------------------------------------------------
    const radRows = [];
    for (let a = 0; a < astronautIds.length; a += 1) {
      const multiplier = SHIFTS[a].rad;
      // Start from an estimate of the 21 days before the recorded window.
      let cumulative = (55 * multiplier * 24 * 21) / 1000;
      for (let t = fourteenDaysAgo; t <= nowMinute.getTime(); t += 30 * 60000) {
        const ts = new Date(t);
        const minutesFromNow = (nowMinute.getTime() - t) / 60000;
        // Priya's radiation story: a real 6-hour dose-rate elevation that is
        // still present, so an active radiation alert is supported by data.
        const rate = SCENARIOS[a] === 'radiation' && minutesFromNow <= 6 * 60
          ? clamp(96 + Math.sin(t / (DAY_MS / 2)) * 2 + gaussian() * 3, 82, 112)
          : clamp((55 + Math.sin(t / (DAY_MS / 2)) * 9 + gaussian() * 4) * multiplier, 12, 140);
        cumulative += (rate / 1000) * 0.5;
        radRows.push([astronautIds[a], round(rate, 3), round(cumulative, 4), ts, 0.96, 'trusted', null]);
      }
    }
    await insertRows(
      conn,
      `INSERT INTO radiation_readings
         (astronaut_id, rate_usv_per_h, cumulative_msv, ts, confidence, trust_status, trust_reason)`,
      ['astronaut_id', 'rate_usv_per_h', 'cumulative_msv', 'ts', 'confidence', 'trust_status', 'trust_reason'],
      radRows,
    );

    // -----------------------------------------------------------------------
    // Sleep, check-ins, exercise
    // -----------------------------------------------------------------------
    const sleepRows = [];
    const checkinRows = [];
    const exerciseRows = [];

    const checkinProfiles = [
      { stress: [2, 3], mood: [4, 5], focus: [3, 5], fatigue: [2, 3], ex: [30, 45] },
      { stress: [3, 5], mood: [2, 3], focus: [2, 3], fatigue: [4, 5], ex: [8, 18] },
      { stress: [1, 2], mood: [4, 5], focus: [4, 5], fatigue: [1, 2], ex: [30, 42] },
      { stress: [2, 4], mood: [3, 4], focus: [3, 4], fatigue: [3, 4], ex: [20, 32] },
      { stress: [2, 3], mood: [3, 4], focus: [3, 4], fatigue: [3, 4], ex: [28, 40] },
      { stress: [2, 4], mood: [3, 4], focus: [2, 4], fatigue: [2, 4], ex: [12, 28] },
    ];
    const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    for (let a = 0; a < astronautIds.length; a += 1) {
      const profile = checkinProfiles[a];
      for (let d = 13; d >= 0; d -= 1) {
        const date = dateDaysAgo(d);

        // Sleep
        let duration = randInt(380, 465);
        let quality = clamp(Math.round(55 + (duration - 380) * 0.22 + randInt(-6, 6)), 20, 98);
        if ((a === 0 && d === 3) || (a === 1 && d <= 6)) {
          duration = randInt(290, 350);
          quality = randInt(38, 55);
        }
        sleepRows.push([astronautIds[a], date, duration, quality]);

        // Check-in (skip two older days at random for a little noise)
        if (d > 7 && Math.random() < 0.14) continue;
        const pick = (pair) => randInt(pair[0], pair[1]);
        let stress = pick(profile.stress);
        let mood = pick(profile.mood);
        let focus = pick(profile.focus);
        let fatigue = pick(profile.fatigue);
        // Recent rough patch for Jonas and a recent dip for Amara.
        if (a === 1 && d <= 3) {
          stress = Math.min(5, stress + 1);
          mood = Math.max(1, mood - 1);
          fatigue = Math.min(5, fatigue + 1);
        }
        if (a === 4 && d >= 2 && d <= 4) focus = Math.max(1, focus - 1);

        const notes = a === 0 && d === 1
          ? 'SpO2 dip noticed during exercise; felt fine afterwards.'
          : a === 1 && d === 0
            ? 'Slept poorly, long shift in the airlock.'
            : null;

        const [checkinResult] = await conn.query(
          `INSERT INTO checkins (astronaut_id, date, stress, mood, focus, fatigue, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [astronautIds[a], date, stress, mood, focus, fatigue, notes],
        );
        const checkinId = Number(checkinResult.insertId);

        // Exercises: adherence is deliberately uneven.
        let totalExercises = 1;
        if (a === 1 && d <= 6) totalExercises = Math.random() < 0.35 ? 1 : 0;
        else if (Math.random() < 0.22) totalExercises = 2;

        for (let e = 0; e < totalExercises; e += 1) {
          const type = ['cardio', 'resistance', 'balance', 'other'][randInt(0, 3)];
          const durationMin = randInt(profile.ex[0], profile.ex[1]);
          const intensity = randInt(2, 4);
          exerciseRows.push([checkinId, type, durationMin, intensity]);
        }
      }
    }

    await insertRows(
      conn,
      'INSERT INTO sleep_records (astronaut_id, date, duration_min, quality_score)',
      ['astronaut_id', 'date', 'duration_min', 'quality_score'],
      sleepRows,
    );
    await insertRows(
      conn,
      'INSERT INTO exercise_logs (checkin_id, type, duration_min, intensity)',
      ['checkin_id', 'type', 'duration_min', 'intensity'],
      exerciseRows,
    );

    // -----------------------------------------------------------------------
    // Sensor faults (one of every fault type)
    // -----------------------------------------------------------------------
    const faultRows = [
      [aiko, 'pulse-ox-02-b', 'spo2', 'noise', 'Signal-to-noise ratio below 12 dB; two SpO2 samples were rejected by the trust layer.', minutesAgo(41)],
      [astronautIds[1], 'resp-band-01-a2', 'resp_rate', 'missing', 'No packets for 6 minutes; last value held and marked stale.', minutesAgo(300)],
      [astronautIds[3], 'ecg-lead-01-a4', 'heart_rate', 'artifact', 'Motion artifact on lead II during exercise.', minutesAgo(65)],
      [astronautIds[5], 'bp-cuff-01-a6', 'bp_systolic', 'conflict', 'Cuff reading conflicts with the arterial line by 18 mmHg.', minutesAgo(140)],
      [null, 'cabin-env-02', 'co2', 'conflict', 'Redundant CO2 nodes disagreed during the recovered CO2 excursion.', minutesAgo(7 * 60 + 30)],
      [null, 'cabin-env-03', 'air_quality', 'missing', 'Air-quality node missed two scheduled samples during the recovered AQI spike.', minutesAgo(4 * 60 + 30)],
    ];
    await insertRows(
      conn,
      'INSERT INTO sensor_faults (astronaut_id, device, metric, fault_type, details, detected_at)',
      ['astronaut_id', 'device', 'metric', 'fault_type', 'details', 'detected_at'],
      faultRows,
    );

    // -----------------------------------------------------------------------
    // Alerts, derived from the rows that were just written.
    // -----------------------------------------------------------------------
    const getOne = async (sql, params) => {
      const [rows] = await conn.query(sql, params);
      return rows[0] ?? null;
    };
    const metricDefs = Object.fromEntries(
      [...HEALTH_METRICS, ...ENV_METRICS].map((def) => [def.metric, def]),
    );
    const severityFor = (metric, value) => {
      const def = metricDefs[metric];
      if (!def) return 'warning';
      if (value <= def.critical[0] || value >= def.critical[1]) return 'critical';
      if (value < def.safe[0] || value > def.safe[1]) return 'warning';
      return 'normal';
    };
    const latestTrustedReading = (astronautId, metric) => getOne(
      `SELECT value, unit, ts FROM readings
       WHERE astronaut_id = ? AND metric = ? AND trust_status = 'trusted'
       ORDER BY ts DESC, id DESC LIMIT 1`,
      [astronautId, metric],
    );
    const latestTrustedEnvironment = (metric) => getOne(
      `SELECT value, unit, ts FROM environment_readings
       WHERE metric = ? AND trust_status = 'trusted'
       ORDER BY ts DESC, id DESC LIMIT 1`,
      [metric],
    );
    const radiationStats = async (astronautId) => {
      const latest = await getOne(
        `SELECT rate_usv_per_h, cumulative_msv, ts FROM radiation_readings
         WHERE astronaut_id = ? AND trust_status = 'trusted'
         ORDER BY ts DESC, id DESC LIMIT 1`,
        [astronautId],
      );
      if (!latest) return null;
      const first = await getOne(
        `SELECT cumulative_msv, ts FROM radiation_readings
         WHERE astronaut_id = ? AND trust_status = 'trusted' AND ts >= ?
         ORDER BY ts ASC, id ASC LIMIT 1`,
        [astronautId, new Date(nowMinute.getTime() - 7 * DAY_MS)],
      );
      let averageDailyDoseLast7d;
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
        rate: Number(latest.rate_usv_per_h),
        ts: latest.ts,
        averageDailyDoseLast7d,
        averageRate,
        percentAboveAverage: averageRate > 0
          ? ((Number(latest.rate_usv_per_h) - averageRate) / averageRate) * 100
          : 0,
      };
    };
    const oneDecimal = (value) => (Math.round(Number(value) * 10) / 10).toFixed(1);
    const whole = (value) => String(Math.round(Number(value)));

    const alertRows = [];

    // --- Aiko: real SpO2 decline corroborated by HR + respiration ----------
    const spo2Latest = await latestTrustedReading(aiko, 'spo2');
    const spo2First = await getOne(
      `SELECT value, ts FROM readings
       WHERE astronaut_id = ? AND metric = 'spo2' AND trust_status = 'trusted' AND ts >= ?
       ORDER BY ts ASC LIMIT 1`,
      [aiko, minutesAgo(31)],
    );
    const hrLatest = await latestTrustedReading(aiko, 'heart_rate');
    const respLatest = await latestTrustedReading(aiko, 'resp_rate');
    const spo2Minutes = Math.max(
      1,
      Math.round((new Date(spo2Latest.ts).getTime() - new Date(spo2First.ts).getTime()) / 60000),
    );
    const lowConfidenceSpo2 = await getOne(
      `SELECT COUNT(*) AS count, MIN(value) AS min_value, MAX(value) AS max_value, MIN(ts) AS first_ts
       FROM readings
       WHERE astronaut_id = ? AND metric = 'spo2' AND trust_status <> 'trusted' AND ts >= ?`,
      [aiko, minutesAgo(60)],
    );

    alertRows.push({
      astronautId: aiko,
      category: 'health',
      severity: severityFor('spo2', Number(spo2Latest.value)),
      title: 'SpO2 trending below the safe range',
      description: `SpO2 fell from ${whole(spo2First.value)}% to ${whole(spo2Latest.value)}% over the last ${spo2Minutes} minutes and is now below the 95% safe floor. The trusted trend is corroborated by a heart rate of ${whole(hrLatest.value)} bpm and respiration of ${whole(respLatest.value)}/min.`,
      causes: ['Pulse-oximeter placement issue', 'Reduced oxygen saturation', 'Motion artifact on the sensor'],
      recommendation: 'Repeat the measurement at rest on the opposite hand. If SpO2 stays below 93%, start supplemental oxygen and notify the medical officer.',
      confidence: 0.84,
      basis: 'Confirmed by 3 sensors',
      sensors: 3,
      metrics: ['spo2', 'heart_rate', 'resp_rate'],
      createdAt: new Date(spo2First.ts),
    });

    if (lowConfidenceSpo2 && Number(lowConfidenceSpo2.count) > 0) {
      alertRows.push({
        astronautId: aiko,
        category: 'device',
        severity: 'warning',
        title: 'Pulse oximeter signal unstable',
        description: `The pulse oximeter produced ${lowConfidenceSpo2.count} low-confidence SpO2 samples in the last hour (${oneDecimal(lowConfidenceSpo2.min_value)}%–${oneDecimal(lowConfidenceSpo2.max_value)}%), which the trust layer removed from the clinical trend. The latest trusted SpO2 is ${whole(spo2Latest.value)}%.`,
        causes: ['Sensor placement', 'Motion artifact', 'Low perfusion'],
        recommendation: 'Reposition the sensor on the opposite hand and take a resting reading.',
        confidence: 0.62,
        basis: 'Unconfirmed: single sensor',
        sensors: 1,
        metrics: ['spo2'],
        createdAt: new Date(lowConfidenceSpo2.first_ts),
        acknowledgedBy: medicalId,
        acknowledgedAt: minutesAgo(20),
      });
    }

    // --- Priya: real dose rate above the 7-day average ---------------------
    const priyaRadiation = await radiationStats(astronautIds[2]);
    if (priyaRadiation) {
      const radiationStart = await getOne(
        `SELECT MIN(ts) AS first_ts FROM radiation_readings
         WHERE astronaut_id = ? AND trust_status = 'trusted' AND ts >= ? AND rate_usv_per_h > ?`,
        [astronautIds[2], new Date(nowMinute.getTime() - 12 * 60 * 60 * 1000), priyaRadiation.averageRate * 1.15],
      );
      const radiationHours = Math.max(
        1,
        Math.round(
          (new Date(priyaRadiation.ts).getTime() - new Date(radiationStart.first_ts).getTime()) / 3600000,
        ),
      );
      alertRows.push({
        astronautId: astronautIds[2],
        category: 'radiation',
        severity: 'warning',
        title: 'Dose rate above 7-day average',
        description: `The trusted dose rate is ${oneDecimal(priyaRadiation.rate)} µSv/h, ${Math.round(priyaRadiation.percentAboveAverage)}% above the 7-day average rate of ${oneDecimal(priyaRadiation.averageRate)} µSv/h (${priyaRadiation.averageDailyDoseLast7d.toFixed(3)} mSv/day). The elevation has persisted for ${radiationHours} hours.`,
        causes: ['Solar particle event', 'Dosimeter drift'],
        recommendation: 'Confirm with the backup dosimeter and consider moving the sleep shift to the shielded module.',
        confidence: 0.78,
        basis: 'Confirmed by 2 dosimeters',
        sensors: 2,
        metrics: ['radiation'],
        createdAt: new Date(radiationStart.first_ts),
      });
    }

    // --- Diego: a temperature excursion that has since recovered -----------
    const diego = astronautIds[3];
    const tempPeak = await getOne(
      `SELECT value, ts FROM readings
       WHERE astronaut_id = ? AND metric = 'body_temp' AND trust_status = 'trusted' AND ts >= ?
       ORDER BY value DESC LIMIT 1`,
      [diego, minutesAgo(8 * 60)],
    );
    const tempSpan = await getOne(
      `SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM readings
       WHERE astronaut_id = ? AND metric = 'body_temp' AND trust_status = 'trusted'
         AND value >= 37.8 AND ts >= ?`,
      [diego, minutesAgo(8 * 60)],
    );
    const tempLatest = await latestTrustedReading(diego, 'body_temp');
    if (tempPeak && tempSpan) {
      const heatMinutes = Math.max(
        1,
        Math.round((new Date(tempSpan.last_ts).getTime() - new Date(tempSpan.first_ts).getTime()) / 60000),
      );
      alertRows.push({
        astronautId: diego,
        category: 'health',
        severity: severityFor('body_temp', Number(tempPeak.value)),
        title: 'Transient temperature elevation',
        description: `Body temperature reached ${oneDecimal(tempPeak.value)} °C for ${heatMinutes} minutes and returned to ${oneDecimal(tempLatest.value)} °C after rest. The latest trusted reading is back inside the safe range.`,
        causes: ['Hot module', 'Post-exercise', 'Sensor contact'],
        recommendation: 'Resolved after a repeat measurement; no further action.',
        confidence: 0.52,
        basis: 'Unconfirmed: single sensor',
        sensors: 1,
        metrics: ['body_temp'],
        createdAt: new Date(tempSpan.first_ts),
        resolvedAt: new Date(new Date(tempSpan.last_ts).getTime() + 15 * 60000),
      });
    }

    // --- Cabin: recovered CO2 and air-quality excursions -------------------
    const co2Peak = await getOne(
      `SELECT value, ts FROM environment_readings
       WHERE metric = 'co2' AND trust_status = 'trusted' AND ts >= ?
       ORDER BY value DESC LIMIT 1`,
      [minutesAgo(12 * 60)],
    );
    const co2Span = await getOne(
      `SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM environment_readings
       WHERE metric = 'co2' AND trust_status = 'trusted' AND value > 1000 AND ts >= ?`,
      [minutesAgo(12 * 60)],
    );
    const co2Latest = await latestTrustedEnvironment('co2');
    if (co2Peak && co2Span && co2Latest) {
      const co2Minutes = Math.round(
        (new Date(co2Span.last_ts).getTime() - new Date(co2Span.first_ts).getTime()) / 60000,
      );
      alertRows.push({
        astronautId: null,
        category: 'environment',
        severity: 'warning',
        title: 'CO2 excursion in Node 2',
        description: `Cabin CO2 rose to ${whole(co2Peak.value)} ppm and stayed above 1000 ppm for ${co2Minutes} minutes. The latest trusted reading is ${whole(co2Latest.value)} ppm, back inside the safe range.`,
        causes: ['Reduced airlock exchange', 'Scrubber efficiency below nominal', 'Crew activity in the module'],
        recommendation: 'Resolved. Continue routine scrubber checks and confirm with the handheld CO2 meter.',
        confidence: 0.79,
        basis: 'Confirmed by 3 sensors',
        sensors: 3,
        metrics: ['co2'],
        createdAt: new Date(co2Span.first_ts),
        resolvedAt: new Date(new Date(co2Span.last_ts).getTime() + 10 * 60000),
      });
    }

    const aqPeak = await getOne(
      `SELECT value, ts FROM environment_readings
       WHERE metric = 'air_quality' AND trust_status = 'trusted' AND ts >= ?
       ORDER BY value DESC LIMIT 1`,
      [minutesAgo(8 * 60)],
    );
    const aqSpan = await getOne(
      `SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM environment_readings
       WHERE metric = 'air_quality' AND trust_status = 'trusted' AND value > 50 AND ts >= ?`,
      [minutesAgo(8 * 60)],
    );
    const aqLatest = await latestTrustedEnvironment('air_quality');
    if (aqPeak && aqSpan && aqLatest) {
      const aqMinutes = Math.round(
        (new Date(aqSpan.last_ts).getTime() - new Date(aqSpan.first_ts).getTime()) / 60000,
      );
      alertRows.push({
        astronautId: null,
        category: 'environment',
        severity: 'warning',
        title: 'Air-quality spike in the Laboratory module',
        description: `The air-quality index reached ${whole(aqPeak.value)} AQI for ${aqMinutes} minutes and has returned to ${whole(aqLatest.value)} AQI. The excursion was reported by a single node.`,
        causes: ['Filter saturation', 'Experiment off-gassing', 'Sensor fault'],
        recommendation: 'Resolved. Ventilate the module and verify the node with the next sample.',
        confidence: 0.66,
        basis: 'Unconfirmed: single sensor',
        sensors: 1,
        metrics: ['air_quality'],
        createdAt: new Date(aqSpan.first_ts),
        resolvedAt: new Date(new Date(aqSpan.last_ts).getTime() + 10 * 60000),
      });
    }

    for (const row of alertRows) {
      await conn.query(
        `INSERT INTO alerts
           (astronaut_id, category, severity, title, description, possible_causes, recommendation,
            confidence, basis_text, confirmed_sensor_count, related_metrics, created_at,
            resolved_at, acknowledged_by, acknowledged_at, escalated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.astronautId,
          row.category,
          row.severity,
          row.title,
          row.description,
          JSON.stringify(row.causes),
          row.recommendation,
          row.confidence,
          row.basis,
          row.sensors,
          JSON.stringify(row.metrics),
          row.createdAt,
          row.resolvedAt ?? null,
          row.acknowledgedBy ?? null,
          row.acknowledgedAt ?? null,
          row.escalatedAt ?? null,
        ],
      );
    }

    // -----------------------------------------------------------------------
    // Medical notes / instructions
    // -----------------------------------------------------------------------
    const noteRows = [
      [aiko, medicalId, 'instruction', 'Keep your right wrist still for 10 minutes after your next SpO2 reading so the sensor can settle. Reply with a check-in afterwards.', minutesAgo(180), null],
      [aiko, medicalId, 'note', 'SpO2 dip coincided with motion artifact. Trend is stable on the backup sensor; review again tomorrow.', minutesAgo(6 * 60), minutesAgo(5 * 60)],
      [aiko, medicalId, 'instruction', 'Log a seated check-in after EVA recovery and mention any dizziness.', minutesAgo(2 * 24 * 60), minutesAgo(2 * 24 * 60 - 30)],
      [astronautIds[1], medicalId, 'instruction', 'Re-seat the respiratory band before sleep and confirm the battery level.', minutesAgo(4 * 60), null],
      [astronautIds[1], medicalId, 'note', 'Sleep debt is accumulating. Reduced exercise intensity until fatigue returns to 2/5.', minutesAgo(20 * 60), minutesAgo(19 * 60)],
      [astronautIds[3], medicalId, 'note', 'Heart-rate elevation at rest discussed. Likely pre-EVA stress; repeat reading after hydration.', minutesAgo(80), null],
      [astronautIds[4], medicalId, 'instruction', 'Move tonight’s sleep block 30 minutes earlier and log the result in the morning check-in.', minutesAgo(110), minutesAgo(100)],
      [astronautIds[5], medicalId, 'note', 'Blood-pressure cuff conflict confirmed as a cuff placement issue. Use the arterial line for the next 24 hours.', minutesAgo(130), null],
    ];
    await insertRows(
      conn,
      'INSERT INTO medical_notes (astronaut_id, author_id, kind, body, created_at, read_at)',
      ['astronaut_id', 'author_id', 'kind', 'body', 'created_at', 'read_at'],
      noteRows,
    );

    // -----------------------------------------------------------------------
    // Baselines from trusted readings
    // -----------------------------------------------------------------------
    await conn.query(
      `INSERT INTO baselines (astronaut_id, metric, mean, std)
       SELECT astronaut_id, metric, ROUND(AVG(value), 3), ROUND(COALESCE(STDDEV_POP(value), 0), 3)
       FROM readings
       WHERE trust_status = 'trusted'
       GROUP BY astronaut_id, metric`,
    );

    // -----------------------------------------------------------------------
    // Sanity check + credentials
    // -----------------------------------------------------------------------
    const [[counts]] = await conn.query(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM readings) AS readings,
         (SELECT COUNT(*) FROM environment_readings) AS environment,
         (SELECT COUNT(*) FROM radiation_readings) AS radiation,
         (SELECT COUNT(*) FROM alerts) AS alerts`,
    );

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log('');
    console.log(`Seed complete in ${elapsed}s.`);
    console.log(`  users: ${counts.users}, readings: ${counts.readings}, environment: ${counts.environment}, radiation: ${counts.radiation}, alerts: ${counts.alerts}`);
    console.log('');
    console.log('DEV LOGIN CREDENTIALS (password is the same for every account)');
    console.log(`  Admin:    ${PEOPLE.admin.email}    / ${DEV_PASSWORD}`);
    console.log(`  Medical:  ${PEOPLE.medical.email}  / ${DEV_PASSWORD}`);
    for (const person of PEOPLE.astronauts) {
      console.log(`  Astronaut: ${person.email} / ${DEV_PASSWORD}`);
    }
    console.log('');
    console.log(`Mission: Ares Horizon I (180 days). Admin id: ${adminId}`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
