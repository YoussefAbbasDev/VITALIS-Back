import { query } from '../db/pool.js';
import { getMission } from './mission.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgoKey(days) {
  const d = new Date(Date.now() - days * DAY_MS);
  return dateKey(d);
}

export async function getWellness(astronautId) {
  const mission = await getMission();
  const target = mission?.exerciseTargetMinPerDay ?? 30;

  const sleep = await query(
    `SELECT date, duration_min, quality_score
     FROM sleep_records
     WHERE astronaut_id = ? AND date >= ?
     ORDER BY date ASC`,
    [astronautId, daysAgoKey(13)],
  );

  const checkins = await query(
    `SELECT id, date, stress, mood, focus, fatigue, notes
     FROM checkins
     WHERE astronaut_id = ? AND date >= ?
     ORDER BY date ASC`,
    [astronautId, daysAgoKey(29)],
  );

  const checkinIds = checkins.map((c) => Number(c.id));
  let exercises = [];
  if (checkinIds.length) {
    const placeholders = checkinIds.map(() => '?').join(', ');
    exercises = await query(
      `SELECT id, checkin_id, type, duration_min, intensity
       FROM exercise_logs WHERE checkin_id IN (${placeholders})
       ORDER BY id ASC`,
      checkinIds,
    );
  }
  const exercisesByCheckin = new Map();
  for (const ex of exercises) {
    const key = Number(ex.checkin_id);
    if (!exercisesByCheckin.has(key)) exercisesByCheckin.set(key, []);
    exercisesByCheckin.get(key).push({
      id: Number(ex.id),
      type: ex.type,
      durationMin: Number(ex.duration_min),
      intensity: Number(ex.intensity),
    });
  }

  // Exercise adherence: last 7 calendar days vs mission target.
  const adherenceRows = await query(
    `SELECT c.date, COALESCE(SUM(e.duration_min), 0) AS minutes
     FROM checkins c
     LEFT JOIN exercise_logs e ON e.checkin_id = c.id
     WHERE c.astronaut_id = ? AND c.date >= ?
     GROUP BY c.date`,
    [astronautId, daysAgoKey(6)],
  );
  const minutesByDate = new Map(
    adherenceRows.map((r) => [String(r.date).slice(0, 10), Number(r.minutes)]),
  );

  const perDay = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = daysAgoKey(i);
    const minutes = minutesByDate.get(date) ?? 0;
    perDay.push({
      date,
      minutes,
      target,
      percent: target > 0 ? Math.round((minutes / target) * 1000) / 10 : null,
      met: target > 0 ? minutes >= target : true,
    });
  }
  const validDays = perDay.filter((d) => d.percent !== null);
  const averagePercent = validDays.length
    ? Math.round((validDays.reduce((sum, d) => sum + d.percent, 0) / validDays.length) * 10) / 10
    : null;

  return {
    sleep: sleep.map((s) => ({
      date: s.date,
      durationMin: Number(s.duration_min),
      qualityScore: Number(s.quality_score),
    })),
    checkins: checkins.map((c) => ({
      id: Number(c.id),
      date: c.date,
      stress: Number(c.stress),
      mood: Number(c.mood),
      focus: Number(c.focus),
      fatigue: Number(c.fatigue),
      notes: c.notes,
      exercises: exercisesByCheckin.get(Number(c.id)) ?? [],
    })),
    adherence: {
      perDay,
      averagePercent,
      daysMet: perDay.filter((d) => d.met).length,
      target,
      windowDays: 7,
    },
  };
}
