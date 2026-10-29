// FILE: frontend/templates-stitch.js
// Training Wire — Template Editor + wire context feed.
//
// Self-contained add-on. Reads globals the app already exposes (WireSync,
// toast) and the DOM that index.html (Drop 3) defines.
//
// Stitching and wire-number search are NOT handled here — they live inside
// terminal.js's own captureSelection() / renderBlotter() (patches 4C-4, 4C-1,
// 4C-3), because the reader already owns the selection gesture and the blotter
// already owns Find. Duplicating them here caused double-fire. This file now
// owns only: the Template Editor, and keeping ~selected~ / ~company~ in step
// via setSelected()/setContext(), which terminal.js calls.
//
// TEMPLATES: per-user, server-backed. A template body holds two tokens:
//   ~company~   the open release's source
//   ~selected~  the current highlight (~copied~ accepted as a silent alias)
// Each saved template renders as a row with a live preview and its own Publish,
// enabled only once it resolves.
'use strict';

const TemplatesStitch = (() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_BODY = 240;

  const TOK_COMPANY = /~company~/gi;
  const TOK_SELECTED = /~selected~|~copied~/gi;

  let templates = [];
  let editingId = null;
  let loaded = false;

  let currentCompany = '';
  let currentSelected = '';

  // terminal.js calls this when a release is opened (selectStory, patch 4C-5).
  function setContext(ctx) {
    if (ctx && typeof ctx.company === 'string') currentCompany = ctx.company.trim();
    renderContextBar();
    renderRows();
  }

  // terminal.js calls this from captureSelection (patch 4C-4) on every
  // highlight, so ~selected~ tracks the live selection.
  function setSelected(text) {
    currentSelected = String(text || '').replace(/\s+/g, ' ').trim();
    if ($('dockTemplate')?.classList.contains('on')) renderRows();
  }

  // Fallback source read if setContext was never called.
  function sniffCompany() {
    if (currentCompany) return currentCompany;
    const co = document.querySelector('#readerSub .co');
    return co ? co.textContent.trim() : '';
  }

  // ── TOKEN RESOLUTION ──
  // Returns { text, resolved }; resolved is false while a token has nothing to
  // fill it, so the row's Publish stays disabled.
  function resolve(body) {
    const company = sniffCompany();
    const selected = currentSelected;
    let resolved = true;
    let out = String(body || '');
    if (TOK_COMPANY.test(out)) { TOK_COMPANY.lastIndex = 0; if (!company) resolved = false; }
    if (TOK_SELECTED.test(out)) { TOK_SELECTED.lastIndex = 0; if (!selected) resolved = false; }
    out = out.replace(TOK_COMPANY, company || '').replace(TOK_SELECTED, selected || '');
    out = out.replace(/\s+/g, ' ').trim().toUpperCase();
    if (out.length > MAX_BODY) out = out.slice(0, MAX_BODY);
    const hasTokens = /~company~|~selected~|~copied~/i.test(body || '');
    return { text: out, resolved: hasTokens ? (resolved && !!out) : !!out };
  }

  // ── SERVER CRUD ──
  async function load() {
    try {
      const res = await WireSync.listTemplates();
      templates = (res && res.templates) || [];
      loaded = true;
      renderRows();
    } catch (e) {
      console.warn('templates load failed: ' + (e && e.message));
    }
  }

  async function saveTemplate() {
    const title = ($('tplTitle')?.value || '').trim();
    const body = ($('tplBodyIn')?.value || '').trim();
    if (!title) { toastOut('Give the template a title', 'w'); $('tplTitle')?.focus(); return; }
    if (!body) { toastOut('The template needs a body', 'w'); $('tplBodyIn')?.focus(); return; }

    const payload = { title, body };
    if (editingId) payload.id = editingId;

    const btn = $('tplSave'); if (btn) btn.disabled = true;
    try {
      const res = await WireSync.saveTemplate(payload);
      const saved = res && res.template;
      if (saved) {
        const i = templates.findIndex(t => t.id === saved.id);
        if (i >= 0) templates[i] = saved; else templates.push(saved);
      }
      closeEditor();
      renderRows();
      toastOut(editingId ? 'Template updated' : 'Template saved', 's');
    } catch (e) {
      toastOut('Could not save: ' + (e.message || 'try again'), 'r');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function removeTemplate(id) {
    const t = templates.find(x => x.id === id);
    if (!t) return;
    if (!window.confirm('Delete template "' + t.title + '"?')) return;
    try {
      await WireSync.deleteTemplate(id);
      templates = templates.filter(x => x.id !== id);
      renderRows();
    } catch (e) {
      toastOut('Could not delete: ' + (e.message || 'try again'), 'r');
    }
  }

  // ── PUBLISH A TEMPLATE ROW ──
  // Fast path into the Alert Editor: fill it, then click the real Publish so
  // every downstream rule (chain id, auto-flag, length cap, author stamp) runs
  // the one path. We never call the publish API directly here.
  function publishRow(id) {
    const t = templates.find(x => x.id === id);
    if (!t) return;
    const { text, resolved } = resolve(t.body);
    if (!resolved) { toastOut('Nothing to fill the template with yet — select text in the release', 'w'); return; }
    const ae = $('aeBody');
    if (!ae) return;
    ae.value = text;
    ae.dispatchEvent(new Event('input', { bubbles: true }));
    $('aePublish')?.click();
  }

  // ── RENDER ──
  const esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };

  function renderContextBar() {
    const el = $('tplCtx');
    if (!el) return;
    const co = sniffCompany();
    el.innerHTML = co ? ('Source: <b>' + esc(co) + '</b>') : 'No release open';
  }

  function renderRows() {
    const host = $('tplList');
    if (!host) return;
    if (!loaded && !templates.length) { host.innerHTML = '<div class="tpl-empty">Loading…</div>'; return; }
    if (!templates.length) {
      host.innerHTML = '<div class="tpl-empty">No templates yet. Click <b>＋ New Template</b> and use the <code>~company~</code> and <code>~selected~</code> placeholders.</div>';
      return;
    }
    let h = '';
    for (const t of templates) {
      const { text, resolved } = resolve(t.body);
      const previewCls = resolved ? 'tpl-preview' : 'tpl-preview empty';
      const preview = text || t.body.toUpperCase();
      h += '<div class="tpl-row" data-id="' + esc(t.id) + '">'
        + '<div class="tpl-row-title" title="' + esc(t.title) + '">' + esc(t.title) + '</div>'
        + '<div class="' + previewCls + '" title="' + esc(preview) + '">' + esc(preview) + '</div>'
        + '<span class="tpl-row-cc' + (text.length > MAX_BODY ? ' over' : '') + '">' + text.length + ' chars</span>'
        + '<button class="tpl-pub" data-pub="' + esc(t.id) + '"' + (resolved ? '' : ' disabled') + '>Publish</button>'
        + '<div class="tpl-row-tools">'
        + '<button class="tpl-mini" data-edit="' + esc(t.id) + '" title="Edit">✎</button>'
        + '<button class="tpl-mini del" data-del="' + esc(t.id) + '" title="Delete">✕</button>'
        + '</div>'
        + '</div>';
    }
    host.innerHTML = h;
    host.querySelectorAll('[data-pub]').forEach(b => b.addEventListener('click', () => publishRow(b.dataset.pub)));
    host.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditor(b.dataset.edit)));
    host.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => removeTemplate(b.dataset.del)));
  }

  // ── composer open/close ──
  function openEditor(id) {
    editingId = id || null;
    const ed = $('tplEditor');
    const t = id ? templates.find(x => x.id === id) : null;
    if ($('tplTitle')) $('tplTitle').value = t ? t.title : '';
    if ($('tplBodyIn')) $('tplBodyIn').value = t ? t.body : '';
    updateEdCount();
    if (ed) ed.style.display = 'block';
    $('tplTitle')?.focus();
  }
  function closeEditor() {
    editingId = null;
    if ($('tplEditor')) $('tplEditor').style.display = 'none';
    if ($('tplTitle')) $('tplTitle').value = '';
    if ($('tplBodyIn')) $('tplBodyIn').value = '';
  }
  function updateEdCount() {
    const el = $('tplEdCount'), body = $('tplBodyIn');
    if (el && body) el.textContent = body.value.length + ' chars';
  }
  function insertToken(tok) {
    const ta = $('tplBodyIn');
    if (!ta) return;
    const s = ta.selectionStart || ta.value.length;
    const e = ta.selectionEnd || ta.value.length;
    ta.value = ta.value.slice(0, s) + tok + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + tok.length;
    updateEdCount();
  }

  // ── TAB SWITCHING (Alert Editor | Template Editor) ──
  function showTab(which) {
    const alertOn = which !== 'template';
    $('aeDockTab')?.classList.toggle('on', alertOn);
    $('tplDockTab')?.classList.toggle('on', !alertOn);
    $('dockAlert')?.classList.toggle('on', alertOn);
    $('dockTemplate')?.classList.toggle('on', !alertOn);
    if (!alertOn) { renderContextBar(); renderRows(); if (!loaded) load(); }
  }

  function toastOut(msg, type) { try { window.toast?.(msg, type); } catch (e) { console.log(msg); } }

  // ── WIRING ──
  function init() {
    $('aeDockTab')?.addEventListener('click', () => showTab('alert'));
    $('tplDockTab')?.addEventListener('click', () => showTab('template'));

    $('tplNew')?.addEventListener('click', () => openEditor(null));
    $('tplCancel')?.addEventListener('click', closeEditor);
    $('tplSave')?.addEventListener('click', saveTemplate);
    $('tplBodyIn')?.addEventListener('input', updateEdCount);
    document.querySelectorAll('.tpl-chip[data-ins]').forEach(b =>
      b.addEventListener('click', () => insertToken(b.dataset.ins)));

    renderContextBar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { setContext, setSelected, load, showTab, _resolve: resolve };
})();

if (typeof window !== 'undefined') window.TemplatesStitch = TemplatesStitch;
