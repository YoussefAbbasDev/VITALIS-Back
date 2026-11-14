import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const INVITE_TTL_HOURS = 72;

export function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, name: user.name },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN },
  );
}

export function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

// SameSite=None requires Secure; use it only when the browser calls the API
// directly on another domain. The recommended Vercel setup proxies /api from
// the frontend domain, so the default 'lax' keeps the cookie first-party.
const secureCookie = env.IS_PROD || env.COOKIE_SAMESITE === 'none';

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: env.COOKIE_SAMESITE,
    secure: secureCookie,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export function clearCookieOptions() {
  return {
    httpOnly: true,
    sameSite: env.COOKIE_SAMESITE,
    secure: secureCookie,
    path: '/',
  };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newInviteToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function inviteExpiry() {
  return new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);
}

export function inviteUrl(token) {
  return `${env.CLIENT_ORIGIN}/accept-invite?token=${encodeURIComponent(token)}`;
}
