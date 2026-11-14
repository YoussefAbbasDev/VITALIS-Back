import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { askAssistant, getAssistantHistory } from '../services/assistant.js';
import { env } from '../config/env.js';

const router = Router();
router.use(authenticate, requireRole('astronaut', 'medical'));

const askLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.RATE_LIMIT_DISABLED,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many assistant messages. Wait a few minutes and try again.',
    },
  },
});

const askSchema = z.object({
  message: z.string().trim().min(2, 'Ask a question with at least two characters').max(2000),
  astronautId: z.coerce.number().int().positive().optional(),
});

router.get('/status', (req, res) => {
  res.json({
    configured: env.LLM_ENABLED,
    model: env.LLM_ENABLED ? env.LLM_MODEL : null,
    provider: env.LLM_ENABLED ? new URL(env.LLM_BASE_URL).host : null,
  });
});

router.get('/messages', async (req, res, next) => {
  try {
    const messages = await getAssistantHistory(req.user.id, req.query.limit);
    return res.json({ messages });
  } catch (error) {
    return next(error);
  }
});

router.post('/messages', askLimiter, validate({ body: askSchema }), async (req, res, next) => {
  try {
    const { message, astronautId } = req.body;
    // Astronauts can only ask about themselves; the service re-checks access.
    const target = req.user.role === 'astronaut' ? req.user.id : astronautId ?? null;
    const answer = await askAssistant({ user: req.user, message, astronautId: target });
    return res.status(201).json({ message: answer });
  } catch (error) {
    return next(error);
  }
});

export default router;
