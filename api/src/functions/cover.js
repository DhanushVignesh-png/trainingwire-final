// FILE: api/src/functions/cover.js
// Training Wire — POST /api/cover
//
// The per-release coverage flag ("⚑ fully covered"), shared. Previously local
// to one browser; now stored on the release row and broadcast so every terminal
// shows the same coverage state in real time. Session required.
//
// Body: { release, covered }  (covered omitted → toggle)
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const { ENV, TABLES, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

app.http('cover', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cover',
  handler: async (request, context) => {
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });
    const actor = session.name || session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const release = String((body && body.release) || '').trim();
    const desired = (body && typeof body.covered === 'boolean') ? body.covered : null;
    if (!release) return json(400, { error: 'A release is required.' });

    try {
      // Locate the release row by id.
      const rows = await tables.list(TABLES.RELEASES, { partitionKey: 'release' });
      const r = rows.find((x) => x.id === release);
      if (!r) return json(404, { error: 'That release was not found.' });

      const newCovered = desired === null ? !r.covered : desired;
      const now = Date.now();

      await tables.merge(TABLES.RELEASES, {
        partitionKey: 'release',
        rowKey: r.rowKey,
        covered: newCovered,
        coveredBy: newCovered ? actor : '',
        coveredAt: newCovered ? now : 0,
      });

      try {
        requireEnv(['WPS_CONNECTION', 'WPS_HUB']);
        const service = new WebPubSubServiceClient(ENV.WPS_CONNECTION, ENV.WPS_HUB);
        await service.group(WIRE_GROUP).sendToAll({
          type: 'cover',
          payload: { release, covered: newCovered, by: newCovered ? actor : '', at: now },
        });
      } catch (e) {
        context.error('cover broadcast failed: ' + (e && e.message));
      }

      return json(200, { ok: true, release, covered: newCovered, by: newCovered ? actor : '' });
    } catch (e) {
      context.error('cover failed: ' + (e && e.message));
      return json(500, { error: 'Could not update coverage.' });
    }
  },
});
