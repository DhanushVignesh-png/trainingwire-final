// FILE: api/src/functions/mpin-reset.js
// Training Wire — POST /api/mpin-reset
//
// Forgotten-MPIN path. mpin-set deliberately refuses to overwrite an existing
// MPIN (409), which is right for registration but leaves someone who has
// forgotten theirs with no way back in. This is that way back.
//
// The gate is the same one registration uses: a valid REG token, which is only
// issued by code-verify, which in turn requires an allow-listed Thomson
// Reuters address and the master code. So resetting is exactly as hard as
// registering in the first place — no easier, no harder.
'use strict';

const { app } = require('@azure/functions');
const { LIMITS, TABLES } = require('../shared/config');
const { getRegSession, hashMpin, issueSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

app.http('mpin-reset', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'mpin-reset',
  handler: async (request, context) => {
    // ── Gate: must hold a valid REG token ──
    const reg = getRegSession(request);
    if (!reg) {
      return json(401, { error: 'Your verification session has expired. Please sign in again.', code: 'REG_EXPIRED' });
    }
    const email = reg.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const mpin = String((body && body.mpin) || '').trim();

    if (!/^\d+$/.test(mpin)) {
      return json(400, { error: 'MPIN must be numbers only.' });
    }
    if (mpin.length < LIMITS.MPIN_MIN_LEN || mpin.length > LIMITS.MPIN_MAX_LEN) {
      return json(400, { error: `MPIN must be ${LIMITS.MPIN_MIN_LEN} digits.` });
    }

    // The row should already exist — code-verify creates it — but a reset for
    // an account with no row is just a registration, so treat it as one.
    const existing = await tables.get(TABLES.USERS, 'user', email);
    const name = (existing && existing.name) || reg.name || '';

    await tables.merge(TABLES.USERS, {
      partitionKey: 'user',
      rowKey: email,
      email,
      name,
      mpinHash: hashMpin(mpin),
      createdAt: (existing && existing.createdAt) || Date.now(),
      mpinResetAt: Date.now(),
      lastLoginAt: Date.now(),
    });

    // Land them logged in, as mpin-set does — forcing another sign-in straight
    // after a reset is pointless friction.
    const token = issueSession(email, name);
    return json(200, { ok: true, token, email, name });
  },
});
