import crypto from 'node:crypto';
import { db } from './db.js';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    avatar_color: u.avatar_color,
    bio: u.bio,
    created_at: u.created_at,
  };
}

export async function getUserByToken(token) {
  if (!token) return null;
  const r = await db.execute({
    sql: `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    args: [token],
  });
  return r.rows[0] || null;
}

export function tokenFromRequest(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

export async function authMiddleware(req, res, next) {
  const user = await getUserByToken(tokenFromRequest(req));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

export async function optionalAuth(req, _res, next) {
  req.user = await getUserByToken(tokenFromRequest(req));
  next();
}
