// FILE: api/src/shared/throttle.js
// Training Wire — per-email attempt throttling.
//
// Two things now guess-able by brute force share this: the master code and the
// MPIN. Both are six digits, both are keyed by an email address, and both
// would otherwise accept a million tries as fast as the network allows.
//
// The shape is deliberately forgiving — a trainee mistyping their PIN during a
// session must not be locked out of the exercise — but it turns "minutes" into
// "weeks" for someone working through the space, which is the only property
// that matters here.
//
// Counters live in one table partitioned by purpose ('code', 'mpin') so the
// two cannot interfere: burning your master-code attempts must not lock you
// out of signing in with a PIN you know.
'use strict';

const { TABLES } = require('./config');
const tables = require('./tables');

// Returns { locked:true, minutes } when frozen, or { locked:false, attempts }.
async function check(purpose, email, limits) {
  const now = Date.now();
  const rec = await tables.get(TABLES.ATTEMPTS, purpose, email);
  if (rec && rec.lockedUntil && now < Number(rec.lockedUntil)) {
    return { locked: true, minutes: Math.max(1, Math.ceil((Number(rec.lockedUntil) - now) / 60000)) };
  }
  // Attempts outside the window are forgotten, so an honest typo last month
  // does not count against someone today.
  let attempts = 0;
  if (rec && rec.firstAttemptAt && (now - Number(rec.firstAttemptAt)) < limits.windowMs) {
    attempts = Number(rec.attempts || 0);
  }
  return { locked: false, attempts, firstAttemptAt: rec ? Number(rec.firstAttemptAt || now) : now };
}

// Record a failure. Returns { locked, left, minutes }.
async function fail(purpose, email, limits, state) {
  const now = Date.now();
  const next = (state.attempts || 0) + 1;
  const locked = next >= limits.maxAttempts;
  await tables.upsert(TABLES.ATTEMPTS, {
    partitionKey: purpose,
    rowKey: email,
    attempts: locked ? 0 : next,
    firstAttemptAt: (state.attempts === 0) ? now : state.firstAttemptAt,
    lockedUntil: locked ? now + limits.lockoutMs : 0,
  });
  return {
    locked,
    left: Math.max(0, limits.maxAttempts - next),
    minutes: Math.ceil(limits.lockoutMs / 60000),
  };
}

async function clear(purpose, email) {
  try { await tables.remove(TABLES.ATTEMPTS, purpose, email); } catch (e) { /* nothing to clear */ }
}

module.exports = { check, fail, clear };
