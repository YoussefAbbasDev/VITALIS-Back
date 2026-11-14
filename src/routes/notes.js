import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { query } from '../db/pool.js';
import { notFound } from '../utils/errors.js';

const router = Router();
router.use(authenticate, requireRole('astronaut'));

// Mark an instruction read. Astronauts can only affect their own notes.
router.post('/:id/read', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await query(
      `UPDATE medical_notes SET read_at = COALESCE(read_at, NOW())
       WHERE id = ? AND astronaut_id = ?`,
      [id, req.user.id],
    );
    if (!result.affectedRows) throw notFound('Instruction not found');
    return res.json({ ok: true, readAt: new Date().toISOString() });
  } catch (err) {
    return next(err);
  }
});

export default router;
