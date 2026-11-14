import { query, queryOne } from '../db/pool.js';
import { getMission } from './mission.js';
import { rangeStart } from './readings.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Radiation summary + projection:
 *   projectedTotal = cumulativeNow + averageDailyDoseLast7Days * remainingDays
 * The projection is compared with the mission's radiation limit.
 */
export async function getRadiationSummary(astronautId, range = '24h') {
  const mission = await getMission();
  const since = rangeStart(range);

  const latestRow = await queryOne(
    `SELECT * FROM radiation_readings WHERE astronaut_id = ?
     ORDER BY ts DESC, id DESC LIMIT 1`,
    [astronautId],
  );
  const latestTrusted = await queryOne(
    `SELECT * FROM radiation_readings WHERE astronaut_id = ? AND trust_status = 'trusted'
     ORDER BY ts DESC, id DESC LIMIT 1`,
    [astronautId],
  );

  const seriesRows = await query(
    `SELECT * FROM radiation_readings
     WHERE astronaut_id = ? AND ts >= ? ORDER BY ts ASC, id ASC`,
    [astronautId, since],
  );

  const previousTrusted = await queryOne(
    `SELECT cumulative_msv, ts FROM radiation_readings
     WHERE astronaut_id = ? AND trust_status = 'trusted' AND ts < ?
     ORDER BY ts DESC, id DESC LIMIT 1`,
    [astronautId, since],
  );

  let carry = previousTrusted
    ? { value: Number(previousTrusted.cumulative_msv), ts: previousTrusted.ts }
    : null;

  const series = seriesRows.map((row) => {
    const item = {
      id: Number(row.id),
      ts: row.ts,
      rateUsvPerHour: Number(row.rate_usv_per_h),
      cumulativeMsv: Number(row.cumulative_msv),
      confidence: Number(row.confidence),
      trustStatus: row.trust_status,
      trustReason: row.trust_reason ?? null,
      lastTrusted: carry,
    };
    if (row.trust_status === 'trusted') {
      carry = { value: Number(row.cumulative_msv), ts: row.ts };
    }
    return item;
  });

  const weekAgo = new Date(Date.now() - 7 * DAY_MS);
  const weekEarliest = await queryOne(
    `SELECT cumulative_msv, ts FROM radiation_readings
     WHERE astronaut_id = ? AND trust_status = 'trusted' AND ts >= ?
     ORDER BY ts ASC, id ASC LIMIT 1`,
    [astronautId, weekAgo],
  );

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayFirst = await queryOne(
    `SELECT cumulative_msv, ts FROM radiation_readings
     WHERE astronaut_id = ? AND trust_status = 'trusted' AND ts >= ?
     ORDER BY ts ASC, id ASC LIMIT 1`,
    [astronautId, todayStart],
  );

  const cumulativeMsv = latestTrusted ? Number(latestTrusted.cumulative_msv) : 0;
  const cumulativeTs = latestTrusted?.ts ?? null;

  let averageDailyDoseLast7d = null;
  if (weekEarliest && latestTrusted) {
    const elapsedDays = Math.max(
      0.01,
      (new Date(latestTrusted.ts).getTime() - new Date(weekEarliest.ts).getTime()) / DAY_MS,
    );
    averageDailyDoseLast7d =
      (Number(latestTrusted.cumulative_msv) - Number(weekEarliest.cumulative_msv)) / elapsedDays;
  } else if (latestTrusted) {
    averageDailyDoseLast7d = (Number(latestTrusted.rate_usv_per_h) / 1000) * 24;
  }

  const todayDoseMsv = latestTrusted && todayFirst
    ? Math.max(0, Number(latestTrusted.cumulative_msv) - Number(todayFirst.cumulative_msv))
    : 0;

  const remainingDays = mission?.remainingDays ?? 0;
  const averageForProjection = averageDailyDoseLast7d ?? 0;
  const projectedTotal = cumulativeMsv + averageForProjection * remainingDays;
  const limit = mission?.radiationLimitMsv ?? null;
  const percentOfLimit = limit ? (projectedTotal / limit) * 100 : null;
  const exceedsLimit = limit ? projectedTotal > limit : false;

  const missionEnd = mission
    ? new Date(`${mission.endDate}T00:00:00.000Z`)
    : new Date(Date.now() + remainingDays * DAY_MS);

  return {
    currentRate: latestRow ? Number(latestRow.rate_usv_per_h) : null,
    currentRateTs: latestRow?.ts ?? null,
    confidence: latestRow ? Number(latestRow.confidence) : null,
    trustStatus: latestRow?.trust_status ?? null,
    trustReason: latestRow?.trust_reason ?? null,
    lastTrusted: carry
      ? { value: carry.value, ts: carry.ts }
      : cumulativeTs
        ? { value: cumulativeMsv, ts: cumulativeTs }
        : null,
    cumulativeMsv,
    cumulativeTs,
    todayDoseMsv: Math.round(todayDoseMsv * 10000) / 10000,
    averageDailyDoseLast7d:
      averageDailyDoseLast7d === null ? null : Math.round(averageDailyDoseLast7d * 10000) / 10000,
    remainingDays,
    projectedTotal: Math.round(projectedTotal * 100) / 100,
    limit,
    percentOfLimit: percentOfLimit === null ? null : Math.round(percentOfLimit * 10) / 10,
    exceedsLimit,
    onTrack: limit === null ? true : projectedTotal <= limit,
    series,
    projection: [
      { ts: cumulativeTs ?? new Date().toISOString(), cumulativeMsv, projected: false },
      { ts: missionEnd.toISOString(), cumulativeMsv: Math.round(projectedTotal * 100) / 100, projected: true },
    ],
    mission,
  };
}
