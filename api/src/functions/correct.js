// FILE: api/src/functions/correct.js
// Training Wire — POST /api/correct
//
// A correction refiles a WHOLE chain. The old chain is archived server-side
// (so every terminal can read what went out before), the live chain rows are
// replaced, and a "correct" event is broadcast so every terminal rebuilds the
// chain in real time. Session required.
//
// Body: { chain, snaps: [{ text, tag }], note? }
//   chain  — the release id (= history partition key)
//   snaps  — the full new chain, oldest first, each already tagged by the
//            client as 'CORRECTED' or 'RPT' (the tag is part of the alert text)
//   note   — optional human note recorded on the archive entry
//
// WHY ARCHIVE SERVER-SIDE: the old build kept superseded chains only in the
// browser, so nobody else ever saw a correction. Archived chains now live in a
// dedicated partition ('archive:<releaseId>') in the history table, versioned,
// and come back in /api/state so a terminal that was closed still catches up.
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const crypto = require('crypto');
const { ENV, LIMITS, TABLES, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

const MAX_SNAPS = 100;

app.http('correct', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'correct',
  handler: async (request, context) => {
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });
    const actor = session.name || session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const chain = String((body && body.chain) || '').trim();
    const note = String((body && body.note) || '').trim().slice(0, 500);
    const snapsIn = Array.isArray(body && body.snaps) ? body.snaps : [];

    if (!chain) return json(400, { error: 'A chain is required.' });
    if (!snapsIn.length) return json(400, { error: 'The corrected chain cannot be empty.' });
    if (snapsIn.length > MAX_SNAPS) return json(400, { error: `A chain cannot exceed ${MAX_SNAPS} snaps.` });

    const archivePk = 'archive:' + chain;
    const now = Date.now();

    try {
      // ── 1. Read the current live chain ──
      const liveRows = await tables.list(TABLES.HISTORY, { partitionKey: chain });
      liveRows.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

      // ── 2. Work out the next version number from existing archive rows ──
      const archiveRows = await tables.list(TABLES.HISTORY, { partitionKey: archivePk });
      const maxV = archiveRows.reduce((m, r) => Math.max(m, Number(r.ver || 0)), 0);
      const archivedVersion = maxV + 1;      // the version we are archiving the OLD chain as

      // ── 3. Archive every current live row under the archive partition ──
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
          archReason: 'correction',
          archBy: actor,
          archNote: note,
          archAt: now,
          createdAt: Number(r.createdAt || 0),
        });
      }

      // ── 4. Delete the current live rows ──
      for (const r of liveRows) {
        await tables.remove(TABLES.HISTORY, chain, r.rowKey);
      }

      // ── 5. Write the new live chain, oldest first, preserving order ──
      const newChain = [];
      let seq = 0;
      for (const s of snapsIn) {
        let alert = String((s && s.text) || '').trim();
        if (!alert) continue;
        if (alert.length > LIMITS.MAX_ALERT_LENGTH) alert = alert.slice(0, LIMITS.MAX_ALERT_LENGTH);
        const tag = String((s && s.tag) || '').trim().toUpperCase();
        const id = crypto.randomUUID();
        // seq keeps order stable even if two rows share a millisecond.
        const rowKey = String(now + seq) + '-' + id;
        seq++;
        const entity = {
          partitionKey: chain,
          rowKey,
          id,
          chain,
          alert,
          tag: tag === 'CORRECTED' || tag === 'RPT' ? tag : '',
          releaseId: chain,
          author: actor,
          wrong: false,
          flaggedBy: '',
          flaggedAt: 0,
          createdAt: now + seq,
        };
        await tables.upsert(TABLES.HISTORY, entity);
        newChain.push({
          id, rowKey, chain, alert, tag: entity.tag,
          author: actor, wrong: false, createdAt: entity.createdAt,
        });
      }

      if (!newChain.length) {
        return json(400, { error: 'The corrected chain had no usable snaps.' });
      }

      // ── 6. Broadcast the correction (best-effort) ──
      try {
        requireEnv(['WPS_CONNECTION', 'WPS_HUB']);
        const service = new WebPubSubServiceClient(ENV.WPS_CONNECTION, ENV.WPS_HUB);
        await service.group(WIRE_GROUP).sendToAll({
          type: 'correct',
          payload: {
            chain,
            version: archivedVersion + 1,     // the NEW live version
            archivedVersion,
            by: actor,
            note,
            at: now,
            newChain,
          },
        });
      } catch (e) {
        context.error('correct broadcast failed: ' + (e && e.message));
      }

      return json(200, {
        ok: true,
        chain,
        version: archivedVersion + 1,
        archivedVersion,
        newChain,
      });
    } catch (e) {
      context.error('correct failed: ' + (e && e.message));
      return json(500, { error: 'Could not file the correction.' });
    }
  },
});
