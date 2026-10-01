// Training Wire — Embargo bundles
//
// An embargo is a bundle of snaps built one after another, ahead of the news.
// Two kinds, and the difference is only how they are let go:
//
//   TIME-BASED     "Embargo" ticked + a date/time. Queued. It shows on the
//                  Releases page straight away as PENDING and releases itself
//                  at the stated time.
//   RELEASE-BASED  "Embargo" unticked. Held in this panel with a Publish
//                  button. Some companies embargo against their own release
//                  rather than a clock, so the journalist watches the Releases
//                  page and publishes it by hand when the release crosses.
//
// The panel floats and is draggable for exactly that reason — you need to
// watch the wire and the bundle at the same time.
//
// This module owns the composer and the bundle list. Filing is handed back to
// the controller through the onFile callback, which is what actually puts a
// row on the Releases page.
console.log('Training Wire: Embargo bundles loaded');

const Embargo = (() => {
  'use strict';

  const KEY = 'nw_bundles';
  const LANGS = ['English', 'French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Japanese', 'Chinese', 'Arabic', 'Russian'];
  const BLANK_META = { products: '', topics: '', rics: '', named: '', language: 'English' };

  const $ = (id) => document.getElementById(id);
  const esc = (t) => { if (t == null) return ''; const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; };

  let alerts = [];          // [{ text, meta }]
  let bundles = [];         // saved: [{ id, title, kind, embargoAt, alerts, createdBy, createdAt, status }]
  let metaHidden = false;
  let nextBundleId = 1;
  let timer = null;

  let onFile = null;        // (bundle) => void   — puts it on the Releases page
  let whoAmI = () => '—';

  // ── persistence ─────────────────────────────────────────────────────────
  function save() { TWStore.set({ [KEY]: { bundles, nextBundleId } }); }
  function load(cb) {
    TWStore.get([KEY], r => {
      const d = r[KEY];
      if (d && Array.isArray(d.bundles)) { bundles = d.bundles; nextBundleId = d.nextBundleId || (bundles.length + 1); }
      cb?.();
    });
  }

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

  // Default the embargo to the next round minute, which is what a desk does.
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

  // The + button: an exact copy of the latest alert, metadata included, which
  // is the point — successive snaps off one release share their metadata.
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

  // ── filing ──────────────────────────────────────────────────────────────
  function embargoStamp() {
    const d = ($('embDate')?.value || '').trim();
    const t = ($('embTime')?.value || '').trim();
    if (!d || !t) return NaN;
    const ms = new Date(d + 'T' + (t.length === 5 ? t + ':00' : t)).getTime();
    return ms;
  }

  function fileBundle() {
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

    const bundle = {
      id: nextBundleId++,
      title,
      kind: timed ? 'time' : 'release',
      embargoAt: at,
      alerts: live.map(a => ({ text: a.text.trim().toUpperCase(), meta: { ...a.meta } })),
      createdBy: whoAmI(),
      createdAt: Date.now(),
      status: timed ? 'queued' : 'held'
    };
    bundles.unshift(bundle);
    save();

    if (timed) {
      // Goes onto the Releases page now, marked PENDING, and lets itself go at
      // the embargo time.
      onFile?.(bundle);
      toastOut('Bundle queued — ' + bundle.alerts.length + ' snap' + (bundle.alerts.length === 1 ? '' : 's') + ' at ' + fmt(at), 's');
    } else {
      toastOut('Bundle held — publish it by hand when the release crosses', 'i');
    }
    resetComposer();
    renderSaved();
  }

  // Release-based: the journalist saw the release land and let it go.
  function publishHeld(id) {
    const b = bundles.find(x => x.id === id);
    if (!b || b.status !== 'held') return;
    b.status = 'published';
    b.publishedAt = Date.now();
    b.publishedBy = whoAmI();
    save();
    onFile?.(b);
    renderSaved();
    toastOut('Bundle published — ' + b.alerts.length + ' snap' + (b.alerts.length === 1 ? '' : 's'), 's');
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
    alerts = b.alerts.map(a => ({ text: a.text, meta: { ...BLANK_META, ...a.meta } }));
    if (!alerts.length) alerts = [blankAlert()];
    renderAlerts();
    syncKind();
    toastOut('Loaded into the composer as a copy — queueing makes a new bundle', 'i');
  }

  function discard(id) {
    const b = bundles.find(x => x.id === id);
    if (!b) return;
    if (!window.confirm('Discard "' + b.title + '"?\n\nIt is removed from this list. Anything already published stays on the wire.')) return;
    bundles = bundles.filter(x => x.id !== id);
    save();
    renderSaved();
  }

  function renderSaved() {
    const host = $('embSaved'); if (!host) return;
    if (!bundles.length) { host.innerHTML = ''; return; }
    let h = '<div class="emb-saved-h">Bundles</div>';
    bundles.forEach(b => {
      const pill = b.status === 'held' ? '<span class="emb-pill held">held</span>'
        : b.status === 'published' ? '<span class="emb-pill done">published</span>'
        : b.status === 'released' ? '<span class="emb-pill done">released</span>'
        : '<span class="emb-pill timed">queued</span>';
      const when = b.kind === 'time' ? fmt(b.embargoAt) : 'on release';
      h += '<div class="emb-saved-row">'
        + pill
        + '<span class="emb-saved-t">' + esc(b.title) + '</span>'
        + '<span class="emb-saved-m">' + b.alerts.length + ' snap' + (b.alerts.length === 1 ? '' : 's') + ' · ' + esc(when) + '</span>'
        + (b.status === 'held' ? '<button class="emb-saved-btn" data-pub="' + b.id + '">Publish</button>' : '')
        + '<button class="emb-saved-btn ghost" data-load="' + b.id + '" title="Copy into the composer">Copy</button>'
        + '<button class="emb-saved-btn ghost" data-del="' + b.id + '" title="Discard">✕</button>'
        + '</div>';
    });
    host.innerHTML = h;
    host.querySelectorAll('[data-pub]').forEach(b => b.addEventListener('click', () => publishHeld(+b.dataset.pub)));
    host.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', () => loadIntoComposer(+b.dataset.load)));
    host.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => discard(+b.dataset.del)));
  }

  function fmt(ts) {
    if (!ts) return '—';
    const d = new Date(ts), pad = (n) => String(n).padStart(2, '0');
    return pad(d.getDate()) + ' ' + d.toLocaleString('en-GB', { month: 'short' }).toUpperCase() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function toastOut(msg, type) { try { window.toast?.(msg, type); } catch (e) { console.log(msg); } }

  // ── the clock that lets queued bundles go ───────────────────────────────
  function tick() {
    const now = Date.now();
    let changed = false;
    bundles.forEach(b => {
      if (b.kind === 'time' && b.status === 'queued' && b.embargoAt && b.embargoAt <= now) {
        b.status = 'released';
        b.releasedAt = now;
        changed = true;
        window.onEmbargoReleased?.(b);
      }
    });
    if (changed) { save(); renderSaved(); }
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
    whoAmI = opts?.whoAmI || (() => '—');

    $('embAdd')?.addEventListener('click', addAlert);
    $('embAction')?.addEventListener('click', fileBundle);
    $('embTimed')?.addEventListener('change', syncKind);
    $('embCollapseAll')?.addEventListener('click', toggleAllMeta);
    $('embClose')?.addEventListener('click', close);
    initFloat();

    load(() => {
      renderSaved();
      // Bundles outlive a reload, so anything already let go has to be put
      // back on the Releases page with them. Held ones are off the wire by
      // definition — they are waiting for a human. Oldest first, because the
      // blotter puts the newest arrival on top.
      bundles.slice().reverse().forEach(b => { if (b.status !== 'held') onFile?.(b); });
      tick();
    });
    resetComposer();
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

  return { init, open, close, isOpen, all: () => bundles.slice() };
})();

if (typeof window !== 'undefined') window.Embargo = Embargo;
