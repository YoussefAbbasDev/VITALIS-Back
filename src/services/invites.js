import { queryOne, query } from '../db/pool.js';
import { newInviteToken, hashToken, inviteExpiry, inviteUrl } from './tokens.js';
import { conflict, notFound, badRequest } from '../utils/errors.js';

export async function createInvite(userId) {
  // Invalidate previous unused invites so only the newest link works.
  await query('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL', [userId]);

  const token = newInviteToken();
  const expiresAt = inviteExpiry();
  await query(
    'INSERT INTO invites (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, hashToken(token), expiresAt],
  );

  return {
    url: inviteUrl(token),
    expiresAt,
    expiresInHours: 72,
  };
}

// Used by the public accept-invite endpoint.
export async function consumeInvite(token, passwordHash) {
  const row = await queryOne(
    `SELECT i.id, i.user_id, i.expires_at, i.used_at, u.is_active
     FROM invites i JOIN users u ON u.id = i.user_id
     WHERE i.token_hash = ?`,
    [hashToken(token)],
  );

  if (!row) throw badRequest('This invite link is not valid');
  if (row.used_at) throw conflict('This invite has already been used');
  if (new Date(row.expires_at).getTime() < Date.now()) throw badRequest('This invite has expired');
  if (!row.is_active) throw notFound('This account is inactive');

  await query('UPDATE invites SET used_at = NOW() WHERE id = ?', [row.id]);
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, row.user_id]);
  return Number(row.user_id);
}
