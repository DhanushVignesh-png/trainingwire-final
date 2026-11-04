// FILE: frontend/blank-editor.js
// Training Wire — Blank Alert Editor.
// An Alert Editor that is not tied to a release: the trainer sends text over Teams
// or email, the trainee pastes it here, highlights, and every template row fills
// ~selected~ (~copied~ accepted). Click the text with nothing selected to clear.
// Products / Topics / RICs are chips (no USN). Templates are the user's own, made in
// the Template Editor tab. Publishing creates a release on the shared wire and files
// the snap against it, the same way auto-snaps do, so it appears in Releases and
// Publish History like any other.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
  const toastOut = (m, t) => { try { window.toast?.(m, t); } catch (e) { console.log(m); } };

  const meta = { products: [], topics: [], rics: [] };
  let company = '', selected = '', releaseId = null, busy = false;

  function build() {
    if ($('blankEd')) return;
    const el = document.createElement('div');
    el.id = 'blankEd'; el.className = 'be-float'; el.style.display = 'none';
    el.innerHTML =
      '<div class="be-hdr" id="beHdr"><span class="be-title">Blank Alert Editor</span>' +
      '<button class="modal-close" id="beClose" title="Close">✕</button></div>' +
      '<div class="be-body">' +
        '<div class="be-top">' +
          [['products', 'Products'], ['topics', 'Topics'], ['rics', 'RICs']].map(([k, n]) =>
            '<div class="be-meta"><label>' + n + '</label><div class="be-chips" id="beChips_' + k + '"></div>' +
            '<input class="be-in" id="beIn_' + k + '" placeholder="Type, press Enter" spellcheck="false"></div>').join('') +
          '<div class="be-meta"><label>Company <span class="be-sub">(fills ~company~)</span></label>' +
          '<input class="be-in" id="beCompany" placeholder="e.g. ANTHROPIC" spellcheck="false"></div>' +
        '</div>' +
        '<label class="be-lbl">Text to snap — paste it, then highlight. Click with nothing selected to clear.</label>' +
        '<div class="be-src" id="beSrc" contenteditable="plaintext-only" spellcheck="false" data-ph="Paste the text you were sent…"></div>' +
        '<div class="tpl-list" id="beRows"></div>' +
      '</div>';
    document.body.appendChild(el);

    $('beClose').onclick = close;
    ['products', 'topics', 'rics'].forEach(k => $('beIn_' + k).addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      const v = e.target.value.trim().toUpperCase().replace(/,/g, '');
      if (!v) return;
      if (!meta[k].includes(v)) meta[k].push(v);
      e.target.value = '';
      chips();
    }));
    $('beCompany').oninput = (e) => { company = e.target.value.trim(); rows(); };

    const src = $('beSrc');
    const pick = (ev) => {
      const sel = getSelection();
      const t = (sel.toString() || '').replace(/\s+/g, ' ').trim();
      if (!t || !src.contains(sel.anchorNode)) return;
      selected = (typeof stripArticles === 'function') ? stripArticles(t) : t;
      rows();
    };
    src.addEventListener('mouseup', pick);
    src.addEventListener('keyup', pick);
    src.addEventListener('click', () => {
      if ((getSelection().toString() || '').trim()) return;
      if (selected) { selected = ''; rows(); }
    });

    let drag = null;
    $('beHdr').addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      const r = el.getBoundingClientRect();
      drag = { x: e.clientX - r.left, y: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      el.style.left = Math.max(0, e.clientX - drag.x) + 'px';
      el.style.top = Math.max(0, e.clientY - drag.y) + 'px';
    });
    window.addEventListener('mouseup', () => { drag = null; });
  }

  function chips() {
    ['products', 'topics', 'rics'].forEach(k => {
      const box = $('beChips_' + k);
      box.innerHTML = '';
      meta[k].forEach(v => {
        const c = document.createElement('span');
        c.className = 'be-chip'; c.textContent = v; c.title = 'Click to remove';
        c.onclick = () => { meta[k] = meta[k].filter(x => x !== v); chips(); };
        box.appendChild(c);
      });
    });
  }

  function rows() {
    const host = $('beRows');
    if (!host || !window.TemplatesStitch) return;
    const tpls = TemplatesStitch.getTemplates();
    if (!tpls.length) {
      host.innerHTML = '<div class="tpl-empty">No templates yet — create them in the <b>Template Editor</b> tab.</div>';
      return;
    }
    host.innerHTML = tpls.map(t => {
      const { text, resolved } = TemplatesStitch.fill(t.body, company, selected);
      return '<div class="tpl-row"><div class="tpl-row-title" title="' + esc(t.title) + '">' + esc(t.title) + '</div>' +
        '<div class="tpl-preview' + (resolved ? '' : ' empty') + '" title="' + esc(text) + '">' + esc(text) + '</div>' +
        '<span class="tpl-row-cc">' + text.length + ' chars</span>' +
        '<button class="tpl-pub" data-id="' + esc(t.id) + '"' + (resolved ? '' : ' disabled title="Highlight text above first"') + '>Publish</button></div>';
    }).join('');
    host.querySelectorAll('.tpl-pub').forEach(b => b.addEventListener('click', () => {
      const t = TemplatesStitch.getTemplates().find(x => x.id === b.dataset.id);
      if (t) publish(TemplatesStitch.fill(t.body, company, selected).text);
    }));
  }

  async function publish(line) {
    if (busy || !line) return;
    if (typeof requireName === 'function' && !requireName()) return;
    busy = true;
    try {
      let firstId = null;
      if (!releaseId) {
        const body = ($('beSrc').innerText || '').trim();
        const out = await WireSync.inject([{
          title: line.slice(0, 160), kind: 'paste', source: (company || 'MANUAL').toUpperCase(), sourceUrl: '',
          bodyHtml: body ? '<p class="rl-p">' + esc(body) + '</p>' : '', bodyText: body || line
        }]);
        const res = (out && out.results && out.results[0]) || {};
        if (!res.ok) throw new Error(res.error || 'release rejected');
        releaseId = firstId = res.id;
      }
      await WireSync.publish(releaseId, line, releaseId);
      const s = await WireSync.loadState();
      applySnapshot(s.releases, s.history, { archives: s.archives, activity: s.activity, embargoes: s.embargoes });
      toastOut('Published to the wire', 's');
    } catch (e) {
      toastOut('Publish failed: ' + (e.message || 'try again'), 'r');
    } finally { busy = false; }
  }

  async function open() {
    build();
    $('blankEd').style.display = 'flex';
    chips(); rows();
    if (window.TemplatesStitch) { await TemplatesStitch.load(); rows(); }
  }
  function close() { $('blankEd').style.display = 'none'; releaseId = null; }

  document.addEventListener('DOMContentLoaded', () => $('btnBlankAE')?.addEventListener('click', open));
  if (document.readyState !== 'loading') $('btnBlankAE')?.addEventListener('click', open);
})();
