import { query } from '../db/pool.js';
import { HEALTH_METRIC_ORDER, METRIC_LABELS } from './readings.js';
import { getActiveAlertCounts, getActiveAlertCountsForMany } from './alerts.js';

const LEVEL_WEIGHT = { normal: 0, warning: 1, critical: 2 };

function maxLevel(a, b) {
  return LEVEL_WEIGHT[a] >= LEVEL_WEIGHT[b] ? a : b;
}

/**
 * Derives a single overall status from trusted data + readiness + alert counts.
 * Excluded readings never drive status; suspect readings only add a warning and
 * are not evaluated as clinical values (the UI shows their last trusted value).
 */
export function computeOverallStatus({ readings, ranges, baselines, readiness, alertCounts }) {
  const issues = [];
  const received = readings ?? [];
  const usable = received.filter((reading) => reading.trustStatus !== 'excluded');
  let level = 'normal';

  for (const reading of received) {
    const label = METRIC_LABELS[reading.metric] ?? reading.metric;
    const range = ranges?.[reading.metric];
    if (!range) continue;

    if (reading.trustStatus === 'excluded') continue;

    if (reading.trustStatus === 'suspect') {
      issues.push({
        level: 'warning',
        text: `${label} has a suspect reading (${reading.value} ${reading.unit}); last trusted value ${reading.lastTrusted?.value ?? 'n/a'} ${reading.unit}`,
      });
      continue;
    }

    const value = Number(reading.value);
    if (value <= range.criticalMin || value >= range.criticalMax) {
      issues.push({
        level: 'critical',
        text: `${label} is outside the critical range (${value} ${reading.unit})`,
      });
      continue;
    }
    if (value < range.safeMin || value > range.safeMax) {
      issues.push({
        level: 'warning',
        text: `${label} is outside the safe range (${value} ${reading.unit})`,
      });
      continue;
    }

    const baseline = baselines?.[reading.metric];
    if (baseline && baseline.std > 0 && Math.abs(value - baseline.mean) > 2.5 * baseline.std) {
      issues.push({
        level: 'warning',
        text: `${label} deviates from the personal baseline (${value} vs ${Math.round(baseline.mean * 10) / 10} ${reading.unit})`,
      });
    }
  }

  if (alertCounts?.critical > 0) {
    issues.push({
      level: 'critical',
      text: `${alertCounts.critical} active critical alert${alertCounts.critical > 1 ? 's' : ''}`,
    });
  } else if (alertCounts?.warning > 0) {
    issues.push({
      level: 'warning',
      text: `${alertCounts.warning} active warning alert${alertCounts.warning > 1 ? 's' : ''}`,
    });
  }

  if (readiness === 'unfit') {
    issues.push({ level: 'critical', text: 'Readiness is set to unfit by the medical officer' });
  } else if (readiness === 'limited') {
    issues.push({ level: 'warning', text: 'Readiness is set to limited by the medical officer' });
  }

  for (const issue of issues) level = maxLevel(level, issue.level);

  const primary = issues.find((i) => i.level === 'critical')
    ?? issues.find((i) => i.level === 'warning')
    ?? null;

  let okReason = 'All monitored vitals are within range.';
  if (received.length === 0) {
    okReason = 'No monitoring data has been received for this astronaut yet. Status will update automatically when readings arrive.';
  } else if (usable.length === 0) {
    okReason = 'No trusted monitoring data is available; the most recent readings were excluded by the trust checks.';
  }

  return {
    level,
    hasData: usable.length > 0,
    reason: primary?.text ?? okReason,
    issues,
  };
}

// Counts always come from the same annotated active-alert list the UI renders,
// so a data-recovered alert can never inflate "N critical · M warning".
export async function getAlertCounts(astronautId) {
  return getActiveAlertCounts(astronautId);
}

export async function getAlertCountsForMany(astronautIds) {
  if (!astronautIds.length) return new Map();
  return getActiveAlertCountsForMany(astronautIds);
}

export async function getLatestReadingsForMany(astronautIds) {
  if (!astronautIds.length) return new Map();
  const placeholders = astronautIds.map(() => '?').join(', ');
  const rows = await query(
    `SELECT * FROM (
       SELECT r.*, ROW_NUMBER() OVER (PARTITION BY astronaut_id, metric ORDER BY ts DESC, id DESC) AS rn
       FROM readings r WHERE astronaut_id IN (${placeholders})
     ) x WHERE rn = 1`,
    astronautIds,
  );
  const map = new Map(astronautIds.map((id) => [id, []]));
  for (const row of rows) {
    const list = map.get(Number(row.astronaut_id));
    if (!list) continue;
    // ORDER BY is applied below so cards always show the canonical order.
    list.push(row);
  }
  for (const [id, list] of map) {
    const byMetric = Object.fromEntries(list.map((r) => [r.metric, r]));
    map.set(
      id,
      HEALTH_METRIC_ORDER.filter((m) => byMetric[m]).map((m) => ({
        metric: m,
        value: Number(byMetric[m].value),
        unit: byMetric[m].unit,
        trustStatus: byMetric[m].trust_status,
        ts: byMetric[m].ts,
        lastTrusted: byMetric[m].trust_status === 'trusted'
          ? { value: Number(byMetric[m].value), ts: byMetric[m].ts }
          : null,
      })),
    );
  }
  return map;
}
