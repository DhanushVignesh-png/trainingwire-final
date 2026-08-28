// FILE: frontend/terminal.js
// Training Wire — main application controller.
// Boots the auth gate, then runs the terminal: staging + injecting releases,
// rendering the live wire, reading releases, publishing alerts, flagging wrong
// alerts, and the guarded global reset. Wires the realtime socket and uses the
// resync hook to pull /api/state on every (re)connect so nothing is ever missed.
// All untrusted content goes through ReleaseFormatter. All DOM text is set safely.
'use strict';

(function () {
  // ── App state (client mirror of the shared wire) ──────────────────────────
  const state = {
    email: '',
    releases: [],                 // [{id, kind, headline, html/base64, sourceUrl, createdAt}]
    history: {},                  // chain -> [{rowKey, alert, wrong, ...}]
    staged: [],                   // [{url, headline?}] client-only until pushed
    activeReleaseId: null,
  };

  // ── Boot ───────────────────────────────────────────────────────────────────
  const authRoot = document.getElementById('auth-root');
  const appRoot = document.getElementById('app-root');

  const auth = new window.AuthFlow(authRoot, onAuthed);
  auth.start();

  async function onAuthed() {
    authRoot.hidden = true;
    appRoot.hidden = false;
    bindTerminal();
    await hydrate();
    startRealtime();
  }

  // ── Initial + resync snapshot ────────────────────────────────────────────
  async function hydrate() {
    try {
      const snap = await window.WireClient.getState();
      state.email = snap.user || '';
      state.releases = Array.isArray(snap.releases) ? snap.releases : [];
      state.history = snap.history && typeof snap.history === 'object' ? snap.history : {};
      renderUserChip();
      renderWire();
      renderHistory();
      // If the active release vanished (e.g. after a reset), clear the reader.
      if (state.activeReleaseId && !state.releases.find(r => r.id === state.activeReleaseId)) {
        state.activeReleaseId = null;
        renderReader(null);
      }
    } catch (err) {
      if (err.status === 401) return bounceToLogin();
      toast(err.message || 'Could not load the wire.', 'error');
    }
  }

  // ── Realtime ────────────────────────────────────────────────────────────────
  function startRealtime() {
    const rt = window.WireRealtime;
    rt.onStatus(setConnStatus);
    rt.onResync(() => { hydrate(); });   // pull authoritative state on every connect
    rt.on('release', (payload) => {
      upsertRelease(payload);
      renderWire();
      toast('New release on the wire', 'info');
    });
    rt.on('publish', (payload) => {
      addHistory(payload);
      renderHistory();
    });
    rt.on('flag', (payload) => {
      applyFlag(payload);
      renderHistory();
    });
    rt.on('clear', (payload) => {
      state.releases = [];
      state.history = {};
      state.activeReleaseId = null;
      window.ReleaseFormatter.revokeAll();
      renderWire(); renderHistory(); renderReader(null);
      const who = payload && payload.by ? ` by ${payload.by}` : '';
      toast(`Wire was reset${who}`, 'warn');
    });
    rt.start();
  }

  function setConnStatus(status) {
    const el = document.getElementById('conn-status');
    if (!el) return;
    const label = el.querySelector('.conn-label');
    el.classList.remove('conn-online', 'conn-offline', 'conn-connecting');
    if (status === 'online') { el.classList.add('conn-online'); label.textContent = 'live'; }
    else if (status === 'offline') { el.classList.add('conn-offline'); label.textContent = 'offline'; }
    else { el.classList.add('conn-connecting'); label.textContent = status === 'reconnecting' ? 'reconnecting…' : 'connecting…'; }
  }

  // ── State mutators ───────────────────────────────────────────────────────
  function upsertRelease(r) {
    if (!r || !r.id) return;
    const i = state.releases.findIndex(x => x.id === r.id);
    if (i === -1) state.releases.unshift(r);
    else state.releases[i] = r;
    state.releases.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  function addHistory(h) {
    if (!h || !h.chain) return;
    if (!state.history[h.chain]) state.history[h.chain] = [];
    const arr = state.history[h.chain];
    if (!arr.find(x => x.rowKey === h.rowKey)) arr.unshift(h);
  }
  function applyFlag(f) {
    if (!f || !f.chain) return;
    const arr = state.history[f.chain];
    if (!arr) return;
    const row = arr.find(x => x.rowKey === f.rowKey);
    if (row) { row.wrong = !!f.wrong; row.flaggedBy = f.flaggedBy || ''; }
  }

  // ── Terminal bindings ────────────────────────────────────────────────────
  function bindTerminal() {
    document.getElementById('btn-logout').addEventListener('click', doLogout);
    document.getElementById('btn-refresh').addEventListener('click', () => hydrate());

    // Inject / staging
    const urlInput = document.getElementById('inject-url');
    document.getElementById('btn-stage').addEventListener('click', () => stageUrl(urlInput.value));
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stageUrl(urlInput.value); } });
    document.getElementById('btn-inject').addEventListener('click', pushStaged);

    // Publish
    const alertBox = document.getElementById('pub-alert');
    alertBox.addEventListener('input', () => {
      document.getElementById('pub-count').textContent = String(alertBox.value.length);
    });
    document.getElementById('btn-publish').addEventListener('click', doPublish);

    // Clear (guarded)
    document.getElementById('btn-clear').addEventListener('click', openClearModal);
    bindClearModal();
  }

  async function doLogout() {
    window.WireRealtime.stop();
    window.WireClient.clearTokens();
    window.ReleaseFormatter.revokeAll();
    bounceToLogin();
  }

  function bounceToLogin() {
    appRoot.hidden = true;
    authRoot.hidden = false;
    authRoot.innerHTML = '';
    const a = new window.AuthFlow(authRoot, onAuthed);
    a.start();
  }

  // ── Staging + inject ─────────────────────────────────────────────────────
  function stageUrl(raw) {
    const note = document.getElementById('inject-note');
    note.textContent = '';
    const url = String(raw || '').trim();
    if (!url) return;
    let parsed;
    try { parsed = new URL(url); } catch (e) { note.textContent = 'Enter a valid URL.'; return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { note.textContent = 'Only http/https URLs.'; return; }
    if (state.staged.find(s => s.url === url)) { note.textContent = 'Already staged.'; return; }
    if (state.staged.length >= 15) { note.textContent = 'Max 15 staged at once.'; return; }
    state.staged.push({ url });
    document.getElementById('inject-url').value = '';
    renderStaged();
  }

  function renderStaged() {
    const list = document.getElementById('staged-list');
    const pushBtn = document.getElementById('btn-inject');
    list.innerHTML = '';
    state.staged.forEach((s, idx) => {
      const row = document.createElement('div');
      row.className = 'staged-row';
      const label = document.createElement('span');
      label.className = 'staged-url';
      label.textContent = s.url;             // safe
      label.title = s.url;
      const rm = document.createElement('button');
      rm.className = 'staged-remove';
      rm.type = 'button';
      rm.textContent = '×';
      rm.addEventListener('click', () => { state.staged.splice(idx, 1); renderStaged(); });
      row.appendChild(label); row.appendChild(rm);
      list.appendChild(row);
    });
    pushBtn.disabled = state.staged.length === 0;
    pushBtn.textContent = state.staged.length
      ? `Push ${state.staged.length} to wire` : 'Push staged to wire';
  }

  async function pushStaged() {
    if (!state.staged.length) return;
    const btn = document.getElementById('btn-inject');
    btn.disabled = true; btn.textContent = 'Pushing…';
    try {
      const res = await window.WireClient.injectReleases(state.staged.slice());
      const okCount = res.injected || 0;
      const fails = (res.results || []).filter(r => !r.ok);
      state.staged = [];
      renderStaged();
      if (okCount) toast(`Pushed ${okCount} release${okCount > 1 ? 's' : ''} live`, 'success');
      if (fails.length) toast(`${fails.length} failed: ${fails[0].error || 'fetch error'}`, 'error');
      // Realtime 'release' events will populate the wire; hydrate as a safety net.
      hydrate();
    } catch (err) {
      if (err.status === 401) return bounceToLogin();
      toast(err.message || 'Inject failed.', 'error');
    } finally {
      renderStaged();
    }
  }

  // ── Wire feed ────────────────────────────────────────────────────────────
  function renderWire() {
    const feed = document.getElementById('wire-feed');
    const empty = document.getElementById('wire-empty');
    // Wipe all but the empty-state node.
    Array.from(feed.querySelectorAll('.wire-card')).forEach(n => n.remove());

    if (!state.releases.length) { if (empty) empty.style.display = ''; return; }
    if (empty) empty.style.display = 'none';

    for (const r of state.releases) {
      const card = document.createElement('button');
      card.className = 'wire-card' + (r.id === state.activeReleaseId ? ' is-active' : '');
      card.type = 'button';
      card.addEventListener('click', () => openRelease(r.id));

      const kind = document.createElement('span');
      kind.className = 'wire-kind wire-kind-' + (r.kind === 'pdf' ? 'pdf' : 'html');
      kind.textContent = r.kind === 'pdf' ? 'PDF' : 'WEB';

      const title = document.createElement('span');
      title.className = 'wire-title';
      title.textContent = window.ReleaseFormatter.preview(r, 120);   // safe text

      const meta = document.createElement('span');
      meta.className = 'wire-meta';
      meta.textContent = timeAgo(r.createdAt) + (r.injectedBy ? ' · ' + shortEmail(r.injectedBy) : '');

      const top = document.createElement('div');
      top.className = 'wire-card-top';
      top.appendChild(kind); top.appendChild(meta);
      card.appendChild(top);
      card.appendChild(title);
      feed.appendChild(card);
    }
  }

  // ── Reader + publish ─────────────────────────────────────────────────────
  function openRelease(id) {
    state.activeReleaseId = id;
    const r = state.releases.find(x => x.id === id);
    renderWire();          // refresh active highlight
    renderReader(r);
  }

  function renderReader(release) {
    const view = document.getElementById('reader-view');
    const dock = document.getElementById('publish-dock');
    const hint = document.getElementById('reader-hint');
    window.ReleaseFormatter.revokeAll();   // free any prior PDF blobs

    if (!release) {
      view.innerHTML = `
        <div class="empty-state">
          <div class="empty-mark">◎</div>
          <p>Open a release from the wire to read it and publish an alert.</p>
        </div>`;
      dock.hidden = true;
      hint.textContent = 'Select a release';
      return;
    }
    view.innerHTML = '';
    window.ReleaseFormatter.render(release, view);   // SANITIZED render
    dock.hidden = false;
    hint.textContent = release.kind === 'pdf' ? 'PDF release' : 'Web release';
  }

  async function doPublish() {
    const chain = document.getElementById('pub-chain').value.trim().toUpperCase();
    const alert = document.getElementById('pub-alert').value.trim();
    if (!chain) return toast('Enter a chain.', 'error');
    if (!alert) return toast('Enter an alert headline.', 'error');

    const btn = document.getElementById('btn-publish');
    btn.disabled = true; btn.textContent = 'Publishing…';
    try {
      await window.WireClient.publishAlert(chain, alert, state.activeReleaseId || null);
      document.getElementById('pub-alert').value = '';
      document.getElementById('pub-count').textContent = '0';
      toast('Alert published', 'success');
      // 'publish' realtime event updates history for everyone (incl. us).
    } catch (err) {
      if (err.status === 401) return bounceToLogin();
      toast(err.message || 'Publish failed.', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Publish alert';
    }
  }

  // ── History ticker + flagging ────────────────────────────────────────────
  function renderHistory() {
    const body = document.getElementById('ticker-body');
    body.innerHTML = '';
    // Flatten all chains, newest first.
    const all = [];
    for (const chain of Object.keys(state.history)) {
      for (const h of state.history[chain]) all.push(h);
    }
    all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (!all.length) {
      const none = document.createElement('span');
      none.className = 'ticker-empty';
      none.textContent = 'No alerts published yet.';
      body.appendChild(none);
      return;
    }

    for (const h of all.slice(0, 60)) {
      const item = document.createElement('div');
      item.className = 'ticker-item' + (h.wrong ? ' is-wrong' : '');

      const chain = document.createElement('span');
      chain.className = 'ticker-chain';
      chain.textContent = h.chain;

      const text = document.createElement('span');
      text.className = 'ticker-text';
      text.textContent = h.alert;

      const flag = document.createElement('button');
      flag.className = 'ticker-flag';
      flag.type = 'button';
      flag.title = h.wrong ? 'Marked wrong — click to clear' : 'Flag as wrong alert';
      flag.textContent = h.wrong ? '⚑ WRONG' : '⚐';
      flag.addEventListener('click', () => toggleFlag(h));

      item.appendChild(chain);
      item.appendChild(text);
      item.appendChild(flag);
      body.appendChild(item);
    }
  }

  async function toggleFlag(h) {
    try {
      await window.WireClient.flagAlert(h.chain, h.rowKey, !h.wrong);
      // 'flag' realtime event syncs everyone; optimistic update for snappiness:
      h.wrong = !h.wrong;
      renderHistory();
    } catch (err) {
      if (err.status === 401) return bounceToLogin();
      toast(err.message || 'Could not update flag.', 'error');
    }
  }

  // ── Clear (guarded global reset) ─────────────────────────────────────────
  function openClearModal() {
    const modal = document.getElementById('modal-root');
    const input = document.getElementById('confirm-text');
    const confirm = document.getElementById('modal-confirm');
    modal.hidden = false;
    input.value = '';
    confirm.disabled = true;
    setTimeout(() => input.focus(), 30);
  }
  function closeClearModal() {
    document.getElementById('modal-root').hidden = true;
  }
  function bindClearModal() {
    const modal = document.getElementById('modal-root');
    const input = document.getElementById('confirm-text');
    const confirm = document.getElementById('modal-confirm');
    input.addEventListener('input', () => { confirm.disabled = input.value.trim().toUpperCase() !== 'RESET'; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !confirm.disabled) doClear(); });
    document.getElementById('modal-cancel').addEventListener('click', closeClearModal);
    modal.querySelector('[data-close]').addEventListener('click', closeClearModal);
    confirm.addEventListener('click', doClear);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeClearModal(); });
  }
  async function doClear() {
    const confirm = document.getElementById('modal-confirm');
    confirm.disabled = true; confirm.textContent = 'Resetting…';
    try {
      await window.WireClient.clearWire();
      closeClearModal();
      // 'clear' realtime event wipes state for everyone incl. us.
      toast('Wire reset', 'success');
    } catch (err) {
      if (err.status === 401) return bounceToLogin();
      toast(err.message || 'Reset failed.', 'error');
    } finally {
      confirm.textContent = 'Reset everything';
    }
  }

  // ── UI helpers ───────────────────────────────────────────────────────────
  function renderUserChip() {
    const chip = document.getElementById('user-chip');
    chip.textContent = state.email || '';
    chip.title = state.email || '';
  }
  function shortEmail(e) { return String(e || '').split('@')[0]; }
  function timeAgo(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  let _toastId = 0;
  function toast(msg, kind) {
    const host = document.getElementById('toast-host');
    const el = document.createElement('div');
    el.className = 'toast toast-' + (kind || 'info');
    el.textContent = msg;                 // safe
    const id = ++_toastId;
    el.dataset.id = String(id);
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
    setTimeout(() => {
      el.classList.remove('is-in');
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
    }, 4000);
  }
})();