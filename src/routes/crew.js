import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { buildCrew } from '../services/crew.js';

const router = Router();
router.use(authenticate, requireRole('medical'));

router.get('/', async (req, res, next) => {
  try {
    const crew = await buildCrew(req.user.id);
    return res.json({ crew });
  } catch (err) {
    return next(err);
  }
});

export default router;
