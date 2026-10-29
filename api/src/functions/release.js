// FILE: api/src/functions/release.js
// Training Wire — GET /api/release?id=...
// Returns ONE release with its body rejoined from chunks. This exists so clients
// can lazy-load a single release body on demand instead of pulling the entire wire
// snapshot (/api/state) every time a release event arrives. Critical for the free
// tier: with 20 concurrent trainees, pulling the whole snapshot per event is a
// bandwidth storm. This endpoint fetches exactly one body, only when a user opens
// a release. Session required. Same security posture as state.js.
'use strict';

const { app } = require('@azure/functions');
const { TABLES } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');
const { joinBody } = require('../shared/chunk');

app.http('release', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'release',
  handler: async (request, context) => {
    // ── Gate: full session required ──
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });

    // ── Read + validate the id ──
    let id = '';
    try {
      id = String(request.query.get('id') || '').trim();
    } catch (e) {
      // Fallback for hosts that expose query differently.
      try { id = String((request.query && request.query.id) || '').trim(); } catch (e2) { id = ''; }
    }
    if (!id) return json(400, { error: 'A release id is required.' });
    // Releases use crypto.randomUUID() ids. Keep the lookup key tightly bounded.
    if (id.length > 64 || !/^[A-Za-z0-9-]+$/.test(id)) {
      return json(400, { error: 'Invalid release id.' });
    }

    try {
      // Releases all live in the single 'release' partition (max 15 rows).
      // Scanning this one small partition and matching by id is trivial + fast.
      const rows = await tables.list(TABLES.RELEASES, { partitionKey: 'release' });
      const r = rows.find((x) => x.id === id);
      if (!r) return json(404, { error: 'That release was not found.' });

      const release = {
        id: r.id,
        wireNo: Number(r.wireNo || 0),
        kind: r.kind,
        contentType: r.contentType,
        sourceUrl: r.sourceUrl || '',
        headline: r.headline || '',
        source: r.source || '',
        bodyHtml: joinBody(r, 'bh'),   // rejoined from bh0..bhN
        bodyText: joinBody(r, 'bt'),   // rejoined from bt0..btN
        injectedBy: r.injectedBy || '',
        createdAt: Number(r.createdAt || 0),
      };

      return json(200, { ok: true, release, serverTime: Date.now() });
    } catch (e) {
      context.error('release fetch failed: ' + (e && e.message));
      return json(500, { error: 'Could not load the release.' });
    }
  },
});
