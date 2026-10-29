// FILE: frontend/templates-stitch.js
// Training Wire — Template Editor, Stitching, and wire-number search.
//
// Self-contained add-on. It reads globals the rest of the app already exposes
// (WireSync, Auth, toast) and the DOM that index.html (Drop 3) defines. Nothing
// here owns release state; it only reads the current selection/source and the
// current Alert Editor contents, which is exactly what templates and stitching
// operate on.
//
// THREE JOBS:
//   1) TEMPLATES  — per-user, server-backed. A template body holds the tokens
//                   ~company~ (the open release's source) and ~selected~ (the
//                   current highlight; ~copied~ accepted as a silent alias).
//                   Each saved template renders as a row with a live preview
//                   and its own Publish, enabled only once it resolves.
//   2) STITCHING  — holding Ctrl (or Cmd) while selecting APPENDS the selection
//                   to the Alert Editor instead of replacing it, so several
//                   fragments can be assembled into one snap. A plain select
//                   still replaces, which is the existing behaviour.
//   3) WIRE SEARCH— the blotter's Find box already filters on headline/source;
//                   this also matches a release's wire number (1–100) so a
//                   trainer can say "pull up 42" and everyone types 42.
'use strict';

const TemplatesStitch = (() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_BODY = 240;

  // Canonical tokens, plus the ~copied~ alias from the original brief.
  const TOK_COMPANY = /~company~/gi;
  const TOK_SELECTED = /~selected~|~copied~/gi;

  let templates = [];          // [{ id, title, body }]
  let editingId = null;        // template id being edited, or null for a new one
  let loaded = false;

  // ── live context the templates resolve against ──
  // company: the source of the currently open release (set by terminal.js when
  //          a release is opened — we read it off the reader each time).
  // selected: the live selection text, kept current on every selection change.
  let currentCompany = '';
  let currentSelected = '';

  // terminal.js already keeps the open release; expose a tiny hook it can call.
  function setContext(ctx) {
    if (ctx && typeof ctx.company === 'string') currentCompany = ctx.company.trim();
    renderContextBar();
    renderRows();
  }

  // Read the current source straight off the reader subline as a fallback, so
  // this works even if terminal.js never calls setContext.
  function sniffCompany() {
    if (currentCompany) return currentCompany;
    const co = document.querySelector('#readerSub .co');
    return co ? co.textContent.trim() : '';
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOKEN RESOLUTION
  // ════════════════════════════════════════════════════════════════════════
  // Returns { text, resolved } where resolved is false when a token still has
  // no value to fill (so the row's Publish stays disabled).
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
    // A template with no tokens at all is always publishable.
    const hasTokens = /~company~|~selected~|~copied~/i.test(body || '');
    return { text: out, resolved: hasTokens ? (resolved && !!out) : !!out };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SERVER CRUD
  // ════════════════════════════════════════════════════════════════════════
  async function load() {
    try {
      const res = await WireSync.listTemplates();
      templates = (res && res.templates) || [];
      loaded = true;
      renderRows();
    } catch (e) {
      // Not fatal — the editor still works, just empty.
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

  // ════════════════════════════════════════════════════════════════════════
  //  PUBLISH A TEMPLATE ROW
  // ════════════════════════════════════════════════════════════════════════
  // Templates are a FAST PATH INTO THE ALERT EDITOR. Publishing a row fills the
  // Alert Editor with the resolved text and clicks the existing Publish button,
  // so every downstream rule (chain id, auto-flagging, length cap, author
  // stamping) is the one path, untouched. We never call the publish API here.
  function publishRow(id) {
    const t = templates.find(x => x.id === id);
    if (!t) return;
    const { text, resolved } = resolve(t.body);
    if (!resolved) { toastOut('Nothing to fill the template with yet — select text in the release', 'w'); return; }
    const ae = $('aeBody');
    if (!ae) return;
    ae.value = text;
    ae.dispatchEvent(new Event('input', { bubbles: true }));  // refresh char count
    $('aePublish')?.click();                                   // reuse the one publish path
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ════════════════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════════════════
  //  TAB SWITCHING (Alert Editor | Template Editor)
  // ════════════════════════════════════════════════════════════════════════
  function showTab(which) {
    const alertOn = which !== 'template';
    $('aeDockTab')?.classList.toggle('on', alertOn);
    $('tplDockTab')?.classList.toggle('on', !alertOn);
    $('dockAlert')?.classList.toggle('on', alertOn);
    $('dockTemplate')?.classList.toggle('on', !alertOn);
    if (!alertOn) { renderContextBar(); renderRows(); if (!loaded) load(); }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  STITCHING
  // ════════════════════════════════════════════════════════════════════════
  // On mouseup inside the reader body: if Ctrl/Cmd was held and there IS a
  // selection, APPEND it to the Alert Editor (space-joined) instead of letting
  // the normal replace behaviour run. A plain selection is left entirely to
  // terminal.js's existing handler, so default behaviour is unchanged.
  function selectionText() {
    const sel = window.getSelection();
    return sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
  }

  function appendToEditor(fragment) {
    const ae = $('aeBody');
    if (!ae || !fragment) return;
    const cur = ae.value.trim();
    // Join with a single space; the editor upper-cases via CSS/engine already.
    ae.value = cur ? (cur + ' ' + fragment) : fragment;
    ae.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onReaderMouseUp(ev) {
    // Ctrl on Win/Linux, Cmd on Mac. A bare Ctrl+click with no drag selects
    // nothing, so the empty-selection guard stops a stray append.
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const frag = selectionText();
    if (!frag) return;
    // Stop terminal.js's own selection handler from also replacing the editor
    // for this same gesture.
    ev.stopPropagation();
    appendToEditor(frag);
    // Clear the selection so the next ctrl-select starts clean.
    const sel = window.getSelection(); if (sel) sel.removeAllRanges();
  }

  // Keep the live selection current for template resolution. Plain selections
  // are captured here too (read-only), without interfering with terminal.js.
  function onSelectionChange() {
    const frag = selectionText();
    // Only track selections that originate in the reader body.
    const sel = window.getSelection();
    if (sel && sel.anchorNode && $('readerBody') && $('readerBody').contains(sel.anchorNode)) {
      currentSelected = frag;
      // Live-refresh template previews if the Template tab is showing.
      if ($('dockTemplate')?.classList.contains('on')) renderRows();
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  WIRE-NUMBER SEARCH (augments the existing Find box)
  // ════════════════════════════════════════════════════════════════════════
  // The blotter rows carry data-wireno (written by the blotter edit in 4B).
  // When the Find box holds a pure number, show only rows whose wire number
  // matches; otherwise leave every row visible and let terminal.js's own text
  // filter do its work on top.
  function wireFilter() {
    const box = $('findStory');
    if (!box) return;
    const q = box.value.trim();
    const rows = document.querySelectorAll('#blotterBody tr[data-wireno]');
    if (!/^\d{1,3}$/.test(q)) {
      // Not a number: undo any wire-only hiding we applied.
      rows.forEach(r => r.removeAttribute('data-wirehide'));
      rows.forEach(r => { if (r.dataset.wirehid === '1') { r.style.display = ''; r.dataset.wirehid = ''; } });
      return;
    }
    const n = String(parseInt(q, 10));
    rows.forEach(r => {
      const match = r.getAttribute('data-wireno') === n;
      r.style.display = match ? '' : 'none';
      r.dataset.wirehid = match ? '' : '1';
    });
  }

  function toastOut(msg, type) { try { window.toast?.(msg, type); } catch (e) { console.log(msg); } }

  // ════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ════════════════════════════════════════════════════════════════════════
  function init() {
    // Tabs
    $('aeDockTab')?.addEventListener('click', () => showTab('alert'));
    $('tplDockTab')?.addEventListener('click', () => showTab('template'));

    // Composer
    $('tplNew')?.addEventListener('click', () => openEditor(null));
    $('tplCancel')?.addEventListener('click', closeEditor);
    $('tplSave')?.addEventListener('click', saveTemplate);
    $('tplBodyIn')?.addEventListener('input', updateEdCount);
    document.querySelectorAll('.tpl-chip[data-ins]').forEach(b =>
      b.addEventListener('click', () => insertToken(b.dataset.ins)));

    // Stitching: capture phase so we can stop terminal.js's handler when Ctrl
    // is held. Plain selections fall straight through to the existing code.
    const rb = $('readerBody');
    if (rb) rb.addEventListener('mouseup', onReaderMouseUp, true);
    document.addEventListener('selectionchange', onSelectionChange);

    // Wire-number search rides alongside the existing Find filtering.
    $('findStory')?.addEventListener('input', wireFilter);

    renderContextBar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { setContext, load, showTab, _resolve: resolve };
})();

if (typeof window !== 'undefined') window.TemplatesStitch = TemplatesStitch;
