// FILE: api/src/functions/otp-verify.js
// Training Wire — POST /api/otp-verify
// Step 2 of login. Verifies the submitted OTP against the stored hash, enforcing
// expiry and a max-attempts burn. On success it removes the OTP and issues a
// short-lived REG token. If the user already has an MPIN, tells the client to go
// to the "enter MPIN" screen; if not, to the "create MPIN" screen.
'use strict';

const { app } = require('@azure/functions');
const { LIMITS, TABLES, normalizeEmail } = require('../shared/config');
const { verifyOtp, issueRegToken, json } = require('../shared/auth');
const tables = require('../shared/tables');

app.http('otp-verify', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'otp-verify',
  handler: async (request, context) => {
    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const email = normalizeEmail(body && body.email);
    const otp = String((body && body.otp) || '').trim();

    if (!email || !otp) {
      return json(400, { error: 'Email and code are required.' });
    }

    // ── Load the pending OTP record ──
    const record = await tables.get(TABLES.OTPS, 'otp', email);
    if (!record) {
      return json(400, { error: 'No active code. Please request a new one.' });
    }

    // ── Expiry check ──
    if (Date.now() > Number(record.expiresAt)) {
      await tables.remove(TABLES.OTPS, 'otp', email);
      return json(400, { error: 'This code has expired. Please request a new one.' });
    }

    // ── Attempts check ──
    const attempts = Number(record.attempts || 0);
    if (attempts >= LIMITS.OTP_MAX_ATTEMPTS) {
      await tables.remove(TABLES.OTPS, 'otp', email);
      return json(429, { error: 'Too many incorrect attempts. Please request a new code.' });
    }

    // ── Verify (constant-time hash compare) ──
    if (!verifyOtp(otp, record.codeHash)) {
      await tables.merge(TABLES.OTPS, {
        partitionKey: 'otp',
        rowKey: email,
        attempts: attempts + 1,
      });
      const left = Math.max(0, LIMITS.OTP_MAX_ATTEMPTS - (attempts + 1));
      return json(400, { error: `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` });
    }

    // ── Success: burn the OTP so it can't be reused ──
    await tables.remove(TABLES.OTPS, 'otp', email);

    // ── Does this user already have an MPIN set? ──
    const user = await tables.get(TABLES.USERS, 'user', email);
    const hasMpin = !!(user && user.mpinHash);

    // ── Issue a short-lived REG token that ONLY permits the MPIN step ──
    const token = issueRegToken(email);

    return json(200, {
      ok: true,
      token,
      hasMpin,                 // client: false → "create MPIN", true → "enter MPIN"
      next: hasMpin ? 'login' : 'create',
    });
  },
});