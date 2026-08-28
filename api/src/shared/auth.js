// FILE: api/src/shared/auth.js
// Training Wire — Auth core
// JWT signing/verification (no external lib — uses Node's built-in crypto),
// PBKDF2 MPIN hashing, OTP generation + verification, and the request-auth
// helpers every protected function uses to reject anyone without a valid token.
'use strict';

const crypto = require('crypto');
const { ENV, LIMITS, requireEnv } = require('./config');

// ── base64url helpers ──
function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) { return b64url(JSON.stringify(obj)); }
function fromB64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

// ── JWT (HS256) — signed with JWT_SECRET ──
function signToken(payload, ttlMs) {
  requireEnv(['JWT_SECRET']);
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Date.now();
  const body = { ...payload, iat: now, exp: now + ttlMs };
  const head = b64urlJson(header);
  const data = b64urlJson(body);
  const sig = crypto.createHmac('sha256', ENV.JWT_SECRET)
    .update(head + '.' + data).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return head + '.' + data + '.' + sig;
}

function verifyToken(token) {
  try {
    requireEnv(['JWT_SECRET']);
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [head, data, sig] = parts;
    const expected = crypto.createHmac('sha256', ENV.JWT_SECRET)
      .update(head + '.' + data).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // Constant-time comparison to avoid timing attacks.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const body = JSON.parse(fromB64url(data));
    if (!body.exp || Date.now() > body.exp) return null;
    return body;
  } catch (e) {
    return null;
  }
}

// ── MPIN hashing (PBKDF2-SHA512) ──
function hashMpin(mpin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(mpin), salt, LIMITS.PBKDF2_ITERATIONS, 32, 'sha512');
  return LIMITS.PBKDF2_ITERATIONS + ':' + salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyMpin(mpin, stored) {
  try {
    const [iterStr, saltHex, hashHex] = String(stored || '').split(':');
    const iter = parseInt(iterStr, 10);
    if (!iter || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.pbkdf2Sync(String(mpin), salt, iter, expected.length, 'sha512');
    return crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}

// ── OTP generation + hashing (never stored plaintext) ──
function generateOtp() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}
function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}
// Constant-time verify of an OTP against its stored hash.
function verifyOtp(otp, storedHash) {
  try {
    const actual = Buffer.from(hashOtp(otp), 'hex');
    const expected = Buffer.from(String(storedHash || ''), 'hex');
    if (actual.length !== expected.length || expected.length === 0) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

// ── Session / reg token issuance ──
function issueSession(email, name) {
  return signToken({ sub: email, name: name || '', typ: 'session' }, LIMITS.SESSION_TTL_MS);
}
function issueRegToken(email) {
  return signToken({ sub: email, typ: 'reg' }, LIMITS.REG_TOKEN_TTL_MS);
}

// ── Header token extraction ──
function _bearer(request) {
  let authHeader = '';
  try {
    authHeader = request.headers.get
      ? (request.headers.get('authorization') || '')
      : (request.headers.authorization || '');
  } catch (e) { authHeader = ''; }
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  return m ? m[1] : null;
}

// Full-session guard. Returns { sub, name, iat, exp } or null.
function getSession(request) {
  const tok = _bearer(request);
  if (!tok) return null;
  const body = verifyToken(tok);
  if (!body || body.typ !== 'session') return null;
  return body;
}

// Reg-token guard (only valid for the MPIN set/login step). Returns { sub } or null.
function getRegSession(request) {
  const tok = _bearer(request);
  if (!tok) return null;
  const body = verifyToken(tok);
  if (!body || body.typ !== 'reg') return null;
  return body;
}

// Small helper for JSON responses used across functions.
function json(status, obj) {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    jsonBody: obj,
  };
}

module.exports = {
  signToken, verifyToken,
  hashMpin, verifyMpin,
  generateOtp, hashOtp, verifyOtp,
  issueSession, issueRegToken,
  getSession, getRegSession, json,
};