import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { queryOne, query } from '../db/pool.js';
import { env } from '../config/env.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { signToken, cookieOptions, clearCookieOptions } from '../services/tokens.js';
import { consumeInvite } from '../services/invites.js';
import { getMission } from '../services/mission.js';
import { unauthorized, conflict, badRequest } from '../utils/errors.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.RATE_LIMIT_DISABLED,
  message: { error: { code: 'rate_limited', message: 'Too many login attempts. Try again later.' } },
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(190),
  password: z.string().min(1).max(200),
});

const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password is too long'),
});

function publicUser(row) {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    role: row.role,
  };
}

router.post('/login', loginLimiter, validate({ body: loginSchema }), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await queryOne(
      `SELECT id, name, email, role, password_hash, is_active FROM users WHERE email = ?`,
      [email],
    );

    // Same message for unknown email, inactive account and wrong password.
    if (!user || !user.password_hash) throw unauthorized('Invalid email or password');
    if (!user.is_active) throw unauthorized('This account is inactive');

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw unauthorized('Invalid email or password');

    const token = signToken(user);
    res.cookie(env.COOKIE_NAME, token, cookieOptions());
    return res.json({ user: publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(env.COOKIE_NAME, clearCookieOptions());
  return res.json({ ok: true });
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const mission = await getMission();
    const payload = { user: req.user, mission };
    if (req.user.role === 'astronaut') {
      const readiness = await queryOne(
        'SELECT status FROM readiness WHERE astronaut_id = ?',
        [req.user.id],
      );
      const unread = await queryOne(
        `SELECT COUNT(*) AS count FROM medical_notes
         WHERE astronaut_id = ? AND kind = 'instruction' AND read_at IS NULL`,
        [req.user.id],
      );
      payload.readiness = readiness?.status ?? null;
      payload.unreadInstructions = Number(unread?.count ?? 0);
    }
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

router.post(
  '/accept-invite',
  loginLimiter,
  validate({ body: acceptInviteSchema }),
  async (req, res, next) => {
    try {
      const { token, password } = req.body;
      const passwordHash = await bcrypt.hash(password, 12);
      const userId = await consumeInvite(token, passwordHash);

      const user = await queryOne(
        'SELECT id, name, email, role FROM users WHERE id = ?',
        [userId],
      );
      if (!user) throw badRequest('Account not found');

      // Make sure the account is not already active with another password.
      const active = await queryOne('SELECT is_active FROM users WHERE id = ?', [userId]);
      if (!active?.is_active) throw conflict('This account is inactive');

      const jwt = signToken(user);
      res.cookie(env.COOKIE_NAME, jwt, cookieOptions());
      return res.json({ user: publicUser(user) });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
