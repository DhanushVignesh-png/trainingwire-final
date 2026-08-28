// FILE: api/src/functions/otp-request.js
// Training Wire — POST /api/otp-request
// Step 1 of login. Validates the email is a permitted TR address, rate-limits
// resends, generates a 6-digit OTP, stores only its HASH (with TTL + attempt
// counter), and emails the code from the Azure Communication Services domain.
'use strict';

const { app } = require('@azure/functions');
const { EmailClient } = require('@azure/communication-email');
const { ENV, LIMITS, TABLES, isAllowedEmail, normalizeEmail, requireEnv } = require('../shared/config');
const { generateOtp, hashOtp, json } = require('../shared/auth');
const tables = require('../shared/tables');

app.http('otp-request', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'otp-request',
  handler: async (request, context) => {
    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const email = normalizeEmail(body && body.email);

    // ── Security gate: only allowed TR domains, before ANY email is sent ──
    if (!isAllowedEmail(email)) {
      return json(400, { error: 'This email is not permitted for Training Wire.' });
    }

    // ── Config check: fail clearly if email service isn't wired up ──
    try {
      requireEnv(['ACS_CONNECTION', 'ACS_SENDER']);
    } catch (e) {
      context.error('otp-request config error: ' + e.message);
      return json(500, { error: 'Email service is not configured.' });
    }

    // ── Rate limit: enforce resend cooldown ──
    const existing = await tables.get(TABLES.OTPS, 'otp', email);
    if (existing && existing.lastSent) {
      const since = Date.now() - Number(existing.lastSent);
      if (since < LIMITS.OTP_RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((LIMITS.OTP_RESEND_COOLDOWN_MS - since) / 1000);
        return json(429, { error: `Please wait ${wait}s before requesting another code.` });
      }
    }

    // ── Generate + store the OTP (hashed, fresh TTL, reset attempts) ──
    const otp = generateOtp();
    const now = Date.now();
    await tables.upsert(TABLES.OTPS, {
      partitionKey: 'otp',
      rowKey: email,
      codeHash: hashOtp(otp),
      expiresAt: now + LIMITS.OTP_TTL_MS,
      attempts: 0,
      lastSent: now,
    });

    // ── Send the email ──
    try {
      const client = new EmailClient(ENV.ACS_CONNECTION);
      const minutes = Math.round(LIMITS.OTP_TTL_MS / 60000);
      const message = {
        senderAddress: ENV.ACS_SENDER,
        recipients: { to: [{ address: email }] },
        content: {
          subject: 'Your Training Wire login code',
          plainText:
            `Your Training Wire verification code is: ${otp}\n\n` +
            `This code expires in ${minutes} minutes. If you didn't request it, ignore this email.`,
          html:
            `<div style="font-family:Segoe UI,system-ui,sans-serif;font-size:14px;color:#1c2128">` +
            `<p>Your Training Wire verification code is:</p>` +
            `<p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#14181f">${otp}</p>` +
            `<p style="color:#7c848f;font-size:12px">This code expires in ${minutes} minutes. ` +
            `If you didn't request it, ignore this email.</p>` +
            `</div>`,
        },
      };
      const poller = await client.beginSend(message);
      await poller.pollUntilDone();
    } catch (e) {
      context.error('otp-request send failed: ' + (e && e.message));
      return json(502, { error: 'Could not send the code. Try again shortly.' });
    }

    return json(200, { ok: true, message: 'A code has been sent to your email.' });
  },
});