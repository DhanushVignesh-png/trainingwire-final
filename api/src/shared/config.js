// FILE: api/src/shared/config.js
// Training Wire — Shared config & constants
// Central place for env-var access, the email allow-list, and tunable limits.
// Every value that touches Azure or security lives here so there's ONE source of truth.
'use strict';

// ── Environment variables (set in Static Web App → Configuration) ──
// None of these are hard-coded. If one is missing at runtime, the relevant
// function fails loudly rather than silently doing something insecure.
//
// NOTE: several vars accept two possible names so a naming slip in Azure
// never silently breaks the app. Primary name is listed first.
const ENV = {
  TABLES_CONNECTION: process.env.TABLES_CONNECTION || '',   // Storage account connection string
  WPS_CONNECTION:    process.env.WPS_CONNECTION || process.env.WEBPUBSUB_CONNECTION || '', // Web PubSub connection string
  WPS_HUB:           process.env.WPS_HUB || 'wire',         // Hub name (single shared wire)
  MASTER_CODE:       process.env.MASTER_CODE || '',         // 6-digit code handed out with the training
  JWT_SECRET:        process.env.JWT_SECRET || '',          // random 48-byte secret you generate
};

// ── Security policy ──
// Only these email domains may register. Anything else is rejected before the
// master code is even checked.
const ALLOWED_EMAIL_DOMAINS = ['thomsonreuters.com'];

// ── Tunables ──
const LIMITS = {
  // The master code replaced emailed OTPs: a per-user email needs a sender,
  // and mail from an unrecognised sender into a corporate inbox gets junked or
  // dropped, which locks a trainee out of their own training session.
  //
  // A single static 6-digit code is only a million guesses, and unlike an OTP
  // it cannot be burned after N wrong tries — that would lock out the whole
  // cohort. It is throttled per email address instead: a short freeze once a
  // given address has guessed wrong too often. Brute force would need a fresh
  // allow-listed @thomsonreuters.com address every few attempts.
  CODE_MAX_ATTEMPTS:      8,                    // wrong guesses per email before lockout
  CODE_LOCKOUT_MS:        15 * 60 * 1000,      // how long that address is frozen out
  CODE_ATTEMPT_WINDOW_MS: 60 * 60 * 1000,      // attempts older than this are forgotten
  SESSION_TTL_MS:         12 * 60 * 60 * 1000, // login session valid 12 hours
  REG_TOKEN_TTL_MS:       10 * 60 * 1000,      // window to set/enter MPIN after the master code
  MPIN_MIN_LEN:           6,                    // locked to exactly 6 digits
  MPIN_MAX_LEN:           6,
  FETCH_TIMEOUT_MS:       20 * 1000,           // hard cap on any URL fetch (proxy hardening)
  FETCH_MAX_BYTES:        15 * 1024 * 1024,    // 15MB response cap (proxy hardening)
  FETCH_MAX_REDIRECTS:    5,                    // max redirect hops per fetch (SSRF hardening)
  PBKDF2_ITERATIONS:      210000,              // MPIN hashing cost
  MAX_STAGED_URLS:        25,                   // matches the frontend staging cap
  MAX_ALERT_LENGTH:       240,                  // matches the frontend textarea maxlength
  MAX_HISTORY_PER_CHAIN:  100,                  // cap history rows returned per chain
  WPS_TOKEN_MINUTES:      60,                   // Web PubSub client token lifetime (minutes)
};

// ── The single shared wire ──
// One group everyone joins. All broadcasts go here.
const WIRE_GROUP = 'wire-all';

// ── Table names (created on first use) ──
const TABLES = {
  USERS:    'users',    // one row per verified user (email → MPIN hash, author name)
  ATTEMPTS: 'attempts', // master-code guess counters, per email (throttling only)
  RELEASES: 'releases', // live session releases
  HISTORY:  'history',  // published alerts (per-chain partitions); flags folded in
};

function requireEnv(keys) {
  const missing = keys.filter((k) => !ENV[k]);
  if (missing.length) {
    throw new Error('Missing required configuration: ' + missing.join(', '));
  }
}

function isAllowedEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  const domain = e.split('@')[1];
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

module.exports = {
  ENV, ALLOWED_EMAIL_DOMAINS, LIMITS, WIRE_GROUP, TABLES,
  requireEnv, isAllowedEmail, normalizeEmail,
};
