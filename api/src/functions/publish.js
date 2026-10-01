// FILE: api/src/functions/publish.js
// Training Wire — POST /api/publish
// The ONLY publish path. Session required. Validates the alert text, writes an
// author-stamped history row (per chain), and broadcasts the new alert to every
// connected terminal via the shared "wire" Web PubSub group. The broadcast
// INCLUDES rowKey so clients can flag a freshly-published alert without resync.
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const crypto = require('crypto');
const { ENV, LIMITS, TABLES, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

app.http('publish', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'publish',
  handler: async (request, context) => {
    // ── Gate: full session required ──
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    // ── Validate inputs ──
    const chain = String((body && body.chain) || '').trim();
    let alert = String((body && body.alert) || '').trim();
    const releaseId = String((body && body.releaseId) || '').trim() || null;

    // The author is the display name from the session, never a value the client
    // sends — otherwise anyone could file under a colleague's name.
    //
    // The one exception is the rule-based engine. A client may ask for the
    // "Auto" label, and the server writes that literal string itself; it still
    // records who triggered it. Without this, auto-snaps are credited to
    // whoever injected the release and there is no way to tell engine output
    // from a journalist's own work.
    const wantsAuto = !!(body && body.auto);
    const actor = session.name || session.sub;
    const author = wantsAuto ? 'Auto' : actor;

    if (!chain) return json(400, { error: 'A chain is required.' });
    if (!alert) return json(400, { error: 'Alert text is required.' });

    // Enforce the hard length cap server-side (client caps visually; we enforce).
    if (alert.length > LIMITS.MAX_ALERT_LENGTH) {
      alert = alert.slice(0, LIMITS.MAX_ALERT_LENGTH);
    }

    // ── Build the history row ──
    const now = Date.now();
    const id = crypto.randomUUID();
    const rowKey = String(now) + '-' + id;   // time-ordered-ish rowKey
    const entity = {
      partitionKey: chain,          // one partition per chain = fast per-chain reads
      rowKey,
      id,
      chain,
      alert,
      releaseId,
      author,
      triggeredBy: wantsAuto ? actor : '',   // who injected, when author is "Auto"
      wrong: false,                 // "wrong alert" flag, toggled by flag.js
      flaggedBy: '',
      flaggedAt: 0,
      createdAt: now,
    };

    try {
      await tables.upsert(TABLES.HISTORY, entity);
    } catch (e) {
      context.error('publish store failed: ' + (e && e.message));
      return json(500, { error: 'Could not save the alert.' });
    }

    // ── Broadcast to all connected terminals (includes rowKey) ──
    try {
      requireEnv(['WPS_CONNECTION', 'WPS_HUB']);
      const service = new WebPubSubServiceClient(ENV.WPS_CONNECTION, ENV.WPS_HUB);
      await service.group(WIRE_GROUP).sendToAll({
        type: 'publish',
        payload: {
          id, rowKey, chain, alert, releaseId, author, wrong: false, createdAt: now,
        },
      });
    } catch (e) {
      // The alert IS saved; realtime is best-effort. Log but don't fail the call.
      context.error('publish broadcast failed: ' + (e && e.message));
    }

    return json(200, { ok: true, entry: {
      id, rowKey, chain, alert, releaseId, author, wrong: false, createdAt: now,
    }});
  },
});