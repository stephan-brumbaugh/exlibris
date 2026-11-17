import crypto from 'node:crypto';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';

const COOKIE = 'exl_session';
const MAX_AGE = 30 * 24 * 3600; // seconds

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}

export function hasPassword() { return !!getSetting('admin_password'); }

export function setPassword(pw) {
  setSetting('admin_password', hashPassword(pw));
  // Rotating the epoch invalidates every existing session.
  setSetting('session_epoch', (getSetting('session_epoch', 0) || 0) + 1);
}

/** If ADMIN_PASSWORD is set in the environment, it becomes (or stays) the admin password. */
export function applyEnvPassword() {
  if (!config.adminPassword) return;
  if (!verifyPassword(config.adminPassword, getSetting('admin_password'))) setPassword(config.adminPassword);
}

function sign(payload) {
  const secret = getSetting('session_secret');
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSession(res) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const payload = `${exp}.${getSetting('session_epoch', 0)}`;
  const value = `${payload}.${sign(payload)}`;
  res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: MAX_AGE * 1000, path: '/' });
}

export function clearSession(res) { res.clearCookie(COOKIE, { path: '/' }); }

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function isAuthed(req) {
  const v = readCookie(req, COOKIE);
  if (!v) return false;
  const parts = v.split('.');
  if (parts.length !== 3) return false;
  const [exp, epoch, sig] = parts;
  const expected = sign(`${exp}.${epoch}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  return Number(epoch) === Number(getSetting('session_epoch', 0));
}

/** Middleware for admin API: require a session, and reject cross-site state changes. */
export function requireAdmin(req, res, next) {
  if (!isAuthed(req)) {
    if (req.path.startsWith('/api') || req.originalUrl.startsWith('/admin/api')) return res.status(401).json({ error: 'Not signed in' });
    return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      try { if (new URL(origin).host !== host) return res.status(403).json({ error: 'Cross-site request refused' }); }
      catch { return res.status(403).json({ error: 'Bad origin' }); }
    }
  }
  next();
}

// Simple login throttle: 10 attempts / 15 min per IP.
const attempts = new Map();
export function loginAllowed(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++; attempts.set(ip, rec);
  return rec.n <= 10;
}
export function loginSucceeded(ip) { attempts.delete(ip); }
