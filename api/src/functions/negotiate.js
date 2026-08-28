// FILE: api/src/functions/negotiate.js
// Training Wire — GET /api/negotiate
// Mints a short-lived Azure Web PubSub client access token so the browser can open
// a realtime socket WITHOUT ever seeing the connection string. Session required.
// Token is scoped to the shared "wire" group (join/leave + send) and expires soon.
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const { ENV, LIMITS, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');

app.http('negotiate', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'negotiate',
  handler: async (request, context) => {
    // ── Gate: full session required ──
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });

    try {
      requireEnv(['WPS_CONNECTION', 'WPS_HUB']);
    } catch (e) {
      context.error('negotiate config error: ' + e.message);
      return json(500, { error: 'Realtime service is not configured.' });
    }

    try {
      const service = new WebPubSubServiceClient(ENV.WPS_CONNECTION, ENV.WPS_HUB);

      // Scope the socket to this authenticated user + the shared wire group only.
      const token = await service.getClientAccessToken({
        userId: session.sub,
        roles: [
          `webpubsub.joinLeaveGroup.${WIRE_GROUP}`,
          `webpubsub.sendToGroup.${WIRE_GROUP}`,
        ],
        expirationTimeInMinutes: LIMITS.WPS_TOKEN_MINUTES,
      });

      return json(200, {
        url: token.url,
        group: WIRE_GROUP,
        user: session.sub,
      });
    } catch (e) {
      context.error('negotiate failed: ' + (e && e.message));
      return json(502, { error: 'Could not establish realtime connection.' });
    }
  },
});