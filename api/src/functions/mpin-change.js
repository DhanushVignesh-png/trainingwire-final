// FILE: api/src/functions/mpin-change.js
// Training Wire — POST /api/mpin-change
//
// Changing your own MPIN from Settings, while signed in. Distinct from
// mpin-reset, which is the forgotten-MPIN path and is gated by the master
// code: here the proof is that you already know the current MPIN.
//
// The current MPIN is verified SERVER-SIDE. Doing it in the browser would be
// theatre — anyone with devtools could call this endpoint directly and skip
// the check entirely.
//
// Throttled on the same counter as sign-in, because this is another place a
// six-digit secret can be guessed, and a valid session is not hard to come by
// on a shared training machine someone left unlocked.
'use strict';

const { app } = require('@azure/functions');
const { LIMITS, TABLES } = require('../shared/config');
const { getSession, verifyMpin, hashMpin, issueSession, json } = require('../shared/auth');
const tables = require('../shared/tables');
const throttle = require('../shared/throttle');

const MPIN_LIMITS = {
  maxAttempts: LIMITS.MPIN_MAX_ATTEMPTS,
  lockoutMs: LIMITS.MPIN_LOCKOUT_MS,
  windowMs: LIMITS.MPIN_ATTEMPT_WINDOW_MS,
};

app.http('mpin-change', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'mpin-change',
  handler: async (request, context) => {
    const session = getSession(request);
    if (!session) return json(401, { error: 'Your session has expired. Sign in again.' });
    const email = session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const current = String((body && body.currentMpin) || '').trim();
    const next = String((body && body.newMpin) || '').trim();

    if (!/^\d+$/.test(next) || next.length !== LIMITS.MPIN_MIN_LEN) {
      return json(400, { error: `The new MPIN must be ${LIMITS.MPIN_MIN_LEN} digits.` });
    }
    if (current === next) {
      return json(400, { error: 'The new MPIN is the same as the current one.' });
    }

    const state = await throttle.check('mpin', email, MPIN_LIMITS);
    if (state.locked) {
      return json(429, { error: `Too many incorrect attempts. Try again in ${state.minutes} minutes.`, code: 'LOCKED' });
    }

    const user = await tables.get(TABLES.USERS, 'user', email);
    if (!user || !user.mpinHash) return json(409, { error: 'No MPIN is set for this account.' });

    if (!verifyMpin(current, user.mpinHash)) {
      const f = await throttle.fail('mpin', email, MPIN_LIMITS, state);
      if (f.locked) return json(429, { error: `Too many incorrect attempts. Try again in ${f.minutes} minutes.`, code: 'LOCKED' });
      return json(401, { error: `That is not your current MPIN. ${f.left} attempt${f.left === 1 ? '' : 's'} left.`, code: 'BAD_MPIN' });
    }

    await throttle.clear('mpin', email);
    await tables.merge(TABLES.USERS, {
      partitionKey: 'user',
      rowKey: email,
      mpinHash: hashMpin(next),
      mpinChangedAt: Date.now(),
    });

    // A fresh session, so the change cannot leave a stale token behind.
    const token = issueSession(email, user.name || '');
    return json(200, { ok: true, token, email, name: user.name || '' });
  },
});
