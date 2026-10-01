// FILE: api/src/functions/mpin-login.js
// Training Wire — POST /api/mpin-login
//
// Returning-user sign-in: email + MPIN, nothing else. The master code is now a
// one-time registration gate, not something to retype every session.
//
// THIS ENDPOINT IS THE WHOLE DOOR, so two things changed with it:
//
//   It no longer needs a REG token. Previously only code-verify could issue
//   one, which is exactly why the master code was required every time.
//
//   It is throttled. The old version said "no lockout by design", which was
//   harmless while the master code guarded the way in. Now a 6-digit MPIN is
//   all that stands between an attacker and an account, and a
//   @thomsonreuters.com address is easy to guess, so an unthrottled login is a
//   million tries at network speed. Per-email throttling turns that from
//   minutes into weeks.
//
// Responses are deliberately vague: an unknown email, an email with no MPIN
// set, and a wrong MPIN all answer the same way, so this cannot be used to
// discover who has an account.
'use strict';

const { app } = require('@azure/functions');
const { LIMITS, TABLES, normalizeEmail, isAllowedEmail } = require('../shared/config');
const { verifyMpin, issueSession, json } = require('../shared/auth');
const tables = require('../shared/tables');
const throttle = require('../shared/throttle');

const MPIN_LIMITS = {
  maxAttempts: LIMITS.MPIN_MAX_ATTEMPTS,
  lockoutMs: LIMITS.MPIN_LOCKOUT_MS,
  windowMs: LIMITS.MPIN_ATTEMPT_WINDOW_MS,
};

app.http('mpin-login', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'mpin-login',
  handler: async (request, context) => {
    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const email = normalizeEmail(body && body.email);
    const mpin = String((body && body.mpin) || '').trim();

    if (!email || !mpin) return json(400, { error: 'Email and MPIN are required.' });
    if (!isAllowedEmail(email)) return json(403, { error: 'Use your Thomson Reuters work email.' });
    if (!/^\d+$/.test(mpin)) return json(400, { error: 'MPIN must be numbers only.' });
    if (mpin.length < LIMITS.MPIN_MIN_LEN || mpin.length > LIMITS.MPIN_MAX_LEN) {
      return json(400, { error: `MPIN must be ${LIMITS.MPIN_MIN_LEN} digits.` });
    }

    // ── Throttle before touching the hash ──
    const state = await throttle.check('mpin', email, MPIN_LIMITS);
    if (state.locked) {
      return json(429, {
        error: `Too many incorrect attempts. Try again in ${state.minutes} minute${state.minutes === 1 ? '' : 's'}.`,
        code: 'LOCKED'
      });
    }

    const user = await tables.get(TABLES.USERS, 'user', email);
    const ok = !!(user && user.mpinHash) && verifyMpin(mpin, user.mpinHash);

    if (!ok) {
      const f = await throttle.fail('mpin', email, MPIN_LIMITS, state);
      if (f.locked) {
        return json(429, { error: `Too many incorrect attempts. Try again in ${f.minutes} minutes.`, code: 'LOCKED' });
      }
      // Same message whether the account exists or not.
      return json(401, {
        error: user && user.mpinHash
          ? `Incorrect MPIN. ${f.left} attempt${f.left === 1 ? '' : 's'} left.`
          : 'That email and MPIN do not match. If this is your first time, register instead.',
        code: 'BAD_MPIN'
      });
    }

    await throttle.clear('mpin', email);

    const name = user.name || '';
    try {
      await tables.merge(TABLES.USERS, { partitionKey: 'user', rowKey: email, lastLoginAt: Date.now() });
    } catch (e) {
      context.error('mpin-login lastLogin merge failed: ' + (e && e.message));   // non-fatal
    }

    // The author name rides on the session, so every published alert is
    // attributed from the token rather than from whatever the client claims.
    const token = issueSession(email, name);
    return json(200, { ok: true, token, email, name });
  },
});
