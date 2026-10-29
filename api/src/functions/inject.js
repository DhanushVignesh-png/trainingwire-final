// FILE: api/src/functions/inject.js
// Training Wire — POST /api/inject
// OPTION A pipeline: the INJECTOR'S BROWSER fetches (via /api/article-fetch) and
// formats each release with the 1.6 ReleaseFormatter, then posts the FINISHED body
// here. This endpoint validates, chunks the body across ≤64KB Table properties
// (fixes "Could not save release"), stores a shared release, and broadcasts it to
// every terminal via the "wire" group. Full session required.
//
// Accepts items shaped as:
//   { title, bodyHtml, bodyText, kind ('html'|'pdf'), sourceUrl, source? }
// Anything oversized is rejected per-item with a clear message (never a silent fail).
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const crypto = require('crypto');
const { ENV, LIMITS, TABLES, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');
const { splitBody } = require('../shared/chunk');

// Cap sizes so one client can't post an absurd payload. These are generous;
// the chunker enforces the real ~900KB storage ceiling.
const MAX_TITLE = 500;
const MAX_SOURCE = 120;
const MAX_BODY_CHARS = 1_200_000;   // ~1.2M chars hard input guard

function clampStr(v, max) {
  const s = String(v == null ? '' : v);
  return s.length > max ? s.slice(0, max) : s;
}

app.http('inject', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'inject',
  handler: async (request, context) => {
    // ── Gate: full session required ──
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });
    // The display name, not the email: this is shown in Headline Activity as
    // "who put this release on the wire", and the desk talks about people by
    // name. Falls back to the email if a session predates names being stored.
    const author = session.name || session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const items = Array.isArray(body && body.items) ? body.items : [];
    if (!items.length) return json(400, { error: 'At least one release is required.' });
    if (items.length > LIMITS.MAX_STAGED_URLS) {
      return json(400, { error: `You can inject at most ${LIMITS.MAX_STAGED_URLS} releases at once.` });
    }

    // ── Prepare realtime client once (best-effort) ──
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
      const title = clampStr((raw && raw.title) || '', MAX_TITLE).trim();
      const kind = (raw && raw.kind === 'pdf') ? 'pdf' : 'html';
      const sourceUrl = clampStr((raw && raw.sourceUrl) || '', 2000).trim();
      const source = clampStr((raw && raw.source) || '', MAX_SOURCE).trim();
      // PDFs arrive as raw base64 behind the __PDFB64__ sentinel. Base64 must
      // NOT be clamped — a truncated base64 string is a corrupt PDF that looks
      // fine until it won't render. Reject oversized PDFs loudly instead.
      // The ceiling is the chunker's storage limit expressed in base64 chars:
      // Table Storage tops out ~900KB raw → ~1.19M base64 chars across chunks.
      const rawBodyHtml = String((raw && raw.bodyHtml) || '');
      const isPdfBody = rawBodyHtml.startsWith('__PDFB64__');

      let bodyHtml;
      if (isPdfBody) {
        const b64 = rawBodyHtml.slice('__PDFB64__'.length);
        const PDF_B64_MAX = 1_150_000;   // ~840KB raw PDF; safe under the chunk ceiling
        if (b64.length > PDF_B64_MAX) {
          const approxKb = Math.round((b64.length * 0.75) / 1024);
          results.push({ ok: false, error: 'PDF too large to store (~' + approxKb + 'KB). Paste the release text instead, or use a smaller PDF.' });
          continue;
        }
        bodyHtml = rawBodyHtml;   // store the sentinel + base64 intact, unclamped
      } else {
        bodyHtml = clampStr(rawBodyHtml, MAX_BODY_CHARS);
      }
      const bodyText = clampStr((raw && raw.bodyText) || '', MAX_BODY_CHARS);

      if (!title && !bodyHtml && !bodyText) {
        results.push({ ok: false, error: 'Empty release skipped.' });
        continue;
      }

      const now = Date.now();
      const id = crypto.randomUUID();
      // Cosmetic wire number: 1–100, random, NON-UNIQUE (one number can repeat
      // across releases). Generated here, server-side, so EVERYONE sees the same
      // number for the same release — essential for "look at release 42". The
      // real identity remains the UUID above; wireNo is only a search/display
      // label and is never used as a key.
      const wireNo = 1 + Math.floor(Math.random() * 100);

      // ── Build the entity, chunking the two large fields ──
      let htmlChunks, textChunks;
      try {
        htmlChunks = splitBody(bodyHtml, 'bh');   // bh0, bh1, … bhChunks
        textChunks = splitBody(bodyText, 'bt');   // bt0, bt1, … btChunks
      } catch (e) {
        // BODY_TOO_LARGE from the chunker → clean, per-item rejection.
        results.push({ ok: false, error: e.message || 'Release too large to store.' });
        continue;
      }

      const release = {
        partitionKey: 'release',
        rowKey: String(now) + '-' + id,
        id,
        wireNo,
        kind,
        contentType: kind === 'pdf' ? 'application/pdf' : 'text/html',
        sourceUrl,
        headline: title,
        source,
        injectedBy: author,
        createdAt: now,
        ...htmlChunks,
        ...textChunks,
      };

      try {
        await tables.upsert(TABLES.RELEASES, release);
      } catch (e) {
        context.error('inject store failed: ' + (e && e.message));
        results.push({ ok: false, error: 'Could not save release.' });
        continue;
      }

      // ── Headline Activity: record WHO put this release on the wire and WHEN.
      //    Previously nothing was logged on inject, so the activity feed never
      //    showed a release entering. Partition is the release id, matching how
      //    activity.js / state.js group entries. Best-effort: a failed log must
      //    never stop the release itself from being injected. ──
      try {
        const actId = crypto.randomUUID();
        const actRowKey = String(now) + '-' + actId;
        await tables.upsert(TABLES.ACTIVITY, {
          partitionKey: id,
          rowKey: actRowKey,
          id: actId,
          release: id,
          who: author,
          what: 'entered a release',
          createdAt: now,
        });
        // Broadcast it too, so every open terminal's activity feed updates live.
        if (service) {
          try {
            await service.group(WIRE_GROUP).sendToAll({
              type: 'activity',
              payload: { release: id, id: actId, who: author, what: 'entered a release', createdAt: now },
            });
          } catch (e) { context.error('inject activity broadcast failed: ' + (e && e.message)); }
        }
      } catch (e) {
        context.error('inject activity log failed: ' + (e && e.message));
      }

      // ── Broadcast a LIGHT payload (metadata only). Clients pull full bodies
      //    from /api/state so we never push ~1MB frames over the socket. ──
      if (service) {
        try {
          await service.group(WIRE_GROUP).sendToAll({
            type: 'release',
            payload: {
              id, wireNo, kind, headline: title, source, sourceUrl,
              injectedBy: author, createdAt: now,
            },
          });
        } catch (e) {
          context.error('inject broadcast failed: ' + (e && e.message));
        }
      }

      results.push({ ok: true, id, wireNo, kind });
    }

    const ok = results.filter((r) => r.ok).length;
    return json(200, { ok: true, injected: ok, total: items.length, results });
  },
});
