// FILE: api/src/functions/profile-name.js
// Training Wire — POST /api/profile-name
//
// Changing your own author name from Settings. Gated on the current MPIN, the
// same as changing the MPIN itself, because this name is what every snap you
// file is published under — it is not a cosmetic preference.
//
// ALREADY-PUBLISHED ALERTS ARE NOT REWRITTEN. The author is stored on each
// history row as it was at the time, and a published alert is a record of what
// went out and who filed it. Renaming yourself changes what you file next, not
// what already went out.
//
// A new session is issued so the name on the token matches immediately;
// otherwise the next snap would still be filed under the old one.
'use strict';

const { app } = require('@azure/functions');
const { LIMITS, TABLES } = require('../shared/config');
const { getSession, verifyMpin, issueSession, json } = require('../shared/auth');
const tables = require('../shared/tables');
const throttle = require('../shared/throttle');

// Must match code-verify.js and the client.
const NAME_RE = /^[A-Za-z][A-Za-z .'\-]{1,23}$/;

const MPIN_LIMITS = {
  maxAttempts: LIMITS.MPIN_MAX_ATTEMPTS,
  lockoutMs: LIMITS.MPIN_LOCKOUT_MS,
  windowMs: LIMITS.MPIN_ATTEMPT_WINDOW_MS,
};

app.http('profile-name', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'profile-name',
  handler: async (request, context) => {
    const session = getSession(request);
    if (!session) return json(401, { error: 'Your session has expired. Sign in again.' });
    const email = session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const current = String((body && body.currentMpin) || '').trim();
    const name = String((body && body.name) || '').trim();

    if (!NAME_RE.test(name)) {
      return json(400, { error: 'Username must start with a letter and be 2 to 24 letters, spaces, dots, hyphens or apostrophes.' });
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
      name,
      nameChangedAt: Date.now(),
    });

    const token = issueSession(email, name);
    return json(200, { ok: true, token, email, name });
  },
});
