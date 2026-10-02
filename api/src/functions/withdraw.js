// FILE: api/src/functions/withdraw.js
// Training Wire — POST /api/withdraw
//
// Withdraws a WHOLE chain with an advisory. The current chain is archived
// server-side (versioned, in 'archive:<releaseId>'), the live chain is emptied,
// and a withdrawal marker is written so every terminal shows the chain as
// withdrawn with the advisory — in real time, for everyone. Session required.
//
// Body: { chain, advisory }
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const { ENV, LIMITS, TABLES, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

const MAX_ADVISORY = 600;

app.http('withdraw', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'withdraw',
  handler: async (request, context) => {
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });
    const actor = session.name || session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const chain = String((body && body.chain) || '').trim();
    let advisory = String((body && body.advisory) || '').trim();

    if (!chain) return json(400, { error: 'A chain is required.' });
    if (!advisory) return json(400, { error: 'An advisory is required to withdraw a chain.' });
    if (advisory.length > MAX_ADVISORY) advisory = advisory.slice(0, MAX_ADVISORY);

    const archivePk = 'archive:' + chain;
    const now = Date.now();

    try {
      // ── 1. Read the current live chain ──
      const liveRows = await tables.list(TABLES.HISTORY, { partitionKey: chain });
      if (!liveRows.length) {
        return json(409, { error: 'There is nothing live to withdraw on this chain.' });
      }
      liveRows.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

      // ── 2. Next archive version ──
      const archiveRows = await tables.list(TABLES.HISTORY, { partitionKey: archivePk });
      const maxV = archiveRows.reduce((m, r) => Math.max(m, Number(r.ver || 0)), 0);
      const archivedVersion = maxV + 1;

      // ── 3. Archive the live rows with the advisory attached ──
      for (const r of liveRows) {
        await tables.upsert(TABLES.HISTORY, {
          partitionKey: archivePk,
          rowKey: 'v' + archivedVersion + '-' + r.rowKey,
          id: r.id,
          chain,
          alert: r.alert,
          author: r.author,
          releaseId: r.releaseId || null,
          wrong: !!r.wrong,
          ver: archivedVersion,
          archReason: 'withdrawal',
          archBy: actor,
          archNote: advisory,
          archAt: now,
          createdAt: Number(r.createdAt || 0),
        });
      }

      // ── 4. Delete the live rows ──
      for (const r of liveRows) {
        await tables.remove(TABLES.HISTORY, chain, r.rowKey);
      }

      // ── 5. Record the withdrawal state on the release row so it survives a
      //       reload. Stored on the release entity, read back in state.js. ──
      try {
        await tables.merge(TABLES.RELEASES, {
          partitionKey: 'release',
          // We do not know the exact release rowKey here, so we locate it.
          // See below: we find the release by id and merge onto its rowKey.
          rowKey: await releaseRowKey(chain),
          withdrawn: true,
          withdrawnBy: actor,
          withdrawnAdvisory: advisory,
          withdrawnAt: now,
          withdrawnVersion: archivedVersion,
        });
      } catch (e) {
        context.error('withdraw release-merge failed: ' + (e && e.message));
        // Non-fatal: the chain is already archived and emptied.
      }

      // ── 6. Broadcast (best-effort) ──
      try {
        requireEnv(['WPS_CONNECTION', 'WPS_HUB']);
        const service = new WebPubSubServiceClient(ENV.WPS_CONNECTION, ENV.WPS_HUB);
        await service.group(WIRE_GROUP).sendToAll({
          type: 'withdraw',
          payload: {
            chain,
            archivedVersion,
            by: actor,
            advisory,
            at: now,
          },
        });
      } catch (e) {
        context.error('withdraw broadcast failed: ' + (e && e.message));
      }

      return json(200, { ok: true, chain, archivedVersion, by: actor, advisory, at: now });
    } catch (e) {
      context.error('withdraw failed: ' + (e && e.message));
      return json(500, { error: 'Could not withdraw the chain.' });
    }
  },
});

// Find a release's rowKey by its id. Releases live in one small 'release'
// partition, so this is a cheap scan.
async function releaseRowKey(id) {
  const rows = await tables.list(TABLES.RELEASES, { partitionKey: 'release' });
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error('release not found for ' + id);
  return r.rowKey;
}
