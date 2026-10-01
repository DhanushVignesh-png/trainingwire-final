// FILE: api/src/functions/mpin-login.js
// Training Wire — POST /api/mpin-login
// Returning-user login. Requires a valid REG token (from code-verify). Verifies the
// submitted 6-digit MPIN against the stored PBKDF2 hash and, on success, issues a
// full SESSION token. No lockout/attempt-counter by design (training simulation).
'use strict';

const { app } = require('@azure/functions');
const { LIMITS, TABLES } = require('../shared/config');
const { getRegSession, verifyMpin, issueSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

app.http('mpin-login', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'mpin-login',
  handler: async (request, context) => {
    // ── Gate: must hold a valid REG token ──
    const reg = getRegSession(request);
    if (!reg) {
      return json(401, { error: 'Your verification session has expired. Please sign in again.' });
    }
    const email = reg.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const mpin = String((body && body.mpin) || '').trim();

    // ── Validate MPIN shape: digits only, exactly the configured length ──
    if (!/^\d+$/.test(mpin)) {
      return json(400, { error: 'MPIN must be numbers only.' });
    }
    if (mpin.length < LIMITS.MPIN_MIN_LEN || mpin.length > LIMITS.MPIN_MAX_LEN) {
      return json(400, { error: `MPIN must be ${LIMITS.MPIN_MIN_LEN} digits.` });
    }

    // ── Load the user ──
    const user = await tables.get(TABLES.USERS, 'user', email);
    if (!user || !user.mpinHash) {
      // No MPIN set — client should have been routed to "create". Be vague.
      return json(401, { error: 'Incorrect MPIN.' });
    }

    // ── Verify (constant-time hash compare). No lockout by design. ──
    if (!verifyMpin(mpin, user.mpinHash)) {
      return json(401, { error: 'Incorrect MPIN.' });
    }

    // ── Success: stamp last login and issue a full session ──
    try {
      await tables.merge(TABLES.USERS, {
        partitionKey: 'user',
        rowKey: email,
        lastLoginAt: Date.now(),
      });
    } catch (e) {
      // Non-fatal; login still succeeds.
      context.error('mpin-login lastLogin merge failed: ' + (e && e.message));
    }

    // The author name rides on the session, so every published alert is
    // attributed from the token rather than from whatever the client claims.
    const name = user.name || reg.name || '';
    const token = issueSession(email, name);
    return json(200, { ok: true, token, email, name });
  },
});