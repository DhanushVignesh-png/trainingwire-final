// Training Wire — Embargo bundles (SHARED)
//
// An embargo is a bundle of snaps built ahead of the news. Two kinds, and the
// difference is only how they are let go:
//
//   TIME-BASED     "Embargo" ticked + a date/time. Queued. Shows on the
//                  Releases page straight away as PENDING and releases itself
//                  at the stated time.
//   RELEASE-BASED  "Embargo" unticked. Held with a Publish button, let go by
//                  hand when the company's own release crosses.
//
// SHARED, NOT LOCAL. Bundles used to live in this browser (TWStore) with
// client integer ids, so nobody else saw them and two people creating a bundle
// at once collided. Now every bundle is stored server-side with a UUID and
// broadcast, so the whole cohort sees one shared set and can publish or discard
// any of them. The composer below stays local until you file; filing calls the
// server through the controller's onCreate/onPublish/onDiscard callbacks.
//
// TIME-RELEASE IS SERVER-AUTHORITATIVE. The clock here does not flip a bundle
// itself — it asks the server to release it (onRelease). The server lets only
// the first terminal win, so twenty browsers ticking at once still produce
// exactly one "released" broadcast.
console.log('Training Wire: Embargo bundles (shared) loaded');

const Embargo = (() => {
  'use strict';

  const LANGS = ['English', 'French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Japanese', 'Chinese', 'Arabic', 'Russian'];
  const BLANK_META = { products: '', topics: '', rics: '', named: '', language: 'English' };

  const $ = (id) => document.getElementById(id);
  const esc = (t) => { if (t == null) return ''; const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; };

  let alerts = [];          // composer: [{ text, meta }]
  let bundles = [];         // shared, from the server: [{ id, title, kind, embargoAt, alerts, createdBy, createdAt, status, ... }]
  let metaHidden = false;
  let timer = null;
  let releasing = new Set(); // bundle ids we've already asked the server to release, so the clock doesn't spam

  // Callbacks into the controller — all hit the server.
  let onFile = null;        // (bundle) => void            put a released/published bundle on the Releases page
  let onCreate = null;      // (bundle) => Promise          store + broadcast a new bundle; resolves with the stored bundle (server id)
  let onPublishHeld = null; // (id) => Promise              release-based hand publish
  let onDiscard = null;     // (id) => Promise              remove for everyone
  let onReleaseDue = null;  // (id) => Promise<claimed>     time-release claim (first wins)
  let whoAmI = () => '—';

  // ── composer ────────────────────────────────────────────────────────────
  function blankAlert() { return { text: '', meta: { ...BLANK_META } }; }

  function resetComposer() {
    alerts = [blankAlert()];
    metaHidden = false;
    const t = $('embTitle'); if (t) t.value = '';
    const chk = $('embTimed'); if (chk) chk.checked = true;
    primeDateTime();
    renderAlerts();
    syncKind();
  }

  // Default the embargo to a few minutes out, which is what a desk does.
  function primeDateTime() {
    const d = new Date(Date.now() + 10 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const dEl = $('embDate'), tEl = $('embTime');
    if (dEl) dEl.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (tEl) tEl.value = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';
  }

  function isTimed() { return !!$('embTimed')?.checked; }

  function syncKind() {
    const timed = isTimed();
    ['embDate', 'embTime'].forEach(id => { const e = $(id); if (e) e.disabled = !timed; });
    const kind = $('embKind');
    if (kind) {
      kind.textContent = timed
        ? 'Time-based — releases itself at the time above'
        : 'Release-based — held until you publish it by hand';
    }
    const act = $('embAction');
    if (act) act.textContent = timed ? 'Queue Bundle' : 'Publish Bundle';
    const col = $('embCollapseAll');
    if (col) col.textContent = metaHidden ? 'Show metadata' : 'Hide metadata';
  }

  function renderAlerts() {
    const host = $('embAlerts'); if (!host) return;
    let h = '';
    alerts.forEach((a, i) => {
      h += '<div class="emb-alert" data-i="' + i + '">'
        + '<div class="emb-alert-top">'
        + '<span class="emb-n">' + (i + 1) + '</span>'
        + '<textarea class="emb-text" data-f="text" data-i="' + i + '" placeholder="SOURCE: SNAP TEXT…" spellcheck="false">' + esc(a.text) + '</textarea>'
        + '<button class="emb-mini" data-toggle="' + i + '">' + (metaHidden ? 'Meta' : 'Meta ▾') + '</button>'
        + (alerts.length > 1 ? '<button class="emb-mini del" data-del="' + i + '" title="Remove this alert">✕</button>' : '')
        + '</div>'
        + '<div class="emb-meta' + (metaHidden ? ' hid' : '') + '" data-meta="' + i + '">'
        + metaField(i, 'products', 'Products')
        + metaField(i, 'topics', 'Topics')
        + metaField(i, 'rics', 'RICs')
        + metaField(i, 'named', 'Named Items')
        + '<label>Language</label><select data-f="language" data-i="' + i + '">'
        + LANGS.map(l => '<option' + (a.meta.language === l ? ' selected' : '') + '>' + l + '</option>').join('')
        + '</select>'
        + '</div>'
        + '</div>';
    });
    host.innerHTML = h;

    host.querySelectorAll('[data-f]').forEach(el => {
      el.addEventListener('input', () => {
        const i = +el.dataset.i, f = el.dataset.f;
        if (f === 'text') alerts[i].text = el.value.toUpperCase();
        else alerts[i].meta[f] = el.value;
      });
      el.addEventListener('change', () => {
        const i = +el.dataset.i, f = el.dataset.f;
        if (f !== 'text') alerts[i].meta[f] = el.value;
      });
    });
    host.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
      const m = host.querySelector('[data-meta="' + b.dataset.toggle + '"]');
      if (m) { m.classList.toggle('hid'); b.textContent = m.classList.contains('hid') ? 'Meta' : 'Meta ▾'; }
    }));
    host.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      alerts.splice(+b.dataset.del, 1); renderAlerts();
    }));
  }

  function metaField(i, f, label) {
    return '<label>' + label + '</label><input type="text" data-f="' + f + '" data-i="' + i + '" value="'
      + esc(alerts[i].meta[f]) + '" placeholder="Click to enter" spellcheck="false">';
  }

  // The + button copies the latest alert, metadata and all — successive snaps
  // off one release share their metadata.
  function addAlert() {
    const last = alerts[alerts.length - 1];
    alerts.push(last ? { text: last.text, meta: { ...last.meta } } : blankAlert());
    renderAlerts();
    const host = $('embAlerts');
    const el = host?.querySelector('.emb-alert:last-child .emb-text');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }

  function toggleAllMeta() {
    metaHidden = !metaHidden;
    renderAlerts();
    syncKind();
  }

  // ── filing (server) ───────────────────────────────────────────────────────
  function embargoStamp() {
    const d = ($('embDate')?.value || '').trim();
    const t = ($('embTime')?.value || '').trim();
    if (!d || !t) return NaN;
    const ms = new Date(d + 'T' + (t.length === 5 ? t + ':00' : t)).getTime();
    return ms;
  }

  async function fileBundle() {
    const title = ($('embTitle')?.value || '').trim();
    const live = alerts.filter(a => (a.text || '').trim());
    const timed = isTimed();

    if (!title) { toastOut('Give the bundle a title — it is the headline on the Releases page', 'w'); $('embTitle')?.focus(); return; }
    if (!live.length) { toastOut('Add at least one snap before queueing', 'w'); return; }

    let at = null;
    if (timed) {
      at = embargoStamp();
      if (!isFinite(at)) { toastOut('Set a valid embargo date and time', 'w'); return; }
      if (at <= Date.now()) { toastOut('That embargo time has already passed', 'w'); return; }
    }

    // What we send up. The server stamps id, createdBy and createdAt.
    const draft = {
      title,
      kind: timed ? 'time' : 'release',
      embargoAt: timed ? at : null,
      alerts: live.map(a => ({ text: a.text.trim().toUpperCase(), meta: { ...a.meta } })),
    };

    const act = $('embAction');
    if (act) act.disabled = true;
    try {
      // onCreate stores it server-side and broadcasts; it resolves with the
      // stored bundle (carrying the server UUID and status). applyBundle then
      // folds it into the shared list and, for time-based, onto the wire.
      const stored = await onCreate?.(draft);
      if (stored) {
        applyBundle(stored);
        if (stored.kind === 'time') {
          toastOut('Bundle queued for everyone — ' + stored.alerts.length + ' snap' + (stored.alerts.length === 1 ? '' : 's') + ' at ' + fmt(stored.embargoAt), 's');
        } else {
          toastOut('Bundle held — publish it by hand when the release crosses', 'i');
        }
      }
      resetComposer();
      renderSaved();
    } catch (e) {
      toastOut('Could not save the bundle: ' + (e.message || 'try again'), 'r');
    } finally {
      if (act) act.disabled = false;
    }
  }

  // Release-based: the journalist saw the release land and let it go.
  async function publishHeld(id) {
    const b = bundles.find(x => x.id === id);
    if (!b || b.status !== 'held') return;
    try {
      const updated = await onPublishHeld?.(id);
      if (updated) { applyBundle(updated); }
      renderSaved();
      toastOut('Bundle published for everyone — ' + (b.alerts || []).length + ' snap' + ((b.alerts || []).length === 1 ? '' : 's'), 's');
    } catch (e) {
      toastOut('Could not publish the bundle: ' + (e.message || 'try again'), 'r');
    }
  }

  function loadIntoComposer(id) {
    const b = bundles.find(x => x.id === id);
    if (!b) return;
    $('embTitle').value = b.title;
    $('embTimed').checked = b.kind === 'time';
    if (b.embargoAt) {
      const d = new Date(b.embargoAt), pad = (n) => String(n).padStart(2, '0');
      $('embDate').value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      $('embTime').value = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    alerts = (b.alerts || []).map(a => ({ text: a.text, meta: { ...BLANK_META, ...(a.meta || {}) } }));
    if (!alerts.length) alerts = [blankAlert()];
    renderAlerts();
    syncKind();
    toastOut('Loaded into the composer as a copy — queueing makes a new bundle', 'i');
  }

  async function discard(id) {
    const b = bundles.find(x => x.id === id);
    if (!b) return;
    if (!window.confirm('Discard "' + b.title + '" for everyone?\n\nIt is removed from the shared list. Anything already published stays on the wire.')) return;
    try {
      await onDiscard?.(id);
      removeBundleLocally(id);
      renderSaved();
    } catch (e) {
      toastOut('Could not discard the bundle: ' + (e.message || 'try again'), 'r');
    }
  }

  function renderSaved() {
    const host = $('embSaved'); if (!host) return;
    if (!bundles.length) { host.innerHTML = ''; return; }
    let h = '<div class="emb-saved-h">Bundles (shared)</div>';
    bundles.forEach(b => {
      const pill = b.status === 'held' ? '<span class="emb-pill held">held</span>'
        : b.status === 'published' ? '<span class="emb-pill done">published</span>'
        : b.status === 'released' ? '<span class="emb-pill done">released</span>'
        : '<span class="emb-pill timed">queued</span>';
      const when = b.kind === 'time' ? fmt(b.embargoAt) : 'on release';
      const by = b.createdBy ? (' · ' + esc(b.createdBy)) : '';
      h += '<div class="emb-saved-row">'
        + pill
        + '<span class="emb-saved-t">' + esc(b.title) + '</span>'
        + '<span class="emb-saved-m">' + (b.alerts || []).length + ' snap' + ((b.alerts || []).length === 1 ? '' : 's') + ' · ' + esc(when) + by + '</span>'
        + (b.status === 'held' ? '<button class="emb-saved-btn" data-pub="' + esc(b.id) + '">Publish</button>' : '')
        + '<button class="emb-saved-btn ghost" data-load="' + esc(b.id) + '" title="Copy into the composer">Copy</button>'
        + '<button class="emb-saved-btn ghost" data-del="' + esc(b.id) + '" title="Discard for everyone">✕</button>'
        + '</div>';
    });
    host.innerHTML = h;
    host.querySelectorAll('[data-pub]').forEach(b => b.addEventListener('click', () => publishHeld(b.dataset.pub)));
    host.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', () => loadIntoComposer(b.dataset.load)));
    host.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => discard(b.dataset.del)));
  }

  function fmt(ts) {
    if (!ts) return '—';
    const d = new Date(ts), pad = (n) => String(n).padStart(2, '0');
    return pad(d.getDate()) + ' ' + d.toLocaleString('en-GB', { month: 'short' }).toUpperCase() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function toastOut(msg, type) { try { window.toast?.(msg, type); } catch (e) { console.log(msg); } }

  // ── shared-state application ──────────────────────────────────────────────
  // Fold one bundle (from a snapshot, a create, a broadcast, etc.) into the
  // shared list, newest first, and put it on the wire when appropriate.
  function applyBundle(b) {
    if (!b || !b.id) return;
    const i = bundles.findIndex(x => x.id === b.id);
    if (i >= 0) bundles[i] = b; else bundles.unshift(b);
    bundles.sort((a, c) => Number(c.createdAt || 0) - Number(a.createdAt || 0));
    // Time-based bundles belong on the Releases page straight away (PENDING),
    // then update in place when released. Release-based only appear once
    // published by hand — until then they are held, off the wire.
    if (b.kind === 'time' || b.status === 'published' || b.status === 'released') {
      onFile?.(b);
    }
    renderSaved();
  }

  function removeBundleLocally(id) {
    bundles = bundles.filter(x => x.id !== id);
    releasing.delete(id);
    renderSaved();
  }

  // Replace the whole shared list from a server snapshot (sign-in / reconnect).
  function applySnapshot(list) {
    bundles = (Array.isArray(list) ? list.slice() : [])
      .sort((a, c) => Number(c.createdAt || 0) - Number(a.createdAt || 0));
    renderSaved();
    // Put everything that is on the wire (queued time-based + published +
    // released) back on the Releases page. Oldest first, because the blotter
    // puts the newest arrival on top.
    bundles.slice().reverse().forEach(b => {
      if (b.kind === 'time' || b.status === 'published' || b.status === 'released') onFile?.(b);
    });
  }

  // A broadcast arrived (someone created/published/released/discarded a bundle).
  function onBroadcast(p) {
    if (!p || !p.sub) return;
    if (p.sub === 'discard') { removeBundleLocally(p.id); return; }
    if (p.bundle) applyBundle(p.bundle);
  }

  // ── the clock: asks the SERVER to release due bundles (first wins) ─────────
  function tick() {
    const now = Date.now();
    for (const b of bundles) {
      if (b.kind === 'time' && b.status === 'queued' && b.embargoAt && b.embargoAt <= now && !releasing.has(b.id)) {
        releasing.add(b.id);
        Promise.resolve(onReleaseDue?.(b.id))
          .then((claimed) => {
            // If we didn't win the race, another terminal's broadcast will flip
            // it for us. Either way we stop asking.
            if (!claimed) releasing.delete(b.id);  // allow a retry if the server said "not yet"
          })
          .catch(() => { releasing.delete(b.id); });
      }
    }
  }

  // ── float: drag + resize ────────────────────────────────────────────────
  function initFloat() {
    const panel = $('embFloat'), header = $('embHeader'), grip = $('embResize');
    if (!panel || !header) return;

    let dragging = false, dx = 0, dy = 0;
    header.addEventListener('mousedown', e => {
      if (e.target.id === 'embClose' || e.target.id === 'embTitle') return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      document.body.style.cursor = 'move'; e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - 120)) + 'px';
      panel.style.top = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - 40)) + 'px';
    });
    window.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.cursor = ''; } });

    if (grip) {
      let rz = false, sw = 0, sh = 0, sx = 0, sy = 0;
      grip.addEventListener('mousedown', e => {
        rz = true; const r = panel.getBoundingClientRect();
        sw = r.width; sh = r.height; sx = e.clientX; sy = e.clientY;
        document.body.style.cursor = 'nwse-resize'; e.preventDefault(); e.stopPropagation();
      });
      window.addEventListener('mousemove', e => {
        if (!rz) return;
        panel.style.width = Math.max(460, Math.min(sw + (e.clientX - sx), window.innerWidth - 20)) + 'px';
        panel.style.height = Math.max(300, Math.min(sh + (e.clientY - sy), window.innerHeight - 20)) + 'px';
      });
      window.addEventListener('mouseup', () => { if (rz) { rz = false; document.body.style.cursor = ''; } });
    }
  }

  // ── api ─────────────────────────────────────────────────────────────────
  function init(opts) {
    onFile = opts?.onFile || null;
    onCreate = opts?.onCreate || null;
    onPublishHeld = opts?.onPublishHeld || null;
    onDiscard = opts?.onDiscard || null;
    onReleaseDue = opts?.onReleaseDue || null;
    whoAmI = opts?.whoAmI || (() => '—');

    $('embAdd')?.addEventListener('click', addAlert);
    $('embAction')?.addEventListener('click', fileBundle);
    $('embTimed')?.addEventListener('change', syncKind);
    $('embCollapseAll')?.addEventListener('click', toggleAllMeta);
    $('embClose')?.addEventListener('click', close);
    initFloat();

    resetComposer();
    renderSaved();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000);
  }

  function open() {
    const p = $('embFloat'); if (!p) return;
    p.style.display = 'flex';
    if (!alerts.length) resetComposer();
    renderSaved();
    setTimeout(() => { if (!$('embTitle')?.value) $('embTitle')?.focus(); }, 40);
  }
  function close() { const p = $('embFloat'); if (p) p.style.display = 'none'; }
  function isOpen() { const p = $('embFloat'); return !!p && p.style.display !== 'none'; }

  return {
    init, open, close, isOpen,
    all: () => bundles.slice(),
    applySnapshot, applyBundle, onBroadcast, removeBundleLocally,
  };
})();

if (typeof window !== 'undefined') window.Embargo = Embargo;
