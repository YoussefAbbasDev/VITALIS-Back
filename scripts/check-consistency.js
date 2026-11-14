/**
 * DEV TOOL ONLY - verifies that every active alert agrees with the seeded
 * monitoring data. Read-only: it never writes to any table.
 *
 * Run after `npm run seed`:
 *   node scripts/check-consistency.js
 *
 * Exit code 0 means every check passed; 1 means at least one FAIL.
 */
import { query, pool } from '../src/db/pool.js';
import { mapAlert, annotateAlertsConsistency, getActiveAlertsForAstronaut } from '../src/services/alerts.js';
import { getLatestReadings, getMetricRanges } from '../src/services/readings.js';
import { getRadiationSummary } from '../src/services/radiation.js';
import { buildAstronautSummary } from '../src/services/summary.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NORMAL_CONTROL_EMAIL = 'astronaut2@vitalis.dev';

let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function alertIsSupported(alert) {
  if (!alert.currentMetrics?.length) return false;
  if (alert.category === 'radiation') {
    const radiation = alert.currentMetrics.find((metric) => metric.metric === 'radiation');
    return Boolean(radiation && radiation.percentAboveAverage > 10);
  }
  return alert.currentMetrics.some((metric) => metric.inRange === false);
}

async function rawActiveAlerts(astronautId) {
  const rows = await query(
    `SELECT a.*, u.name AS astronaut_name
     FROM alerts a
     LEFT JOIN users u ON u.id = a.astronaut_id
     WHERE (a.astronaut_id = ? OR a.astronaut_id IS NULL) AND a.resolved_at IS NULL
     ORDER BY a.created_at DESC`,
    [astronautId],
  );
  return annotateAlertsConsistency(rows.map((row) => mapAlert(row)));
}

async function latestReadingsAllNormal(astronautId) {
  const [readings, ranges] = await Promise.all([
    getLatestReadings(astronautId),
    getMetricRanges('health'),
  ]);
  if (readings.length === 0) return { normal: true, detail: 'no readings' };
  const bad = readings.filter((reading) => {
    const range = ranges[reading.metric];
    if (!range) return false;
    if (reading.trustStatus !== 'trusted') return true;
    return reading.value < range.safeMin || reading.value > range.safeMax;
  });
  return {
    normal: bad.length === 0,
    detail: bad.length
      ? bad.map((r) => `${r.metric}=${r.value} (${r.trustStatus})`).join(', ')
      : `${readings.length} metrics in range`,
  };
}

async function main() {
  const astronauts = await query(
    `SELECT id, name, email FROM users WHERE role = 'astronaut' AND is_active = 1 ORDER BY id`,
  );
  const normalControl = astronauts.find((astronaut) => astronaut.email === NORMAL_CONTROL_EMAIL);

  console.log(`Checking alert/data consistency for ${astronauts.length} astronauts.\n`);

  for (const astronaut of astronauts) {
    const id = Number(astronaut.id);
    console.log(`=== ${astronaut.name} (${astronaut.email}) ===`);

    const [activeRaw, activeList, summary, latestRadiation, radiationHistory] = await Promise.all([
      rawActiveAlerts(id),
      getActiveAlertsForAstronaut(id),
      buildAstronautSummary(id),
      getRadiationSummary(id, '7d'),
      query(
        `SELECT COUNT(*) AS count FROM radiation_readings
         WHERE astronaut_id = ? AND trust_status = 'trusted' AND ts >= ?`,
        [id, new Date(Date.now() - 14 * DAY_MS)],
      ),
    ]);

    // 1. Every active alert's related metric currently supports it.
    const unsupported = activeRaw.filter((alert) => !alertIsSupported(alert));
    check(
      'active alerts are supported by the latest trusted data',
      unsupported.length === 0 && activeRaw.every((alert) => !alert.dataRecovered),
      activeRaw.length === 0
        ? 'no active alerts'
        : unsupported.length
          ? unsupported.map((alert) => `"${alert.title}"`).join(', ')
          : `${activeRaw.length} active alert${activeRaw.length === 1 ? '' : 's'} verified`,
    );

    // 2. No active alert exists where all related readings are normal.
    const recoveredButActive = activeRaw.filter((alert) => alert.dataRecovered);
    check(
      'no active alert has all related readings back to normal',
      recoveredButActive.length === 0,
      recoveredButActive.length
        ? recoveredButActive.map((alert) => `"${alert.title}" should be resolved`).join(', ')
        : 'none',
    );

    // 3. Overall counts equal the exact active list the UI shows.
    const expected = summary.alertCounts;
    const listed = {
      critical: activeList.filter((alert) => alert.severity === 'critical').length,
      warning: activeList.filter((alert) => alert.severity === 'warning').length,
      normal: activeList.filter((alert) => alert.severity === 'normal').length,
      total: activeList.length,
    };
    const countsMatch =
      expected.critical === listed.critical
      && expected.warning === listed.warning
      && expected.normal === listed.normal
      && expected.total === listed.total
      && summary.alerts.length === Math.min(5, listed.total);
    check(
      'overall status counts equal the active alert list',
      countsMatch,
      `${expected.critical} critical / ${expected.warning} warning (${expected.total} total); list ${listed.total}, dashboard ${summary.alerts.length}`,
    );

    // 4. 7-day radiation average exists whenever history exists.
    const hasHistory = Number(radiationHistory[0]?.count ?? 0) > 0;
    const hasAverage = latestRadiation.averageDailyDoseLast7d !== null
      && Number.isFinite(Number(latestRadiation.averageDailyDoseLast7d));
    check(
      '7-day radiation average exists when history exists',
      !hasHistory || hasAverage,
      hasHistory
        ? `history present, average ${hasAverage ? `${latestRadiation.averageDailyDoseLast7d} mSv/day` : 'MISSING'}`
        : 'no radiation history',
    );

    // 5. The designated normal astronaut has zero active alerts.
    if (normalControl && id === Number(normalControl.id)) {
      const allNormal = await latestReadingsAllNormal(id);
      check(
        'normal-control astronaut has zero active alerts and all data in range',
        activeList.length === 0 && allNormal.normal,
        `${activeList.length} active alert${activeList.length === 1 ? '' : 's'}, ${allNormal.detail}`,
      );
    } else {
      check(
        'normal-control astronaut has zero active alerts',
        true,
        `not the control (${normalControl?.name ?? 'unknown'})`,
      );
    }

    console.log('');
  }

  console.log(failures === 0 ? 'All consistency checks PASSED.' : `${failures} consistency check(s) FAILED.`);
  await pool.end();
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(async (err) => {
  console.error('Consistency check failed to run:', err);
  await pool.end();
  process.exit(1);
});
