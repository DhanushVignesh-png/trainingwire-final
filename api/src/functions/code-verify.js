// FILE: api/src/functions/code-verify.js
// Training Wire — POST /api/code-verify
//
// Step 1 of sign-in. Replaces the old otp-request + otp-verify pair: instead of
// mailing each trainee a code, everyone is given one shared master code with
// the training. A per-user email needed a sender, and mail from an
// unrecognised sender into a corporate inbox gets junked or silently dropped,
// which locks a trainee out of their own training session.
//
// WHAT THIS IS: a gate that keeps strangers from registering. It is not
// authentication — the code is shared, and everyone who has been on the
// training knows it. The MPIN is what identifies a person on return visits.
//
// WHY IT IS THROTTLED: a static 6-digit code is a million guesses, and unlike
// an OTP it cannot be burned after N wrong tries because that would lock out
// the whole cohort. So wrong guesses are counted per email address and that
// address is frozen for a while once it has guessed too often. Getting through
// by brute force would need a fresh allow-listed @thomsonreuters.com address
// every few attempts.
//
// On success: issues a short-lived REG token that ONLY permits the MPIN step,
// exactly as otp-verify did, so mpin-set and mpin-login are unchanged.
'use strict';

const { app } = require('@azure/functions');
const { LIMITS, TABLES, ENV, normalizeEmail, isAllowedEmail } = require('../shared/config');
const { verifyMasterCode, issueRegToken, json } = require('../shared/auth');
const tables = require('../shared/tables');

// The author name on every snap this person files. Kept deliberately tight:
// it is displayed to other trainees and stored on every published alert.
const NAME_RE = /^[A-Za-z][A-Za-z .'\-]{1,23}$/;

app.http('code-verify', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'code-verify',
  handler: async (request, context) => {
    // Fail loudly rather than letting everyone in if the code was never set.
    if (!ENV.MASTER_CODE) {
      context.error('MASTER_CODE is not configured; refusing all sign-ins.');
      return json(503, { error: 'Sign-in is not configured yet. Contact whoever set up your training.' });
    }

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const email = normalizeEmail(body && body.email);
    const code = String((body && body.code) || '').trim();
    const name = String((body && body.name) || '').trim();

    if (!email || !code) {
      return json(400, { error: 'Email and master code are required.' });
    }
    if (!isAllowedEmail(email)) {
      return json(403, { error: 'Use your Thomson Reuters work email.' });
    }

    // ── Existing user? Their stored name wins; new users must supply one ──
    const user = await tables.get(TABLES.USERS, 'user', email);
    const hasMpin = !!(user && user.mpinHash);
    const effectiveName = (user && user.name) || name;
    if (!effectiveName || !NAME_RE.test(effectiveName)) {
      return json(400, {
        error: 'Enter a username of 2 to 24 letters — it becomes your author name on every snap.'
      });
    }

    // ── Throttle: is this address currently frozen out? ──
    const now = Date.now();
    const rec = await tables.get(TABLES.ATTEMPTS, 'code', email);
    if (rec && rec.lockedUntil && now < Number(rec.lockedUntil)) {
      const mins = Math.max(1, Math.ceil((Number(rec.lockedUntil) - now) / 60000));
      return json(429, {
        error: `Too many incorrect codes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
      });
    }

    // Attempts outside the window are forgotten, so an honest typo months ago
    // does not count against someone today.
    let attempts = 0;
    if (rec && rec.firstAttemptAt && (now - Number(rec.firstAttemptAt)) < LIMITS.CODE_ATTEMPT_WINDOW_MS) {
      attempts = Number(rec.attempts || 0);
    }

    // ── The check ──
    if (!verifyMasterCode(code)) {
      const next = attempts + 1;
      const locked = next >= LIMITS.CODE_MAX_ATTEMPTS;
      await tables.upsert(TABLES.ATTEMPTS, {
        partitionKey: 'code',
        rowKey: email,
        attempts: locked ? 0 : next,
        firstAttemptAt: attempts === 0 ? now : Number(rec.firstAttemptAt),
        lockedUntil: locked ? now + LIMITS.CODE_LOCKOUT_MS : 0,
      });
      if (locked) {
        const mins = Math.ceil(LIMITS.CODE_LOCKOUT_MS / 60000);
        return json(429, { error: `Too many incorrect codes. Try again in ${mins} minutes.` });
      }
      const left = LIMITS.CODE_MAX_ATTEMPTS - next;
      return json(400, {
        error: `That master code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
      });
    }

    // ── Success: clear the counter and record the name for new users ──
    if (rec) await tables.remove(TABLES.ATTEMPTS, 'code', email);

    if (!user) {
      // Pre-create the row so the name is bound to the email before the MPIN
      // step. mpin-set still refuses to overwrite an existing MPIN.
      await tables.upsert(TABLES.USERS, {
        partitionKey: 'user',
        rowKey: email,
        email,
        name: effectiveName,
        createdAt: now,
      });
    } else if (user.name !== effectiveName && name && NAME_RE.test(name)) {
      // Let someone correct their own display name on a later sign-in.
      await tables.merge(TABLES.USERS, { partitionKey: 'user', rowKey: email, name: effectiveName });
    }

    const token = issueRegToken(email, effectiveName);

    return json(200, {
      ok: true,
      token,
      hasMpin,                           // false → "create MPIN", true → "enter MPIN"
      next: hasMpin ? 'login' : 'create',
      name: effectiveName,
    });
  },
});
