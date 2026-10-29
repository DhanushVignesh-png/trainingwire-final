// FILE: api/src/functions/templates.js
// Training Wire — POST /api/templates
//
// Per-user snap templates. A template is a reusable snap pattern with two
// placeholder tokens the client fills at publish time:
//
//   ~company~   — the release's source (entered by the uploader on inject)
//   ~selected~  — the text the journalist has highlighted in the reader
//
// e.g.  "~company~: Q2 REVENUE $~selected~ MLN"
//
// PER USER, NOT SHARED. Unlike releases/embargoes (one shared set for the whole
// cohort), templates belong to the person who made them. They are partitioned
// by the owner's email so one trainee never sees, edits, or deletes another's.
// Stored server-side rather than in localStorage so they follow the user from
// one training machine to the next.
//
// Actions (one endpoint, matching embargo.js house style):
//   POST /api/templates  { action:'list' }                      -> this user's templates
//   POST /api/templates  { action:'save', template }            -> upsert + return stored
//   POST /api/templates  { action:'delete', id }                -> remove
//
// NO BROADCAST. These are private; there is nothing to push to other terminals.
'use strict';

const { app } = require('@azure/functions');
const crypto = require('crypto');
const { TABLES } = require('../shared/config');
const { getSession, json } = require('../shared/auth');
const tables = require('../shared/tables');

const MAX_TITLE = 60;
const MAX_BODY = 240;           // matches MAX_ALERT_LENGTH ceiling
const MAX_TEMPLATES = 60;       // a sane per-user cap

function clampStr(v, max) {
  const s = String(v == null ? '' : v);
  return s.length > max ? s.slice(0, max) : s;
}

// Shape a stored row into the client template shape.
function rowToTemplate(r) {
  return {
    id: r.id,
    title: r.title || '',
    body: r.body || '',
    createdAt: Number(r.createdAt || 0),
    updatedAt: Number(r.updatedAt || 0),
  };
}

app.http('templates', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'templates',
  handler: async (request, context) => {
    const session = getSession(request);
    if (!session) return json(401, { error: 'Unauthorized.' });
    // The owner key is the EMAIL (session.sub), never the display name — two
    // people can share a display name, and names can change.
    const owner = session.sub;

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON body.' }); }

    const action = String((body && body.action) || '').trim().toLowerCase();

    // ── LIST ──
    if (action === 'list') {
      try {
        const rows = await tables.list(TABLES.TEMPLATES, { partitionKey: owner });
        rows.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
        return json(200, { ok: true, templates: rows.map(rowToTemplate) });
      } catch (e) {
        context.error('templates list failed: ' + (e && e.message));
        return json(500, { error: 'Could not load your templates.' });
      }
    }

    // ── SAVE (create or update) ──
    if (action === 'save') {
      const t = (body && body.template) || {};
      const title = clampStr(t.title, MAX_TITLE).trim();
      // Body is stored exactly as authored (placeholders intact). It is only
      // ever rendered client-side through the existing escaping path, and the
      // publish endpoint re-caps length server-side, so no HTML risk here.
      const tBody = clampStr(t.body, MAX_BODY);
      const idIn = String((t.id) || '').trim();

      if (!title) return json(400, { error: 'A template needs a title.' });
      if (!tBody.trim()) return json(400, { error: 'A template needs a body.' });

      const now = Date.now();

      try {
        // Update path: the row must already belong to THIS user (partition),
        // so a forged id from another user cannot overwrite their template.
        if (idIn) {
          const existing = await tables.get(TABLES.TEMPLATES, owner, idIn);
          if (existing) {
            await tables.merge(TABLES.TEMPLATES, {
              partitionKey: owner,
              rowKey: idIn,
              title,
              body: tBody,
              updatedAt: now,
            });
            return json(200, {
              ok: true,
              template: rowToTemplate(Object.assign({}, existing, { title, body: tBody, updatedAt: now })),
            });
          }
          // id given but not found for this user → fall through and create new.
        }

        // Create path: enforce the per-user cap.
        const rows = await tables.list(TABLES.TEMPLATES, { partitionKey: owner });
        if (rows.length >= MAX_TEMPLATES) {
          return json(400, { error: `You have reached the limit of ${MAX_TEMPLATES} templates. Delete one first.` });
        }

        const id = crypto.randomUUID();
        await tables.upsert(TABLES.TEMPLATES, {
          partitionKey: owner,
          rowKey: id,
          id,
          title,
          body: tBody,
          createdAt: now,
          updatedAt: now,
        });
        return json(200, { ok: true, template: { id, title, body: tBody, createdAt: now, updatedAt: now } });
      } catch (e) {
        context.error('templates save failed: ' + (e && e.message));
        return json(500, { error: 'Could not save the template.' });
      }
    }

    // ── DELETE ──
    if (action === 'delete') {
      const id = String((body && body.id) || '').trim();
      if (!id) return json(400, { error: 'A template id is required.' });
      try {
        // Scoped to this user's partition, so you can only ever delete your own.
        await tables.remove(TABLES.TEMPLATES, owner, id);
        return json(200, { ok: true, id });
      } catch (e) {
        context.error('templates delete failed: ' + (e && e.message));
        return json(500, { error: 'Could not delete the template.' });
      }
    }

    return json(400, { error: 'Unknown action.' });
  },
});
