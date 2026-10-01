// FILE: api/src/functions/delete.js
// Training Wire — POST /api/delete  { ids: [releaseId, …] }
//
// Removes specific releases from the shared wire. clear.js wipes everything;
// this is for picking a few off, which is what a trainer actually wants after
// an exercise — keep today's releases, drop yesterday's.
//
// EACH RELEASE TAKES ITS SNAPS WITH IT. The history table is partitioned by
// chain, and a chain's partition key IS the release id, so deleting the
// release without its chain would leave alert rows nobody can ever reach or
// read — they would still count toward the per-chain history cap and still
// come back in /api/state under a chain with no release.
//
// Open to any signed-in user, matching clear.js. That is a deliberate choice
// for a training tool where everyone is trusted; the commented admin gate in
// clear.js applies here too if that ever stops being true.
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const { ENV, TABLES, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

const MAX_PER_CALL = 200;

app.http('delete', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'delete',
  handler: async (request, context) => {
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });
    const actor = session.name || session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const ids = Array.isArray(body && body.ids)
      ? body.ids.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    if (!ids.length) return json(400, { error: 'Select at least one release to delete.' });
    if (ids.length > MAX_PER_CALL) {
      return json(400, { error: `Too many at once — ${MAX_PER_CALL} is the limit. Use Clear all instead.` });
    }

    const deleted = [];
    let removedHistory = 0;
    try {
      for (const id of ids) {
        // Gone already? Treat as deleted rather than failing the batch: two
        // people clicking delete on the same release should both succeed.
        try { await tables.remove(TABLES.RELEASES, 'release', id); } catch (e) { /* already gone */ }
        // The chain partition key is the release id.
        try { removedHistory += await tables.clearPartition(TABLES.HISTORY, id); } catch (e) { /* no chain */ }
        deleted.push(id);
      }
    } catch (e) {
      context.error('delete failed: ' + (e && e.message));
      return json(500, { error: 'Could not delete those releases.' });
    }

    // ── Broadcast so every terminal drops them too (best-effort) ──
    try {
      requireEnv(['WPS_CONNECTION', 'WPS_HUB']);
      const service = new WebPubSubServiceClient(ENV.WPS_CONNECTION, ENV.WPS_HUB);
      await service.group(WIRE_GROUP).sendToAll({
        type: 'delete',
        payload: { ids: deleted, by: actor, at: Date.now() },
      });
    } catch (e) {
      context.error('delete broadcast failed: ' + (e && e.message));
      // Storage is already consistent; other terminals catch up on reload.
    }

    return json(200, { ok: true, deleted, removedReleases: deleted.length, removedHistory });
  },
});
