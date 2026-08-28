// FILE: api/src/shared/config.js
// Training Wire — Shared config & constants
// Central place for env-var access, the email allow-list, and tunable limits.
// Every value that touches Azure or security lives here so there's ONE source of truth.
'use strict';

// ── Environment variables (set in Static Web App → Configuration) ──
// None of these are hard-coded. If one is missing at runtime, the relevant
// function fails loudly rather than silently doing something insecure.
const ENV = {
  TABLES_CONNECTION: process.env.TABLES_CONNECTION || '',   // Storage account connection string
  WPS_CONNECTION:    process.env.WPS_CONNECTION    || '',   // Web PubSub connection string
  WPS_HUB:           process.env.WPS_HUB           || 'wire', // Hub name (single shared wire)
  ACS_CONNECTION:    process.env.ACS_CONNECTION    || '',   // Communication Services connection string
  ACS_SENDER:        process.env.ACS_SENDER        || '',   // e.g. DoNotReply@xxxx.azurecomm.net
  JWT_SECRET:        process.env.JWT_SECRET        || '',   // random 48-byte secret you generate
};

// ── Security policy ──
// Only these email domains may request an OTP. Anything else is rejected
// BEFORE an email is sent — stops randoms burning the ACS quota.
const ALLOWED_EMAIL_DOMAINS = ['thomsonreuters.com'];

// ── Tunables ──
const LIMITS = {
  OTP_TTL_MS:             5 * 60 * 1000,        // OTP valid for 5 minutes
  OTP_MAX_ATTEMPTS:       5,                    // wrong-OTP tries before it's burned
  OTP_RESEND_COOLDOWN_MS: 30 * 1000,           // min gap between OTP sends to one email
  SESSION_TTL_MS:         12 * 60 * 60 * 1000, // login session valid 12 hours
  REG_TOKEN_TTL_MS:       10 * 60 * 1000,      // window to set/enter MPIN after OTP verify
  MPIN_MIN_LEN:           6,                    // locked to exactly 6 digits
  MPIN_MAX_LEN:           6,
  FETCH_TIMEOUT_MS:       20 * 1000,           // hard cap on any URL fetch (proxy hardening)
  FETCH_MAX_BYTES:        15 * 1024 * 1024,    // 15MB response cap (proxy hardening)
  FETCH_MAX_REDIRECTS:    5,                    // max redirect hops per fetch (SSRF hardening)
  PBKDF2_ITERATIONS:      210000,              // MPIN hashing cost
  MAX_STAGED_URLS:        15,                   // matches the frontend staging cap
  MAX_ALERT_LENGTH:       240,                  // matches the frontend textarea maxlength
  MAX_HISTORY_PER_CHAIN:  100,                  // cap history rows returned per chain
  WPS_TOKEN_MINUTES:      60,                   // Web PubSub client token lifetime (minutes)
};

// ── The single shared wire ──
// One group everyone joins. All broadcasts go here.
const WIRE_GROUP = 'wire-all';

// ── Table names (created on first use) ──
const TABLES = {
  USERS:    'users',    // one row per verified user (email → MPIN hash)
  OTPS:     'otps',     // pending OTP codes (hashed, TTL-checked)
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