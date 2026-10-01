// FILE: api/src/shared/auth.js
// Training Wire — Auth core
// JWT signing/verification (no external lib — uses Node's built-in crypto),
// PBKDF2 MPIN hashing, OTP generation + verification, and the request-auth
// helpers every protected function uses to reject anyone without a valid token.
//
// IMPORTANT: We read the bearer token from X-Authorization first. Azure Static
// Web Apps' managed Functions host strips/overwrites the standard Authorization
// header, so the frontend sends X-Authorization. We still fall back to the
// standard header for local dev / direct calls.
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

// ── Master code ──
// Compared in constant time so a timing difference cannot leak digits. The
// value comes from configuration, never the repo, so it can be rotated in the
// portal without a redeploy — and so it is not readable by anyone who opens
// devtools, which is the flaw in checking it client-side.
function verifyMasterCode(code) {
  const supplied = Buffer.from(String(code || ''), 'utf8');
  const expected = Buffer.from(String(ENV.MASTER_CODE || ''), 'utf8');
  if (expected.length === 0) return false;              // unconfigured: refuse everything
  if (supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(supplied, expected);
}

// ── Session / reg token issuance ──
function issueSession(email, name) {
  return signToken({ sub: email, name: name || '', typ: 'session' }, LIMITS.SESSION_TTL_MS);
}
// Carries the author name through the MPIN step, so registration does not have
// to trust the client to re-send it.
function issueRegToken(email, name) {
  return signToken({ sub: email, name: name || '', typ: 'reg' }, LIMITS.REG_TOKEN_TTL_MS);
}

// ── Header token extraction ──
// Read from X-Authorization FIRST (SWA-safe), then fall back to the standard
// Authorization header for local dev / direct Function calls.
function _readHeader(request, name) {
  try {
    if (request.headers && typeof request.headers.get === 'function') {
      return request.headers.get(name) || '';
    }
    if (request.headers) {
      // Node object headers are lower-cased.
      return request.headers[name] || request.headers[name.toLowerCase()] || '';
    }
  } catch (e) { /* fall through */ }
  return '';
}

function _bearer(request) {
  const raw =
    _readHeader(request, 'x-authorization') ||
    _readHeader(request, 'authorization') ||
    '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
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
  verifyMasterCode,
  issueSession, issueRegToken,
  getSession, getRegSession, json,
};
