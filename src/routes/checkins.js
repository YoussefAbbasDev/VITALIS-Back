import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { withTransaction } from '../db/pool.js';

const router = Router();
router.use(authenticate, requireRole('astronaut'));

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => {
    const d = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, 'Invalid calendar date');

const checkinSchema = z.object({
  date: dateString.optional(),
  stress: z.coerce.number().int().min(1).max(5),
  mood: z.coerce.number().int().min(1).max(5),
  focus: z.coerce.number().int().min(1).max(5),
  fatigue: z.coerce.number().int().min(1).max(5),
  notes: z.string().trim().max(2000).optional().nullable(),
  exercises: z
    .array(
      z.object({
        type: z.enum(['cardio', 'resistance', 'balance', 'other']),
        durationMin: z.coerce.number().int().min(1).max(600),
        intensity: z.coerce.number().int().min(1).max(5),
      }),
    )
    .max(10)
    .default([]),
});

// One check-in per astronaut per date. Re-submitting the form updates the same
// day and replaces its exercise list (the app owns these tables).
router.post('/', validate({ body: checkinSchema }), async (req, res, next) => {
  try {
    const { stress, mood, focus, fatigue, notes, exercises } = req.body;
    const date = req.body.date ?? new Date().toISOString().slice(0, 10);

    const result = await withTransaction(async (conn) => {
      await conn.execute(
        `INSERT INTO checkins (astronaut_id, date, stress, mood, focus, fatigue, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           stress = VALUES(stress), mood = VALUES(mood), focus = VALUES(focus),
           fatigue = VALUES(fatigue), notes = VALUES(notes)`,
        [req.user.id, date, stress, mood, focus, fatigue, notes ?? null],
      );

      const [rows] = await conn.execute(
        'SELECT id FROM checkins WHERE astronaut_id = ? AND date = ?',
        [req.user.id, date],
      );
      const checkinId = Number(rows[0].id);

      await conn.execute('DELETE FROM exercise_logs WHERE checkin_id = ?', [checkinId]);
      for (const exercise of exercises) {
        await conn.execute(
          `INSERT INTO exercise_logs (checkin_id, type, duration_min, intensity)
           VALUES (?, ?, ?, ?)`,
          [checkinId, exercise.type, exercise.durationMin, exercise.intensity],
        );
      }

      const [exerciseRows] = await conn.execute(
        'SELECT id, type, duration_min, intensity FROM exercise_logs WHERE checkin_id = ? ORDER BY id',
        [checkinId],
      );
      return {
        id: checkinId,
        date,
        stress,
        mood,
        focus,
        fatigue,
        notes: notes ?? null,
        exercises: exerciseRows.map((e) => ({
          id: Number(e.id),
          type: e.type,
          durationMin: Number(e.duration_min),
          intensity: Number(e.intensity),
        })),
      };
    });

    return res.status(201).json({ checkin: result });
  } catch (err) {
    return next(err);
  }
});

export default router;
