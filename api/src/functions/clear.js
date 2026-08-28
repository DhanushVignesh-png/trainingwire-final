// FILE: api/src/functions/clear.js
// Training Wire — POST /api/clear
// GLOBAL RESET. Wipes all shared releases and publish history (flags are folded into
// history rows) for everyone, then broadcasts a "clear" event so every terminal
// empties instantly. Session required. Stamped with the actor's email.
//
// ── OPTIONAL LOCKDOWN ──
// To restrict this to admins later, add ADMIN_EMAILS to config.js and flip the
// block marked "ADMIN GATE" below. Right now any authenticated user may clear.
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const { ENV, TABLES, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

app.http('clear', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'clear',
  handler: async (request, context) => {
    // ── Gate: full session required ──
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });
    const actor = session.sub;

    // ── ADMIN GATE (disabled by default) ────────────────────────────────
    // Add ADMIN_EMAILS to config.js + import it above, then:
    // if (!Array.isArray(ADMIN_EMAILS) || !ADMIN_EMAILS.includes(actor)) {
    //   return json(403, { error: 'Only administrators can reset the wire.' });
    // }
    // ────────────────────────────────────────────────────────────────────

    let removedReleases = 0;
    let removedHistory = 0;
    try {
      // Releases live in a single 'release' partition.
      removedReleases = await tables.clearPartition(TABLES.RELEASES, 'release');

      // History is partitioned per chain, so clear every chain partition.
      const historyRows = await tables.list(TABLES.HISTORY, {});
      const chains = new Set(historyRows.map((r) => r.partitionKey));
      for (const chain of chains) {
        removedHistory += await tables.clearPartition(TABLES.HISTORY, chain);
      }
    } catch (e) {
      context.error('clear failed: ' + (e && e.message));
      return json(500, { error: 'Could not complete the reset.' });
    }

    // ── Broadcast the reset (best-effort) ──
    try {
      requireEnv(['WPS_CONNECTION', 'WPS_HUB']);
      const service = new WebPubSubServiceClient(ENV.WPS_CONNECTION, ENV.WPS_HUB);
      await service.group(WIRE_GROUP).sendToAll({
        type: 'clear',
        payload: { by: actor, at: Date.now() },
      });
    } catch (e) {
      context.error('clear broadcast failed: ' + (e && e.message));
    }

    return json(200, {
      ok: true,
      clearedBy: actor,
      removedReleases,
      removedHistory,
    });
  },
});