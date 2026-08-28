// FILE: api/src/functions/flag.js
// Training Wire — POST /api/flag
// Toggles the "wrong alert" flag on a published history entry. Session required.
// Persists the new state and broadcasts it so every terminal updates live.
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const { ENV, TABLES, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

app.http('flag', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'flag',
  handler: async (request, context) => {
    // ── Gate: full session required ──
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });
    const actor = session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const chain = String((body && body.chain) || '').trim();
    const rowKey = String((body && body.rowKey) || '').trim();
    // Optional explicit state; if omitted we toggle.
    const desired = (body && typeof body.wrong === 'boolean') ? body.wrong : null;

    if (!chain || !rowKey) {
      return json(400, { error: 'chain and rowKey are required.' });
    }

    // ── Load the history entry (partition = chain) ──
    const entry = await tables.get(TABLES.HISTORY, chain, rowKey);
    if (!entry) return json(404, { error: 'That alert was not found.' });

    const newWrong = desired === null ? !entry.wrong : desired;

    // ── Persist ──
    try {
      await tables.merge(TABLES.HISTORY, {
        partitionKey: chain,
        rowKey,
        wrong: newWrong,
        flaggedBy: newWrong ? actor : '',
        flaggedAt: newWrong ? Date.now() : 0,
      });
    } catch (e) {
      context.error('flag store failed: ' + (e && e.message));
      return json(500, { error: 'Could not update the flag.' });
    }

    // ── Broadcast (best-effort) ──
    try {
      requireEnv(['WPS_CONNECTION', 'WPS_HUB']);
      const service = new WebPubSubServiceClient(ENV.WPS_CONNECTION, ENV.WPS_HUB);
      await service.group(WIRE_GROUP).sendToAll({
        type: 'flag',
        payload: { chain, rowKey, id: entry.id, wrong: newWrong, flaggedBy: newWrong ? actor : '' },
      });
    } catch (e) {
      context.error('flag broadcast failed: ' + (e && e.message));
    }

    return json(200, { ok: true, chain, rowKey, wrong: newWrong });
  },
});