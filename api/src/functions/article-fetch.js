// FILE: api/src/functions/article-fetch.js
// Training Wire — POST /api/article-fetch
// Server-side proxy that fetches a press-release URL (HTML or PDF) on behalf of the
// terminal. HARDENED: manual redirect handling with per-hop SSRF checks, scheme/host
// validation, size + time limits, content-type detection. Full session required.
'use strict';

const { app } = require('@azure/functions');
const dns = require('dns').promises;
const net = require('net');
const { LIMITS } = require('../shared/config');
const { getSession, json } = require('../shared/auth');

// ── Block private / internal ranges to stop SSRF into cloud metadata etc. ──
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;              // link-local + Azure IMDS
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64.0.0/10
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
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error('Could not resolve host.');
  }
  if (!records.length) throw new Error('Could not resolve host.');
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error('Target address is not permitted.');
  }
}

async function validateUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (e) { throw new Error('That does not look like a valid URL.'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https URLs are allowed.');
  }
  await assertPublicHost(parsed.hostname);
  return parsed;
}

app.http('article-fetch', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'article-fetch',
  handler: async (request, context) => {
    // ── Gate: full session required ──
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const rawUrl = String((body && body.url) || '').trim();
    if (!rawUrl) return json(400, { error: 'A URL is required.' });

    let current;
    try { current = await validateUrl(rawUrl); }
    catch (e) { return json(400, { error: e.message }); }

    // ── Manual redirect loop with per-hop SSRF validation ──
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIMITS.FETCH_TIMEOUT_MS);

    let resp;
    try {
      let hops = 0;
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

        const status = resp.status;
        const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
        const location = resp.headers.get('location');

        if (isRedirect && location) {
          hops += 1;
          if (hops > LIMITS.FETCH_MAX_REDIRECTS) {
            clearTimeout(timer);
            return json(502, { error: 'Too many redirects from the source.' });
          }
          let next;
          try { next = await validateUrl(new URL(location, current).toString()); }
          catch (e) { clearTimeout(timer); return json(400, { error: 'A redirect pointed to a blocked address.' }); }
          current = next;
          continue;
        }
        break;
      }
    } catch (e) {
      clearTimeout(timer);
      const msg = e.name === 'AbortError' ? 'The source took too long to respond.' : 'Could not fetch the source.';
      return json(502, { error: msg });
    }
    clearTimeout(timer);

    if (!resp.ok) return json(502, { error: `Source responded with ${resp.status}.` });

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();

    // ── Stream with a hard size cap ──
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > LIMITS.FETCH_MAX_BYTES) {
          reader.cancel();
          return json(413, { error: 'The source file is too large.' });
        }
        chunks.push(value);
      }
    } catch (e) {
      return json(502, { error: 'Failed while reading the source.' });
    }

    const buffer = Buffer.concat(chunks);
    const isPdf = contentType.includes('application/pdf') || current.pathname.toLowerCase().endsWith('.pdf');

    if (isPdf) {
      return json(200, {
        kind: 'pdf',
        contentType: 'application/pdf',
        base64: buffer.toString('base64'),
        sourceUrl: current.toString(),
      });
    }
    return json(200, {
      kind: 'html',
      contentType: contentType || 'text/html',
      text: buffer.toString('utf8'),
      sourceUrl: current.toString(),
    });
  },
});