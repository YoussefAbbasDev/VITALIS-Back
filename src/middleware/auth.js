import { queryOne } from '../db/pool.js';
import { unauthorized, forbidden } from '../utils/errors.js';
import { env } from '../config/env.js';
import { verifyToken } from '../services/tokens.js';

export const PUBLIC_USER_COLUMNS = 'id, name, email, role, is_active, created_at';

export async function loadUserById(id) {
  return queryOne(
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ? AND is_active = 1`,
    [id],
  );
}

function extractToken(req) {
  const cookieToken = req.cookies?.[env.COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return null;
}

// Verifies the JWT cookie (or Bearer token for tooling) and loads a fresh user
// row so deactivated accounts lose access immediately.
export async function authenticate(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw unauthorized();

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      throw unauthorized('Session expired or invalid');
    }

    const user = await loadUserById(Number(payload.sub));
    if (!user) throw unauthorized('Account is inactive');

    req.user = {
      id: Number(user.id),
      name: user.name,
      email: user.email,
      role: user.role,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden('This area is not available for your role'));
    }
    return next();
  };
}

// Astronauts may only read their own id; medical officers only astronauts
// assigned to them; admins are always rejected from medical endpoints.
export async function requireAstronautAccess(req, res, next) {
  try {
    if (!req.user) throw unauthorized();
    if (req.user.role === 'admin') {
      throw forbidden('Clinical data is not available to mission command');
    }

    const astronautId = Number(req.params.id);
    if (!Number.isInteger(astronautId) || astronautId <= 0) {
      throw forbidden('Invalid astronaut');
    }

    if (req.user.role === 'astronaut') {
      if (req.user.id !== astronautId) {
        throw forbidden('You can only access your own data');
      }
      req.astronautId = astronautId;
      return next();
    }

    if (req.user.role === 'medical') {
      const assignment = await queryOne(
        'SELECT astronaut_id FROM assignments WHERE astronaut_id = ? AND medical_officer_id = ?',
        [astronautId, req.user.id],
      );
      if (!assignment) throw forbidden('This astronaut is not assigned to you');
      req.astronautId = astronautId;
      return next();
    }

    throw forbidden();
  } catch (err) {
    next(err);
  }
}

// Socket.IO handshake auth - the browser sends the httpOnly cookie.
export async function socketUserFromCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const prefix = `${env.COOKIE_NAME}=`;
  const part = cookieHeader
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(prefix));
  if (!part) return null;
  const token = decodeURIComponent(part.slice(prefix.length));
  try {
    const payload = verifyToken(token);
    return loadUserById(Number(payload.sub));
  } catch {
    return null;
  }
}
