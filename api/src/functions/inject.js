// FILE: api/src/functions/inject.js
// Training Wire — POST /api/inject
// Takes staged release URLs (+ optional manual headlines), fetches/parses each one
// server-side via the SAME hardened pipeline as article-fetch, stores them as shared
// releases, and broadcasts each new release to every terminal via the "wire" group.
// Full session required. Capped at LIMITS.MAX_STAGED_URLS per call.
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { ENV, LIMITS, TABLES, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

// ── SSRF guards (same policy as article-fetch.js) ──
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] === 0) return true;
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
  if (low.startsWith('::ffff:')) return isPrivateIp(low.replace('::ffff:', ''));
  return false;
}
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Target address is not permitted.');
    return;
  }
  let records = [];
  try { records = await dns.lookup(hostname, { all: true }); }
  catch (e) { throw new Error('Could not resolve host.'); }
  if (!records.length) throw new Error('Could not resolve host.');
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error('Target address is not permitted.');
  }
}
async function validateUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (e) { throw new Error('Invalid URL.'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https URLs are allowed.');
  }
  await assertPublicHost(parsed.hostname);
  return parsed;
}

// ── Fetch one URL with manual redirects + per-hop revalidation + caps ──
async function fetchOne(rawUrl) {
  let current = await validateUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.FETCH_TIMEOUT_MS);
  try {
    let hops = 0;
    let resp;
    while (true) {
      resp = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TrainingWire/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*',
        },
      });
      const s = resp.status;
      const isRedirect = s === 301 || s === 302 || s === 303 || s === 307 || s === 308;
      const location = resp.headers.get('location');
      if (isRedirect && location) {
        hops += 1;
        if (hops > LIMITS.FETCH_MAX_REDIRECTS) throw new Error('Too many redirects.');
        current = await validateUrl(new URL(location, current).toString());
        continue;
      }
      break;
    }
    if (!resp.ok) throw new Error(`Source responded with ${resp.status}.`);

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > LIMITS.FETCH_MAX_BYTES) { reader.cancel(); throw new Error('File too large.'); }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);
    const isPdf = contentType.includes('application/pdf') || current.pathname.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      return { kind: 'pdf', contentType: 'application/pdf', base64: buffer.toString('base64'), sourceUrl: current.toString() };
    }
    return { kind: 'html', contentType: contentType || 'text/html', text: buffer.toString('utf8'), sourceUrl: current.toString() };
  } finally {
    clearTimeout(timer);
  }
}

app.http('inject', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'inject',
  handler: async (request, context) => {
    // ── Gate: full session required ──
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });
    const author = session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    // items: [{ url, headline? }]
    const items = Array.isArray(body && body.items) ? body.items : [];
    if (!items.length) return json(400, { error: 'At least one release URL is required.' });
    if (items.length > LIMITS.MAX_STAGED_URLS) {
      return json(400, { error: `You can inject at most ${LIMITS.MAX_STAGED_URLS} releases at once.` });
    }

    // ── Prepare realtime client once ──
    let service = null;
    try {
      requireEnv(['WPS_CONNECTION', 'WPS_HUB']);
      service = new WebPubSubServiceClient(ENV.WPS_CONNECTION, ENV.WPS_HUB);
    } catch (e) {
      context.error('inject realtime config error: ' + e.message);
      // Continue — storage still works; realtime is best-effort.
    }

    const results = [];
    for (const raw of items) {
      const url = String((raw && raw.url) || '').trim();
      const manualHeadline = String((raw && raw.headline) || '').trim();

      if (!url) {
        results.push({ ok: false, url, error: 'Empty URL.' });
        continue;
      }

      let fetched;
      try {
        fetched = await fetchOne(url);
      } catch (e) {
        results.push({ ok: false, url, error: e.message || 'Fetch failed.' });
        continue;
      }

      const now = Date.now();
      const id = crypto.randomUUID();
      const release = {
        partitionKey: 'release',
        rowKey: String(now) + '-' + id,
        id,
        kind: fetched.kind,                       // 'html' | 'pdf'
        contentType: fetched.contentType,
        sourceUrl: fetched.sourceUrl,
        headline: manualHeadline || '',           // optional manual override
        html: fetched.kind === 'html' ? fetched.text : '',
        base64: fetched.kind === 'pdf' ? fetched.base64 : '',
        injectedBy: author,
        createdAt: now,
      };

      try {
        await tables.upsert(TABLES.RELEASES, release);
      } catch (e) {
        context.error('inject store failed: ' + (e && e.message));
        results.push({ ok: false, url, error: 'Could not save release.' });
        continue;
      }

      // Broadcast the new release (best-effort).
      if (service) {
        try {
          await service.group(WIRE_GROUP).sendToAll({ type: 'release', payload: release });
        } catch (e) {
          context.error('inject broadcast failed: ' + (e && e.message));
        }
      }

      results.push({ ok: true, id, url: fetched.sourceUrl, kind: fetched.kind });
    }

    const ok = results.filter((r) => r.ok).length;
    return json(200, { ok: true, injected: ok, total: items.length, results });
  },
});