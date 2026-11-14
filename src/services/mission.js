import { queryOne } from '../db/pool.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

export async function getMission() {
  const mission = await queryOne(
    `SELECT id, name, start_date, end_date, radiation_limit_msv, exercise_target_min_per_day
     FROM missions ORDER BY id ASC LIMIT 1`,
  );
  if (!mission) return null;

  const start = parseDateOnly(mission.start_date);
  const end = parseDateOnly(mission.end_date);
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const totalDays = Math.max(1, Math.round((end - start) / DAY_MS) + 1);
  const elapsed = Math.floor((todayUtc - start) / DAY_MS) + 1;
  const day = Math.min(Math.max(elapsed, 1), totalDays);
  const remainingDays = Math.max(0, Math.round((end - todayUtc) / DAY_MS));

  return {
    id: Number(mission.id),
    name: mission.name,
    startDate: mission.start_date,
    endDate: mission.end_date,
    radiationLimitMsv: Number(mission.radiation_limit_msv),
    exerciseTargetMinPerDay: Number(mission.exercise_target_min_per_day),
    day,
    totalDays,
    remainingDays,
    started: elapsed >= 1,
    finished: todayUtc > end,
  };
}

export function missionDayLabel(mission) {
  return mission ? `Day ${mission.day} of ${mission.totalDays}` : 'No active mission';
}

export { toDateOnly, parseDateOnly };
