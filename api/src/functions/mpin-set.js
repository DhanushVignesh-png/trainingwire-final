// FILE: api/src/functions/mpin-set.js
// Training Wire — POST /api/mpin-set
// First-time MPIN creation. Requires a valid REG token (from code-verify).
// Refuses to overwrite an existing MPIN. On success, stores the PBKDF2 hash and
// immediately issues a full SESSION token so the user lands logged in.
'use strict';

const { app } = require('@azure/functions');
const { LIMITS, TABLES } = require('../shared/config');
const { getRegSession, hashMpin, issueSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

app.http('mpin-set', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'mpin-set',
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

    // ── Do not overwrite an existing MPIN via this endpoint ──
    const existing = await tables.get(TABLES.USERS, 'user', email);
    if (existing && existing.mpinHash) {
      return json(409, { error: 'An MPIN already exists for this account. Please sign in.' });
    }

    // ── Store user with hashed MPIN ──
    // The author name comes off the REG token, not the request body, so the
    // client cannot file snaps under a name it was never granted. code-verify
    // already wrote the row, so merge rather than overwrite it.
    const name = reg.name || (existing && existing.name) || '';
    await tables.merge(TABLES.USERS, {
      partitionKey: 'user',
      rowKey: email,
      email,
      name,
      mpinHash: hashMpin(mpin),
      createdAt: (existing && existing.createdAt) || Date.now(),
      lastLoginAt: Date.now(),
    });

    // ── Issue full session — user is now logged in ──
    const token = issueSession(email, name);
    return json(200, { ok: true, token, email, name });
  },
});