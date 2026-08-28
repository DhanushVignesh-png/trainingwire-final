// FILE: frontend/wire-client.js
// Training Wire — API client.
// Single source of truth for talking to the backend. Owns the session token,
// attaches auth headers, enforces timeouts, and normalises all errors so the UI
// never has to think about fetch plumbing.
//
// NOTE: We send the bearer token in a CUSTOM header (X-Authorization), NOT the
// standard Authorization header. Azure Static Web Apps' managed Functions host
// runs "Easy Auth" that strips/overwrites the standard Authorization header
// before it reaches the function. X-Authorization passes through untouched.
'use strict';

const API_BASE = '/api';
const REQUEST_TIMEOUT_MS = 30000;

// ── Token storage ─────────────────────────────────────────────────────────
const SESSION_KEY = 'tw_session';
const REG_KEY = 'tw_reg';

let _regToken = sessionStorage.getItem(REG_KEY) || null;
let _sessionToken = sessionStorage.getItem(SESSION_KEY) || null;

function setRegToken(t) {
  _regToken = t || null;
  if (t) sessionStorage.setItem(REG_KEY, t);
  else sessionStorage.removeItem(REG_KEY);
}
function setSessionToken(t) {
  _sessionToken = t || null;
  if (t) sessionStorage.setItem(SESSION_KEY, t);
  else sessionStorage.removeItem(SESSION_KEY);
}
function getSessionToken() { return _sessionToken; }
function getRegToken() { return _regToken; }
function hasSession() { return !!_sessionToken; }
function clearTokens() { setRegToken(null); setSessionToken(null); }

// ── Core request helper ───────────────────────────────────────────────────
class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body = null, auth = 'session' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers = { 'Accept': 'application/json' };
  if (body !== null) headers['Content-Type'] = 'application/json';

  // Pick which token to send. Use X-Authorization (see file header note).
  if (auth === 'session' && _sessionToken) {
    headers['X-Authorization'] = 'Bearer ' + _sessionToken;
  } else if (auth === 'reg' && _regToken) {
    headers['X-Authorization'] = 'Bearer ' + _regToken;
  }

  let resp;
  try {
    resp = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new ApiError('The request timed out. Check your connection.', 0, null);
    throw new ApiError('Network error. Check your connection.', 0, null);
  }
  clearTimeout(timer);

  // Parse JSON defensively.
  let data = null;
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { data = await resp.json(); } catch (e) { data = null; }
  }

  if (!resp.ok) {
    // 401 anywhere = session is dead. Nuke tokens so the UI bounces to login.
    if (resp.status === 401) clearTokens();
    const msg = (data && data.error) ? data.error : `Request failed (${resp.status}).`;
    throw new ApiError(msg, resp.status, data);
  }

  return data || {};
}

// ── Auth endpoints ────────────────────────────────────────────────────────
async function requestOtp(email) {
  return request('/otp-request', { method: 'POST', body: { email }, auth: 'none' });
}

async function verifyOtp(email, otp) {
  const data = await request('/otp-verify', { method: 'POST', body: { email, otp }, auth: 'none' });
  // Returns { token (reg-token), hasMpin, next }
  if (data && data.token) setRegToken(data.token);
  return data;
}

async function setMpin(mpin) {
  const data = await request('/mpin-set', { method: 'POST', body: { mpin }, auth: 'reg' });
  // On success we get a full session token; promote it and drop the reg-token.
  if (data && data.token) { setSessionToken(data.token); setRegToken(null); }
  return data;
}

async function loginMpin(mpin) {
  const data = await request('/mpin-login', { method: 'POST', body: { mpin }, auth: 'reg' });
  if (data && data.token) { setSessionToken(data.token); setRegToken(null); }
  return data;
}

// ── Realtime ──────────────────────────────────────────────────────────────
async function negotiate() {
  return request('/negotiate', { method: 'GET', auth: 'session' });
}

// ── Wire operations ───────────────────────────────────────────────────────
async function fetchArticle(url) {
  return request('/article-fetch', { method: 'POST', body: { url }, auth: 'session' });
}

async function injectReleases(items) {
  return request('/inject', { method: 'POST', body: { items }, auth: 'session' });
}

async function publishAlert(chain, alert, releaseId = null) {
  return request('/publish', { method: 'POST', body: { chain, alert, releaseId }, auth: 'session' });
}

async function flagAlert(chain, rowKey, wrong = null) {
  const body = { chain, rowKey };
  if (typeof wrong === 'boolean') body.wrong = wrong;
  return request('/flag', { method: 'POST', body, auth: 'session' });
}

async function clearWire() {
  return request('/clear', { method: 'POST', auth: 'session' });
}

async function getState() {
  return request('/state', { method: 'GET', auth: 'session' });
}

// ── Public surface ────────────────────────────────────────────────────────
window.WireClient = {
  ApiError,
  hasSession, getSessionToken, getRegToken, clearTokens,
  requestOtp, verifyOtp, setMpin, loginMpin,
  negotiate,
  fetchArticle, injectReleases, publishAlert, flagAlert, clearWire, getState,
};
