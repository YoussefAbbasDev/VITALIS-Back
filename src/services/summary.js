import { query, queryOne } from '../db/pool.js';
import {
  getBaselines,
  getLatestEnvironment,
  getLatestReadings,
  getMetricRanges,
} from './readings.js';
import { getRadiationSummary } from './radiation.js';
import { computeOverallStatus } from './status.js';
import {
  countAlertsBySeverity,
  getActiveAlertsForAstronaut,
} from './alerts.js';

function buildPriorityText(overall, activeAlerts, unreadInstructions) {
  // activeAlerts is already priority-sorted: severity, confidence, sensor
  // corroboration, then recency.
  const primary = activeAlerts.find((a) => a.severity === 'critical')
    ?? activeAlerts.find((a) => a.severity === 'warning')
    ?? activeAlerts[0];

  let text = overall.hasData === false
    ? overall.reason
    : `Current status: ${overall.level}. ${overall.reason}`;
  if (primary) {
    text = `${primary.title}. ${primary.recommendation ?? ''}`.trim();
    if ((primary.confirmedSensorCount ?? 0) <= 1) {
      text += ' This alert is unconfirmed by a second sensor.';
    }
  }
  if (unreadInstructions > 0) {
    text += ` You have ${unreadInstructions} unread instruction${unreadInstructions > 1 ? 's' : ''} from your medical officer.`;
  }
  return text;
}

export async function buildAstronautSummary(astronautId) {
  const astronaut = await queryOne(
    `SELECT id, name, email FROM users WHERE id = ? AND role = 'astronaut'`,
    [astronautId],
  );
  if (!astronaut) return null;

  const [readinessRow, latestReadings, baselines, ranges, environment, radiation, activeAlerts, unreadRows, unreadCount] =
    await Promise.all([
      queryOne('SELECT status, updated_at FROM readiness WHERE astronaut_id = ?', [astronautId]),
      getLatestReadings(astronautId),
      getBaselines(astronautId),
      getMetricRanges('health'),
      getLatestEnvironment(),
      getRadiationSummary(astronautId, '24h'),
      getActiveAlertsForAstronaut(astronautId),
      query(
        `SELECT id, body, created_at FROM medical_notes
         WHERE astronaut_id = ? AND kind = 'instruction' AND read_at IS NULL
         ORDER BY created_at DESC LIMIT 3`,
        [astronautId],
      ),
      queryOne(
        `SELECT COUNT(*) AS count FROM medical_notes
         WHERE astronaut_id = ? AND kind = 'instruction' AND read_at IS NULL`,
        [astronautId],
      ),
    ]);

  const readiness = readinessRow?.status ?? null;
  const alertCounts = countAlertsBySeverity(activeAlerts);
  const alerts = activeAlerts.slice(0, 5);
  const overall = computeOverallStatus({
    readings: latestReadings,
    ranges,
    baselines,
    readiness,
    alertCounts,
  });

  return {
    astronaut: { id: Number(astronaut.id), name: astronaut.name },
    readiness: readiness
      ? { status: readiness, updatedAt: readinessRow.updated_at }
      : null,
    overall,
    latestReadings,
    environment,
    radiation: {
      currentRate: radiation.currentRate,
      currentRateTs: radiation.currentRateTs,
      trustStatus: radiation.trustStatus,
      trustReason: radiation.trustReason,
      confidence: radiation.confidence,
      todayDoseMsv: radiation.todayDoseMsv,
      cumulativeMsv: radiation.cumulativeMsv,
      averageDailyDoseLast7d: radiation.averageDailyDoseLast7d,
      projectedTotal: radiation.projectedTotal,
      limit: radiation.limit,
      percentOfLimit: radiation.percentOfLimit,
      exceedsLimit: radiation.exceedsLimit,
      onTrack: radiation.onTrack,
      remainingDays: radiation.remainingDays,
    },
    alerts,
    alertCounts,
    instructions: {
      unreadCount: Number(unreadCount?.count ?? 0),
      latest: unreadRows.map((n) => ({
        id: Number(n.id),
        body: n.body,
        createdAt: n.created_at,
      })),
    },
    aiSummary: buildPriorityText(overall, activeAlerts, Number(unreadCount?.count ?? 0)),
  };
}
