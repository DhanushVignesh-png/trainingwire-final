// FILE: api/src/functions/state.js
// Training Wire — GET /api/state
// Returns the shared wire snapshot (releases + per-chain publish history) so a
// terminal can rebuild its whole view on login or after a reconnect. Release
// bodies are rejoined from their chunk properties (see shared/chunk.js).
// Session required. Flags are folded into history entries (entry.wrong).
'use strict';

const { app } = require('@azure/functions');
const { LIMITS, TABLES } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');
const { joinBody } = require('../shared/chunk');

app.http('state', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'state',
  handler: async (request, context) => {
    // ── Gate: full session required ──
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });

    try {
      // ── Releases (single 'release' partition), newest first ──
      const releaseRows = await tables.list(TABLES.RELEASES, { partitionKey: 'release' });
      releaseRows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      const releases = releaseRows.map((r) => ({
        id: r.id,
        kind: r.kind,
        contentType: r.contentType,
        sourceUrl: r.sourceUrl || '',
        headline: r.headline || '',
        source: r.source || '',
        bodyHtml: joinBody(r, 'bh'),   // rejoined from bh0..bhN
        bodyText: joinBody(r, 'bt'),   // rejoined from bt0..btN
        injectedBy: r.injectedBy || '',
        createdAt: Number(r.createdAt || 0),
      }));

      // ── History (per-chain partitions), grouped by chain, newest first ──
      const historyRows = await tables.list(TABLES.HISTORY, {});
      historyRows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

      const history = {};
      for (const h of historyRows) {
        const chain = h.partitionKey;
        if (!history[chain]) history[chain] = [];
        if (history[chain].length >= LIMITS.MAX_HISTORY_PER_CHAIN) continue;
        history[chain].push({
          id: h.id,
          rowKey: h.rowKey,
          chain,
          alert: h.alert,
          releaseId: h.releaseId || null,
          author: h.author,
          wrong: !!h.wrong,
          flaggedBy: h.flaggedBy || '',
          createdAt: Number(h.createdAt || 0),
        });
      }

      return json(200, {
        ok: true,
        user: session.sub,
        releases,
        history,
        serverTime: Date.now(),
      });
    } catch (e) {
      context.error('state failed: ' + (e && e.message));
      return json(500, { error: 'Could not load the current wire state.' });
    }
  },
});
