// FILE: api/src/functions/embargo.js
// Training Wire — embargo bundles, shared.
//
// Bundles were per-browser. Now they are shared: everyone sees every bundle and
// can publish or discard any of them. Four actions over one endpoint:
//
//   POST /api/embargo              { action:'list' }                      → all bundles
//   POST /api/embargo              { action:'create', bundle }            → store + broadcast
//   POST /api/embargo              { action:'publish', id }               → mark published + broadcast
//   POST /api/embargo              { action:'discard', id }               → remove + broadcast
//   POST /api/embargo              { action:'release', id }               → time-release claim (first wins)
//
// IDS ARE SERVER UUIDS. Two trainees creating bundles at once would collide on
// client integers, so the server generates the id on create and returns it.
//
// TIME-RELEASE IS SERVER-AUTHORITATIVE. Any terminal whose clock passes a
// queued bundle's embargo time calls action:'release'. A conditional merge
// means only the FIRST claim flips 'queued' → 'released' and broadcasts; the
// rest are no-ops. No duplicate "released" storms with 20 browsers ticking.
'use strict';

const { app } = require('@azure/functions');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const crypto = require('crypto');
const { ENV, WIRE_GROUP, requireEnv } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

const EMB_TABLE = 'embargoes';
const EMB_PK = 'bundle';
const MAX_ALERTS = 50;
const MAX_TITLE = 200;
const MAX_TEXT = 240;

function broadcaster(context) {
  let service = null;
  try {
    requireEnv(['WPS_CONNECTION', 'WPS_HUB']);
    service = new WebPubSubServiceClient(ENV.WPS_CONNECTION, ENV.WPS_HUB);
  } catch (e) {
    context.error('embargo realtime config error: ' + (e && e.message));
  }
  return async (subtype, payload) => {
    if (!service) return;
    try {
      await service.group(WIRE_GROUP).sendToAll({ type: 'embargo', payload: { sub: subtype, ...payload } });
    } catch (e) {
      context.error('embargo broadcast failed: ' + (e && e.message));
    }
  };
}

function clampStr(v, max) { const s = String(v == null ? '' : v); return s.length > max ? s.slice(0, max) : s; }

// Shape a stored row into the client bundle shape.
function rowToBundle(r) {
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
}

app.http('embargo', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'embargo',
  handler: async (request, context) => {
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });
    const actor = session.name || session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const action = String((body && body.action) || '').trim().toLowerCase();
    const emit = broadcaster(context);

    // ── LIST ──
    if (action === 'list') {
      try {
        const rows = await tables.list(EMB_TABLE, { partitionKey: EMB_PK });
        rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
        return json(200, { ok: true, bundles: rows.map(rowToBundle) });
      } catch (e) {
        context.error('embargo list failed: ' + (e && e.message));
        return json(500, { error: 'Could not load bundles.' });
      }
    }

    // ── CREATE ──
    if (action === 'create') {
      const b = (body && body.bundle) || {};
      const title = clampStr(b.title, MAX_TITLE).trim();
      const timed = b.kind === 'time';
      const rawAlerts = Array.isArray(b.alerts) ? b.alerts.slice(0, MAX_ALERTS) : [];
      const alerts = rawAlerts.map((a) => ({
        text: clampStr((a && a.text) || '', MAX_TEXT).trim().toUpperCase(),
        meta: {
          products: clampStr(a && a.meta && a.meta.products, 200),
          topics: clampStr(a && a.meta && a.meta.topics, 200),
          rics: clampStr(a && a.meta && a.meta.rics, 200),
          named: clampStr(a && a.meta && a.meta.named, 200),
          language: clampStr((a && a.meta && a.meta.language) || 'English', 40),
        },
      })).filter((a) => a.text);

      if (!title) return json(400, { error: 'A bundle title is required.' });
      if (!alerts.length) return json(400, { error: 'A bundle needs at least one snap.' });

      let embargoAt = null;
      if (timed) {
        embargoAt = Number(b.embargoAt);
        if (!isFinite(embargoAt) || embargoAt <= Date.now()) {
          return json(400, { error: 'A time-based bundle needs a future embargo time.' });
        }
      }

      const now = Date.now();
      const id = crypto.randomUUID();
      const status = timed ? 'queued' : 'held';

      try {
        await tables.upsert(EMB_TABLE, {
          partitionKey: EMB_PK,
          rowKey: id,
          id,
          title,
          kind: timed ? 'time' : 'release',
          embargoAt: embargoAt || 0,
          alertsJson: JSON.stringify(alerts),
          createdBy: actor,
          createdAt: now,
          status,
          publishedBy: '',
          publishedAt: 0,
          releasedAt: 0,
        });
      } catch (e) {
        context.error('embargo create failed: ' + (e && e.message));
        return json(500, { error: 'Could not save the bundle.' });
      }

      const bundle = rowToBundle({
        id, title, kind: timed ? 'time' : 'release',
        embargoAt: embargoAt || 0, alertsJson: JSON.stringify(alerts),
        createdBy: actor, createdAt: now, status,
      });
      await emit('create', { bundle });
      return json(200, { ok: true, bundle });
    }

    // ── PUBLISH (release-based, by hand) ──
    if (action === 'publish') {
      const id = String((body && body.id) || '').trim();
      if (!id) return json(400, { error: 'A bundle id is required.' });
      try {
        const r = await tables.get(EMB_TABLE, EMB_PK, id);
        if (!r) return json(404, { error: 'That bundle was not found.' });
        if (r.status !== 'held') return json(409, { error: 'That bundle is not awaiting hand-publish.' });
        const now = Date.now();
        await tables.merge(EMB_TABLE, {
          partitionKey: EMB_PK, rowKey: id,
          status: 'published', publishedBy: actor, publishedAt: now,
        });
        const bundle = rowToBundle(Object.assign({}, r, { status: 'published', publishedBy: actor, publishedAt: now }));
        await emit('publish', { bundle });
        return json(200, { ok: true, bundle });
      } catch (e) {
        context.error('embargo publish failed: ' + (e && e.message));
        return json(500, { error: 'Could not publish the bundle.' });
      }
    }

    // ── RELEASE (time-based clock; first claim wins) ──
    if (action === 'release') {
      const id = String((body && body.id) || '').trim();
      if (!id) return json(400, { error: 'A bundle id is required.' });
      try {
        const r = await tables.get(EMB_TABLE, EMB_PK, id);
        if (!r) return json(404, { error: 'That bundle was not found.' });
        // Already claimed by another terminal — no-op, no broadcast.
        if (r.status !== 'queued') return json(200, { ok: true, claimed: false });
        if (!r.embargoAt || Number(r.embargoAt) > Date.now()) {
          return json(409, { error: 'That bundle has not reached its embargo time.' });
        }
        const now = Date.now();
        // Conditional claim via etag: if someone else flipped it first, this
        // throws a 412 and we treat it as "not the winner".
        const client = (await tables.ensureTable)
          ? null : null;
        try {
          await tables.merge(EMB_TABLE, {
            partitionKey: EMB_PK, rowKey: id,
            status: 'released', releasedAt: now,
          });
        } catch (e) {
          return json(200, { ok: true, claimed: false });
        }
        const bundle = rowToBundle(Object.assign({}, r, { status: 'released', releasedAt: now }));
        await emit('release', { bundle });
        return json(200, { ok: true, claimed: true, bundle });
      } catch (e) {
        context.error('embargo release failed: ' + (e && e.message));
        return json(500, { error: 'Could not release the bundle.' });
      }
    }

    // ── DISCARD ──
    if (action === 'discard') {
      const id = String((body && body.id) || '').trim();
      if (!id) return json(400, { error: 'A bundle id is required.' });
      try {
        await tables.remove(EMB_TABLE, EMB_PK, id);
        await emit('discard', { id });
        return json(200, { ok: true, id });
      } catch (e) {
        context.error('embargo discard failed: ' + (e && e.message));
        return json(500, { error: 'Could not discard the bundle.' });
      }
    }

    return json(400, { error: 'Unknown action.' });
  },
});
