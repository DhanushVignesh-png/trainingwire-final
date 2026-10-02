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
      // Coverage and withdrawal state are folded onto the release row, so they
      // survive a reload and reach every terminal in the snapshot.
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
        covered: !!r.covered,
        coveredBy: r.coveredBy || '',
        withdrawn: !!r.withdrawn,
        withdrawnBy: r.withdrawnBy || '',
        withdrawnAdvisory: r.withdrawnAdvisory || '',
        withdrawnAt: Number(r.withdrawnAt || 0),
      }));

      // ── History — live chains AND archived (superseded) chains ──
      // Live chains sit in partition = <releaseId>. Archived chains sit in
      // partition = 'archive:<releaseId>'. We split them here so the client
      // gets both its live chain and the previous versions kept for the desk.
      const historyRows = await tables.list(TABLES.HISTORY, {});
      historyRows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

      const history = {};    // chain -> [live rows]
      const archives = {};   // chain -> { version -> { reason, by, note, at, snaps[] } }

      for (const h of historyRows) {
        const pk = h.partitionKey;
        if (pk.indexOf('archive:') === 0) {
          const chain = pk.slice('archive:'.length);
          const ver = Number(h.ver || 0);
          if (!archives[chain]) archives[chain] = {};
          if (!archives[chain][ver]) {
            archives[chain][ver] = {
              version: ver,
              reason: h.archReason || 'correction',
              by: h.archBy || '',
              note: h.archNote || '',
              at: Number(h.archAt || 0),
              snaps: [],
            };
          }
          archives[chain][ver].snaps.push({
            id: h.id,
            alert: h.alert,
            author: h.author,
            wrong: !!h.wrong,
            createdAt: Number(h.createdAt || 0),
          });
          continue;
        }

        // Live chain row.
        const chain = pk;
        if (!history[chain]) history[chain] = [];
        if (history[chain].length >= LIMITS.MAX_HISTORY_PER_CHAIN) continue;
        history[chain].push({
          id: h.id,
          rowKey: h.rowKey,
          chain,
          alert: h.alert,
          tag: h.tag || '',
          releaseId: h.releaseId || null,
          author: h.author,
          wrong: !!h.wrong,
          flaggedBy: h.flaggedBy || '',
          createdAt: Number(h.createdAt || 0),
        });
      }

      // ── Headline Activity — grouped per release, newest first ──
      let activity = {};
      try {
        const actRows = await tables.list(TABLES.ACTIVITY, {});
        actRows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
        for (const a of actRows) {
          const rel = a.partitionKey;
          if (!activity[rel]) activity[rel] = [];
          activity[rel].push({
            id: a.id,
            who: a.who || '',
            what: a.what || '',
            createdAt: Number(a.createdAt || 0),
          });
        }
      } catch (e) {
        // Table may not exist until the first activity is logged — that's fine.
        context.error('state activity read: ' + (e && e.message));
        activity = {};
      }

      // ── Embargo bundles — single partition, newest first ──
      let embargoes = [];
      try {
        const embRows = await tables.list(TABLES.EMBARGOES, { partitionKey: 'bundle' });
        embRows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
        embargoes = embRows.map((r) => {
          let alerts = [];
          try { alerts = JSON.parse(r.alertsJson || '[]'); } catch (e) { alerts = []; }
          return {
            id: r.id,
            title: r.title || '',
            kind: r.kind || 'time',
            embargoAt: r.embargoAt ? Number(r.embargoAt) : null,
            alerts,
            createdBy: r.createdBy || '',
            createdAt: Number(r.createdAt || 0),
            status: r.status || 'queued',
            publishedBy: r.publishedBy || '',
            publishedAt: r.publishedAt ? Number(r.publishedAt) : null,
            releasedAt: r.releasedAt ? Number(r.releasedAt) : null,
          };
        });
      } catch (e) {
        context.error('state embargo read: ' + (e && e.message));
        embargoes = [];
      }

      return json(200, {
        ok: true,
        user: session.sub,
        releases,
        history,
        archives,
        activity,
        embargoes,
        serverTime: Date.now(),
      });
    } catch (e) {
      context.error('state failed: ' + (e && e.message));
      return json(500, { error: 'Could not load the current wire state.' });
    }
  },
});
