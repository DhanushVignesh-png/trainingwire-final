// Training Wire — Controller v4.0 (shared corrections, withdrawals, activity,
// coverage and embargo bundles)
//
// v4.0 vs v3.9: everything that used to live only in this browser is now shared
// through the server and broadcast, so the whole cohort sees it in real time —
// corrections, withdrawals, the coverage flag, headline activity and embargo
// bundles. The local-only notes are gone; each of those now has an endpoint.
console.log('Training Wire: Controller v4.0');

// ═══ STATE ═══
let stories = [];
let storyById = {};
let nextId = 1;
let selectedId = null;

let sortKey = 'time', sortDir = -1;
let highlightKeywords = [];
let snapperName = '';
let autoSnapOn = true;

let mode = 'live';              // 'live' | 'correct' | 'withdraw'
let pickMode = false;
let picked = new Set();
let phTab = 'pubhist';          // 'pubhist' | 'activity'
let showArchive = false;

const MAX_RELEASES = 25;
let stagedReleases = [];

const DEFAULT_HIGHLIGHT_KEYWORDS = [
  'dividend','cash','per share','offer','possible offer','firm intention','acquisition','acquire','merger',
  'recommend','minded to recommend','agreement in principle','pre-conditions','PUSU','Rule 2.4','Rule 2.7','Rule 2.8',
  'appoints','appointed','appointment','CEO','CFO','Chair','Chairman','designate','succeed','succeeds','step down',
  'steps down','retire','resign','resigned','pence','per share','shareholders','proposal','offeror','offeree'
];

// ═══ HELPERS ═══
const sGet = TWStore.get, sSet = TWStore.set;
function esc(t) { if (t == null) return ''; const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; }
function bind(id, ev, fn) { const e = document.getElementById(id); if (e) e.addEventListener(ev, fn); }
function hms(d) { return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function toast(msg, type='i') { const c=document.getElementById('toastContainer'); if(!c)return; const t=document.createElement('div'); t.className='toast '+type; t.textContent=msg; c.appendChild(t); setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(()=>t.remove(),300);},3200); }

// ═══ ARTICLE STRIPPING (manual Alert Editor ONLY — never applied to auto-snaps) ═══
function stripArticles(text){
  if (!text) return '';
  let t = String(text);
  t = t.replace(/\b(a|an|the)\b/gi, '');
  t = t.replace(/\s{2,}/g, ' ');
  t = t.replace(/\s+([,.;:!?)])/g, '$1');
  t = t.replace(/([(])\s+/g, '$1');
  return t.trim();
}

// ═══ SOURCE (RNS- and EDGAR-aware) ═══
const EDGAR_HINT = /\bSEC Accession No\b|\bEDGAR\b|\bFiling Detail\b/i;
const EDGAR_ROLE = ['Filer', 'Filed by', 'Subject'];
const FILER_ADDR_WORD = /^(?:address|mailing|business|street|avenue|ave|road|rd|suite|ste|floor|fl|box|drive|boulevard|blvd|lane|plaza|parkway|pkwy|po|p\.?o\.?)$/i;
const FILER_STATE = /^(?:a[lkzr]|c[aot]|de|fl|ga|hi|i[adln]|k[sy]|la|m[adeinost]|n[cdehjmvy]|o[hkr]|pa|ri|s[cd]|t[nx]|ut|v[at]|w[aivy]|dc)$/i;

function filerNameBefore(tail){
  const toks = String(tail).split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = toks.length - 1; i >= 0 && out.length < 8; i--){
    const tok = toks[i];
    const bare = tok.replace(/[.,]+$/, '');
    if (/[()]/.test(tok)) break;
    if (/^\d[\d\-]*$/.test(bare)) break;
    if (FILER_ADDR_WORD.test(bare)) break;
    if (out.length && FILER_STATE.test(bare)) break;
    out.unshift(tok);
  }
  return out.join(' ').replace(/^[\-–—·|»,\s]+/, '').replace(/[,;:\s]+$/, '');
}

function secFiler(bodyText){
  const t = String(bodyText || '');
  if (!EDGAR_HINT.test(t)) return '';
  for (const role of EDGAR_ROLE){
    const rx = new RegExp('([^\\n]*?)\\s*\\(\\s*' + role.replace(' ', '\\s+') + '\\s*\\)', 'i');
    const m = t.match(rx);
    if (m && m[1]){
      const name = filerNameBefore(m[1]);
      if (name.length >= 2) return name;
    }
  }
  return '';
}

function deriveSource(bodyText, headline){
  const sec = secFiler(bodyText);
  if (sec) return sec;
  try {
    if (window.SnapEngine && typeof SnapEngine.deriveSourceFromText === 'function') {
      const s = SnapEngine.deriveSourceFromText(bodyText || '', headline || '');
      if (s) return s;
    }
  } catch(e){}
  let h = String(headline || '').replace(/\s+/g,' ').trim();
  const m = h.match(/\b(announces?|reports?|statement|appoints?|regarding)\b/i);
  if (m && m.index > 0) h = h.slice(0, m.index).trim();
  return h.replace(/[,:;\-–—]\s*$/, '').trim();
}

// ═══ TABLES FROM PASTED TEXT ═══
const NUM_TOK = /^\(?[-–—]?[$£€¥]?\d[\d,]*(?:\.\d+)?\)?$/;
const CUR_TOK = /^[$£€¥]$/;
const UNIT_TOK = /^(?:%|pts?|bps?|bn|mln|m|k|x|¢)$/i;
const DASH_TOK = /^(?:[—–]|-{1,2}|N\/A|n\/a|nil)$/;
const CLOSE_TOK = /^\)+$/;
const MAX_LABEL_WORDS = 10;

const isCellTok = (t) => NUM_TOK.test(t) || CUR_TOK.test(t) || UNIT_TOK.test(t) || DASH_TOK.test(t) || CLOSE_TOK.test(t);

const MONTH_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const PERIOD_RE = /\b(?:three|six|nine|twelve)\s+months\s+ended\b|\b(?:year|quarter|period|half)\s+ended\b|\bas\s+(?:at|of)\b/i;

function isPeriodHeaderLine(line){
  if (/[$£€¥]/.test(line)) return false;
  return MONTH_RE.test(line) || PERIOD_RE.test(line);
}

function rowsFromLine(line){
  const toks = line.split(/\s+/).filter(Boolean);
  const rows = [];
  let cur = [], inNums = false;
  for (const t of toks){
    const cell = isCellTok(t);
    if (!cell && inNums){ rows.push(cur); cur = [t]; inNums = false; }
    else { cur.push(t); if (cell) inNums = true; }
  }
  if (cur.length) rows.push(cur);
  return rows;
}

function numericSuffixStart(toks){
  let i = toks.length;
  while (i > 0 && isCellTok(toks[i - 1])) i--;
  return i;
}

function groupCells(toks){
  const cells = [];
  let cur = '';
  const flush = () => { if (cur) { cells.push(cur); cur = ''; } };
  for (const t of toks){
    if (CLOSE_TOK.test(t) && cur) { cur += t; continue; }
    if (UNIT_TOK.test(t) && cur) { cur += ' ' + t; continue; }
    if (CUR_TOK.test(t)) { flush(); cur = t; continue; }
    if (CUR_TOK.test(cur)) { cur += ' ' + t; continue; }
    flush(); cur = t;
  }
  flush();
  return cells;
}

const BARE_YEAR = /^(?:19|20)\d{2}$/;

function parseTextRow(toks){
  const start = numericSuffixStart(toks);
  let label = toks.slice(0, start).join(' ');
  let cells = groupCells(toks.slice(start));

  if (cells.length > 2 && BARE_YEAR.test(cells[0]) && new RegExp(MONTH_RE.source + '\\s*,?\\s*$', 'i').test(label)) {
    label = (label + ' ' + cells[0]).trim();
    cells = cells.slice(1);
  }

  const words = label ? label.split(/\s+/).length : 0;
  const isData =
    cells.length >= 2 &&
    words <= MAX_LABEL_WORDS &&
    words >= 1;
  return { label, cells, isData };
}

function textTableHtml(rows, colCount){
  let h = '<table class="rl-table rl-table-text"><tbody>';
  let pending = [];
  const flushCaptions = () => {
    const t = pending.join(' ').replace(/\s+/g, ' ').trim();
    pending = [];
    if (t) h += '<tr class="rl-sec"><td colspan="' + (colCount + 1) + '">' + esc(t) + '</td></tr>';
  };
  for (const r of rows){
    if (!r.isData){
      const t = [r.label, r.cells.join(' ')].filter(Boolean).join(' ').trim();
      if (t) pending.push(t);
      continue;
    }
    flushCaptions();
    h += '<tr><td class="rl-label">' + esc(r.label) + '</td>';
    for (let i = 0; i < colCount; i++){
      h += '<td class="num">' + esc(r.cells[i] != null ? r.cells[i] : '') + '</td>';
    }
    h += '</tr>';
  }
  flushCaptions();
  return h + '</tbody></table>';
}

function formatPastedText(raw){
  const text = String(raw || '').replace(/\r\n?/g, '\n').replace(/\u00A0/g, ' ');
  const blocks = text.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
  const isBullet = (l) => /^\s*(?:[•‣▪◦·\-–—\*]|\(?\d{1,2}[\.\)]|\([a-z]\))\s+/.test(l);

  let html = '';
  for (const block of blocks){
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const bulletCount = lines.filter(isBullet).length;
    if (lines.length > 1 && bulletCount >= Math.ceil(lines.length * 0.6)){
      html += '<ul class="rl-list">';
      for (const l of lines){
        const clean = l.replace(/^\s*(?:[•‣▪◦·\-–—\*]|\(?\d{1,2}[\.\)]|\([a-z]\))\s+/, '');
        html += '<li>' + esc(clean) + '</li>';
      }
      html += '</ul>';
      continue;
    }

    const rows = [];
    for (const l of lines){
      if (isPeriodHeaderLine(l)){ rows.push({ label: l, cells: [], isData: false }); continue; }
      for (const toks of rowsFromLine(l)) rows.push(parseTextRow(toks));
    }
    const dataRows = rows.filter(r => r.isData);
    const colCount = dataRows.reduce((m, r) => Math.max(m, r.cells.length), 0);
    if (dataRows.length >= 2 && colCount >= 2){
      html += textTableHtml(rows, colCount);
      continue;
    }

    const para = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (para) html += '<p class="rl-p">' + esc(para) + '</p>';
  }

  const plain = text.split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const title = guessPasteTitle(plain);
  return { title, html, text: plain };
}

function guessPasteTitle(plain){
  const lines = String(plain || '').split('\n').map(l => l.trim()).filter(Boolean);
  const skip = /^(REG\b|LSE\b|RNS\s+Number|NOT FOR RELEASE|THIS IS AN ANNOUNCEMENT|THIS ANNOUNCEMENT|FOR IMMEDIATE RELEASE|\d{1,2}\s+\w+\s+\d{4}$|\d{1,2}\s+\w{3}\s+\d{4})/i;
  for (const l of lines){
    if (l.length < 12) continue;
    if (skip.test(l)) continue;
    return l.slice(0, 200);
  }
  return (lines.find(l => l.length >= 8) || 'Untitled Release').slice(0, 200);
}

// ═══ INIT ═══
document.addEventListener('DOMContentLoaded', () => {
  initEvents();
  loadPrefs();
  renderBlotter();
  renderPubHistory();
  initSplitters();
  initDockResizers();
  initSettingsDragResize();
  renderSendReleases();
  setMode('live');
  renderActivity();
  // Embargo bundles are shared now: every action routes through the server.
  Embargo.init({
    onFile: putBundleOnWire,
    onCreate: (draft) => WireSync.createBundle(draft).then(r => r && r.bundle),
    onPublishHeld: (id) => WireSync.publishBundle(id).then(r => r && r.bundle),
    onDiscard: (id) => WireSync.discardBundle(id),
    onReleaseDue: (id) => WireSync.releaseBundle(id).then(r => r && r.claimed),
    whoAmI: () => snapperName || '—'
  });
  window.addEventListener('resize', reflowOverlays);
  reflowOverlays();
  Auth.init({ onSignedIn: async (acct) => {
    snapperName = acct.username;
    renderWho(acct);
    applySavedSplit();
    reflowOverlays();
    toast('Signed in as ' + acct.username, 's');
    try{ window.showSigninBanner?.(); }catch(e){}
    await joinSharedWire();
  }});
});

// Pull the shared wire, then listen for changes.
async function joinSharedWire(){
  setConnStatus('connecting');
  try{
    const s = await WireSync.loadState();
    applySnapshot(s.releases, s.history, {
      archives: s.archives, activity: s.activity, embargoes: s.embargoes
    });
    const n = (s.releases || []).length;
    if(n) toast(n + ' release' + (n===1?'':'s') + ' on the wire', 'i');
  }catch(e){
    setConnStatus('offline');
    toast('Could not load the wire: ' + (e.message || 'try reloading'), 'r');
    return;
  }

  WireSync.start({
    onStatus: (st) => setConnStatus(st),

    onRelease: (rel) => {
      const story = storyFromServer(rel);
      renderBlotter();
      toast('New release: ' + (rel.headline || '').slice(0, 60), 'i');
      if (story.id === selectedId) renderReader(story);
    },

    onPublish: (p) => applyPublishedRow(p),

    onFlag: (p) => {
      const localId = serverIdToLocal.get(p.chain);
      const story = localId ? storyById[localId] : null;
      if(!story) return;
      const row = (story.chain || []).find(c => c.rowKey === p.rowKey);
      if(!row) return;
      row.flagged = !!p.wrong;
      if(story.id === selectedId) renderPubHistory();
    },

    onDelete: (p) => {
      const ids = (p && p.ids) || [];
      const mine = ids.filter(id => serverIdToLocal.has(id));
      if(!mine.length) return;
      removeReleasesLocally(ids);
      if(pickMode){ mine.forEach(id => picked.delete(id)); updatePickCount(); }
      toast(mine.length + ' release' + (mine.length===1?'':'s') + ' deleted by ' + ((p && p.by) || 'someone'), 'w');
    },

    onClear: () => {
      if(pickMode) exitPickMode();
      stories = []; storyById = {}; selectedId = null; nextId = 1; serverIdToLocal.clear();
      renderBlotter(); renderPubHistory(); renderActivity();
      document.getElementById('readerHeadline').innerHTML = 'Select a release';
      document.getElementById('readerSub').innerHTML = '';
      document.getElementById('readerBody').innerHTML =
        '<div class="reader-placeholder">The wire was cleared. Open Settings → Send Releases to inject one.</div>';
      renderCoverFlag(null);
      toast('The wire was cleared', 'w');
    },

    // ── Shared correction: someone refiled a whole chain. ──
    onCorrect: (p) => applyCorrection(p),

    // ── Shared withdrawal: someone killed a whole chain. ──
    onWithdraw: (p) => applyWithdrawal(p),

    // ── Shared headline activity: one entry against a release. ──
    onActivity: (p) => applyActivity(p),

    // ── Shared coverage flag. ──
    onCover: (p) => applyCover(p),

    // ── Shared embargo bundles. ──
    onEmbargo: (p) => Embargo.onBroadcast(p),

    onReleases: (releases, history, extras) => applySnapshot(releases, history, extras)
  });
}

function renderWho(acct){
  const el=document.getElementById('tbWho'); if(!el) return;
  if(!acct){ el.innerHTML=''; return; }
  el.innerHTML='<b>'+esc(acct.username)+'</b> <span class="tb-who-mail">'+esc(acct.email)+'</span>';
}

function initEvents() {
  bind('btnSignOut','click',()=>askYesNo('Sign out of Training Wire?',()=>{ Auth.signOut(); reflowOverlays(); toast('Signed out','i'); }));
  bind('askYes','click',()=>{ const fn=askPending; closeAsk(); fn?.(); });
  bind('askNo','click',closeAsk);
  document.addEventListener('keydown',(e)=>{ if(e.key==='Escape' && askPending!==null) closeAsk(); });

  bind('btnSettings','click',()=>{ openSettings(); setTimeout(()=>{const e=document.getElementById('srDraftText'); if(e)e.focus();},60); });
  bind('btnCloseSettings','click',closeSettings);
  const sm=document.getElementById('settingsModal'); if(sm) sm.addEventListener('click',e=>{ if(e.target===sm) closeSettings(); });

  bind('btnSendAll','click',sendAllReleases);
  bind('btnClearAll','click',()=>{ stagedReleases=[]; renderSendReleases(); });

  bind('btnClearReleases','click',(e)=>{ e.stopPropagation(); toggleClearMenu(); });
  bind('clearAll','click',clearAllReleases);
  bind('clearPick','click',enterPickMode);
  bind('pickAll','change',togglePickAll);
  bind('pickCancel','click',exitPickMode);
  bind('pickDelete','click',confirmDeletePicked);

  bind('btnSaveName','click',saveUsername);
  bind('btnSaveMpin','click',saveNewMpin);

  bind('autoSnapToggle','change',()=>{ autoSnapOn=document.getElementById('autoSnapToggle').checked; sSet({nw_autosnap:autoSnapOn}); toast(autoSnapOn?'Auto-snap ON':'Auto-snap OFF', autoSnapOn?'s':'i'); });

  bind('findStory','input',renderBlotter);
  document.querySelectorAll('.blotter th.sortable').forEach(th=>th.addEventListener('click',()=>{
    const k=th.dataset.sort; if(sortKey===k) sortDir=-sortDir; else {sortKey=k; sortDir=-1;} renderBlotter();
  }));

  document.querySelectorAll('.tab[data-mode]').forEach(t=>t.addEventListener('click',()=>setMode(t.dataset.mode)));
  document.querySelectorAll('.tab[data-float="embargo"]').forEach(t=>t.addEventListener('click',()=>{
    if(Embargo.isOpen()) Embargo.close(); else Embargo.open();
    syncEmbargoTab();
  }));

  document.querySelectorAll('.dock-tab[data-dock]').forEach(t=>t.addEventListener('click',()=>{
    phTab=t.dataset.dock;
    document.querySelectorAll('.dock-tab[data-dock]').forEach(x=>x.classList.toggle('on',x.dataset.dock===phTab));
    document.getElementById('dockPubhist').classList.toggle('on',phTab==='pubhist');
    document.getElementById('dockActivity').classList.toggle('on',phTab==='activity');
    if(phTab==='activity') renderActivity();
  }));

  bind('btnCoverFlag','click',toggleCoverFlag);
  bind('correctFile','click',fileCorrection);
  bind('correctReset','click',renderCorrectPanel);
  bind('withdrawFile','click',fileWithdrawal);
  bind('withdrawReset','click',()=>{ document.getElementById('withdrawAdvisory').value=''; });

  bind('btnSaveTemplate','click',saveTemplate);
  bind('btnResetTemplate','click',()=>{highlightKeywords=[...DEFAULT_HIGHLIGHT_KEYWORDS];document.getElementById('templateKeywords').value=highlightKeywords.join(', ');sSet({nw_hl_keywords:highlightKeywords},()=>{toast('Keywords reset','i');if(selectedId)renderReader(storyById[selectedId]);});});

  bind('zoom','input',()=>{document.getElementById('readerBody').style.fontSize=document.getElementById('zoom').value+'px';});

  const rb=document.getElementById('readerBody');
  if(rb){
    rb.addEventListener('mouseup',captureSelection);
    rb.addEventListener('keyup',captureSelection);
    rb.addEventListener('click',()=>{
      const sel=window.getSelection ? window.getSelection() : null;
      if(sel && (sel.toString()||'').trim()) return;
      resetAlertEditorBody();
    });
  }

  bind('aeBody','input',updateAeCharCount);
  bind('aeClear','click',resetAlertEditorBody);
  bind('aePublish','click',publishFromAlertEditor);
}

// ═══ SETTINGS: ACCOUNT ═══
function acctMsg(text, ok){
  const el=document.getElementById('acctMsg'); if(!el) return;
  el.textContent=text||'';
  el.className='acct-msg'+(text?(ok?' ok':' bad'):'');
}
function clearAcctPins(){
  ['acctCurrentPin','acctNewPin','acctNewPin2'].forEach(id=>{ const e=document.getElementById(id); if(e) e.value=''; });
}

async function saveUsername(){
  const cur=(document.getElementById('acctCurrentPin').value||'').trim();
  const name=(document.getElementById('acctName').value||'').trim();
  acctMsg('');
  if(!/^\d{6}$/.test(cur)){ acctMsg('Enter your current 6-digit MPIN first.',false); document.getElementById('acctCurrentPin').focus(); return; }
  if(!/^[A-Za-z][A-Za-z .'\-]{1,23}$/.test(name)){ acctMsg('Username must start with a letter and be 2 to 24 letters.',false); return; }
  const btn=document.getElementById('btnSaveName'); btn.disabled=true;
  try{
    const res=await WireClient.updateName(cur, name);
    snapperName=res.name||name;
    Auth.setUsername(snapperName);
    renderWho({ username:snapperName, email:(Auth.current()||{}).email||'' });
    renderAccountCard();
    clearAcctPins();
    document.getElementById('acctName').value='';
    acctMsg('Username changed to '+snapperName+'. Snaps you already filed keep the name they went out under.',true);
  }catch(e){
    acctMsg(e.message||'Could not change your username.',false);
    clearAcctPins();
  }finally{ btn.disabled=false; }
}

async function saveNewMpin(){
  const cur=(document.getElementById('acctCurrentPin').value||'').trim();
  const a=(document.getElementById('acctNewPin').value||'').trim();
  const b=(document.getElementById('acctNewPin2').value||'').trim();
  acctMsg('');
  if(!/^\d{6}$/.test(cur)){ acctMsg('Enter your current 6-digit MPIN first.',false); document.getElementById('acctCurrentPin').focus(); return; }
  if(!/^\d{6}$/.test(a)){ acctMsg('The new MPIN must be 6 digits.',false); return; }
  if(a!==b){ acctMsg('The two new MPINs do not match.',false); return; }
  if(a===cur){ acctMsg('The new MPIN is the same as the current one.',false); return; }
  const btn=document.getElementById('btnSaveMpin'); btn.disabled=true;
  try{
    await WireClient.changeMpin(cur, a);
    clearAcctPins();
    acctMsg('MPIN changed. Use the new one next time you sign in.',true);
  }catch(e){
    acctMsg(e.message||'Could not change your MPIN.',false);
    clearAcctPins();
  }finally{ btn.disabled=false; }
}

function renderAccountCard(){
  const el=document.getElementById('acctWho'); if(!el) return;
  const a=Auth.current();
  el.innerHTML = a
    ? 'Signed in as <b>'+esc(a.username)+'</b> &middot; '+esc(a.email)
    : '';
}

function openSettings(){
  const m=document.getElementById('settingsModal'); m.style.display='grid'; centreOnFirstScreen(m);
  renderAccountCard(); acctMsg(''); clearAcctPins();
}
function closeSettings(){ document.getElementById('settingsModal').style.display='none'; }

// ═══ YES / NO ═══
let askPending = null;
function askYesNo(msg, onYes){
  const ov=document.getElementById('askOverlay'); if(!ov){ if(window.confirm(msg)) onYes?.(); return; }
  document.getElementById('askMsg').textContent=msg;
  askPending=onYes||(()=>{});
  ov.style.display='grid';
  centreOnFirstScreen(ov);
  setTimeout(()=>document.getElementById('askNo')?.focus(),40);
}
function closeAsk(){
  const ov=document.getElementById('askOverlay'); if(ov) ov.style.display='none';
  askPending=null;
}

// ═══ TWO-SCREEN LAYOUT ═══
function screenSeam(){
  try{
    const aw = window.screen && window.screen.availWidth;
    if(!aw) return 0;
    if(window.innerWidth < aw * 1.35) return 0;
    const seam = aw - (window.screenX || 0);
    return (seam > 200 && seam < window.innerWidth - 200) ? seam : 0;
  }catch(e){ return 0; }
}

function centreOnFirstScreen(overlay){
  if(!overlay) return;
  const seam=screenSeam();
  overlay.style.paddingRight = seam ? Math.max(0, window.innerWidth - seam)+'px' : '';
}

function reflowOverlays(){
  ['askOverlay','settingsModal','authGate'].forEach(id=>{
    const el=document.getElementById(id);
    if(el && el.style.display!=='none') centreOnFirstScreen(el);
  });
}

function snapSplitToScreen(){
  const pane=document.getElementById('paneBlotter'), ws=document.getElementById('workspace');
  if(!pane||!ws) return;
  const rect=ws.getBoundingClientRect();
  const seam=screenSeam();
  const target=seam ? (seam-rect.left) : (rect.width/2);
  const w=Math.max(240,Math.min(target,rect.width-360));
  pane.style.width=w+'px'; pane.style.flex='none';
  sSet({nw_split_w:w});
  toast(seam?'Split snapped to the screen edge':'Split centred','i');
}

// ═══ MODE ═══
const MODE_LABEL = {
  live: ['Alert Editor',''],
  correct: ['Correction', 'file a corrected chain'],
  withdraw: ['Withdraw', 'kill the whole chain']
};

function setMode(next){
  mode = MODE_LABEL[next] ? next : 'live';
  document.querySelectorAll('.tab[data-mode]').forEach(t=>t.classList.toggle('on',t.dataset.mode===mode));
  document.getElementById('dockAlert').classList.toggle('on',mode==='live');
  document.getElementById('dockCorrect').classList.toggle('on',mode==='correct');
  document.getElementById('dockWithdraw').classList.toggle('on',mode==='withdraw');
  const tab=document.getElementById('aeDockTab'); if(tab) tab.textContent=MODE_LABEL[mode][0];
  const scope=document.getElementById('aeScope'); if(scope) scope.textContent=MODE_LABEL[mode][1]?('· '+MODE_LABEL[mode][1]):'';
  if(mode==='correct') renderCorrectPanel();
  if(mode==='withdraw') renderWithdrawPanel();
}

function syncEmbargoTab(){
  document.querySelectorAll('.tab[data-float="embargo"]').forEach(t=>t.classList.toggle('on',Embargo.isOpen()));
}

// ═══ CLEARING AND DELETING ═══
function toggleClearMenu(){
  const m=document.getElementById('clearMenu'); if(!m) return;
  const open = m.style.display === 'none';
  m.style.display = open ? 'block' : 'none';
  if(open){
    setTimeout(()=>document.addEventListener('click', closeClearMenuOnce, { once:true }), 0);
  }
}
function closeClearMenuOnce(){
  const m=document.getElementById('clearMenu'); if(m) m.style.display='none';
}

function clearAllReleases(){
  closeClearMenuOnce();
  if(!stories.length){ toast('No releases to clear','i'); return; }
  askYesNo(
    'Clear the wire for everyone?\n\nThis removes every release and all published snaps for every signed-in trainee, not just on this screen. It cannot be undone.',
    doClearAllReleases
  );
}

function enterPickMode(){
  closeClearMenuOnce();
  const real = stories.filter(s => s.serverId);
  if(!real.length){ toast('Nothing on the wire to delete','i'); return; }
  pickMode = true;
  picked.clear();
  document.getElementById('pickBar').style.display = 'flex';
  document.getElementById('pickAll').checked = false;
  renderBlotter();
  updatePickCount();
}

function exitPickMode(){
  pickMode = false;
  picked.clear();
  const bar=document.getElementById('pickBar'); if(bar) bar.style.display='none';
  renderBlotter();
}

function updatePickCount(){
  const n = picked.size;
  const count=document.getElementById('pickCount');
  const btn=document.getElementById('pickDelete');
  if(count) count.textContent = n ? (n + ' release' + (n===1?'':'s') + ' selected') : 'none selected';
  if(btn){ btn.disabled = n === 0; btn.textContent = n ? ('Delete ' + n) : 'Delete'; }
}

function paintPick(serverId){
  const localId = serverIdToLocal.get(serverId);
  const tr = localId ? document.querySelector('#blotterBody tr[data-id="' + localId + '"]') : null;
  if(!tr) return;
  const on = picked.has(serverId);
  tr.classList.toggle('picked', on);
  const cb = tr.querySelector('[data-pick-id]');
  if(cb && cb.checked !== on) cb.checked = on;
}

function togglePick(serverId){
  if(!serverId) return;
  if(picked.has(serverId)) picked.delete(serverId); else picked.add(serverId);
  paintPick(serverId);
  syncPickAllBox();
  updatePickCount();
}

function togglePickAll(){
  const on = document.getElementById('pickAll').checked;
  picked.clear();
  if(on) stories.forEach(s => { if(s.serverId) picked.add(s.serverId); });
  stories.forEach(s => { if(s.serverId) paintPick(s.serverId); });
  updatePickCount();
}

function syncPickAllBox(){
  const box = document.getElementById('pickAll'); if(!box) return;
  const total = stories.filter(s => s.serverId).length;
  box.checked = total > 0 && picked.size === total;
}

function confirmDeletePicked(){
  const n = picked.size;
  if(!n) return;
  askYesNo(
    'Delete ' + n + ' release' + (n===1?'':'s') + ' for everyone?\n\n'
    + 'Each one takes its published snaps with it, on every trainee\'s screen. It cannot be undone.',
    doDeletePicked
  );
}

async function doDeletePicked(){
  const ids=[...picked];
  if(!ids.length) return;
  const btn=document.getElementById('pickDelete');
  if(btn){ btn.disabled=true; btn.textContent='Deleting…'; }
  try{
    await WireSync.deleteReleases(ids);
    removeReleasesLocally(ids);
    toast(ids.length + ' release' + (ids.length===1?'':'s') + ' deleted for everyone','s');
  }catch(e){
    toast('Could not delete: '+(e.message||'try again'),'r');
  }finally{
    exitPickMode();
  }
}

function removeReleasesLocally(ids){
  const kill = new Set(ids);
  const goingIds = stories.filter(s => s.serverId && kill.has(s.serverId)).map(s => s.id);
  if(!goingIds.length) return;
  stories = stories.filter(s => !goingIds.includes(s.id));
  goingIds.forEach(id => {
    const s = storyById[id];
    if(s && s.serverId) serverIdToLocal.delete(s.serverId);
    delete storyById[id];
  });
  if(goingIds.includes(selectedId)){
    selectedId = null;
    document.getElementById('readerHeadline').innerHTML = 'Select a release';
    document.getElementById('readerSub').innerHTML = '';
    document.getElementById('readerBody').innerHTML =
      '<div class="reader-placeholder">That release was deleted. Pick another from the list.</div>';
    renderCoverFlag(null);
    renderPubHistory(); renderActivity();
    renderCorrectPanel(); renderWithdrawPanel();
  }
  renderBlotter();
}

async function doClearAllReleases(){
  try{ await WireSync.clearWire(); }
  catch(e){ toast('Could not clear the wire: '+(e.message||'try again'),'r'); return; }
  resetLocalView();
  toast('Wire cleared for everyone','s');
}

function resetLocalView(){
  serverIdToLocal.clear();
  stories = [];
  storyById = {};
  selectedId = null;
  nextId = 1;

  document.getElementById('readerHeadline').innerHTML = 'Select a release';
  document.getElementById('readerSub').innerHTML = '';
  const rb=document.getElementById('readerBody');
  if(rb) rb.innerHTML='<div class="reader-placeholder">The full formatted release body appears here. Highlight any text to send it to the Alert Editor.</div>';

  const aeBody=document.getElementById('aeBody'); if(aeBody) aeBody.value='';
  updateAeCharCount();
  const wa=document.getElementById('withdrawAdvisory'); if(wa) wa.value='';
  renderCoverFlag(null);
  document.getElementById('dockAE').style.display='';
  document.getElementById('dockPH').style.display='';
  showArchive=false;

  renderBlotter();
  renderPubHistory();
  renderActivity();
  renderCorrectPanel();
  renderWithdrawPanel();
}

// ═══ AUTHOR ═══
function requireName(){
  if(snapperName && Auth.isSignedIn()) return true;
  toast('Sign in before publishing','w');
  return false;
}

// ═══ PREFS ═══
function loadPrefs() {
  sGet(['nw_hl_keywords','nw_autosnap','nw_split_w'],r=>{
    highlightKeywords=(r.nw_hl_keywords&&r.nw_hl_keywords.length)?r.nw_hl_keywords:[...DEFAULT_HIGHLIGHT_KEYWORDS];
    document.getElementById('templateKeywords').value=highlightKeywords.join(', ');
    autoSnapOn = (r.nw_autosnap===undefined) ? true : !!r.nw_autosnap;
    const at=document.getElementById('autoSnapToggle'); if(at) at.checked=autoSnapOn;
    savedSplitW = r.nw_split_w || 0;
    applySavedSplit();
  });
}

let savedSplitW = 0;
function applySavedSplit(){
  if(!savedSplitW) return;
  const pane=document.getElementById('paneBlotter'), ws=document.getElementById('workspace');
  if(!pane||!ws) return;
  const total=ws.getBoundingClientRect().width;
  if(total<400) return;
  pane.style.width=Math.max(240,Math.min(savedSplitW,total-360))+'px';
  pane.style.flex='none';
}
function saveTemplate(){
  const raw=document.getElementById('templateKeywords').value;
  highlightKeywords=raw.split(',').map(s=>s.trim()).filter(Boolean);
  sSet({nw_hl_keywords:highlightKeywords},()=>{toast('Keywords saved','s');if(selectedId)renderReader(storyById[selectedId]);});
}

// ═══ SEND RELEASES ═══
function renderSendReleases(){
  const counter=document.getElementById('srCounter');
  if(counter) counter.textContent=stagedReleases.length+' / '+MAX_RELEASES+' staged';

  const host=document.getElementById('srStaged');
  if(host){
    if(!stagedReleases.length){ host.innerHTML=''; }
    else {
      let h='';
      stagedReleases.forEach((r,i)=>{
        let mode, label;
        if(r.mode==='paste'){
          mode='PASTE';
          label = r.headline ? r.headline : (deriveSource(r.text,'') || (r.text||'').slice(0,60) || 'Pasted release');
        } else {
          mode = ReleaseBuilder.detectSourceType(r.url).toUpperCase();
          label = r.headline ? r.headline : r.url;
        }
        const srcChip = (r.source && r.source.trim())
          ? '<span class="sr-mode" title="Snap source">'+esc(r.source.trim())+':</span>'
          : '';
        h+='<div class="sr-staged-row">'
          +'<span class="sr-badge">'+(i+1)+'</span>'
          +'<span class="sr-hl" title="'+esc(r.headline?r.headline:(r.mode==='paste'?'Pasted release text':r.url))+'">'+esc(label)+'</span>'
          +srcChip
          +'<span class="sr-mode">'+mode+'</span>'
          +'<button class="sr-del" data-idx="'+i+'" title="Remove">✕</button>'
          +'</div>';
      });
      host.innerHTML=h;
      host.querySelectorAll('.sr-del').forEach(b=>b.addEventListener('click',()=>{ stagedReleases.splice(parseInt(b.dataset.idx,10),1); renderSendReleases(); }));
    }
  }

  const draftHost=document.getElementById('srDraftHost');
  if(draftHost){
    if(stagedReleases.length>=MAX_RELEASES){
      draftHost.innerHTML='<div class="sr-maxed">Maximum '+MAX_RELEASES+' releases staged. Send them or remove one to add more.</div>';
    } else {
      draftHost.innerHTML=
        '<div class="sr-draft">'
        +'<label>Snap source (required — the prefix on every snap, e.g. WELLS FARGO)</label>'
        +'<input type="text" id="srDraftSource" maxlength="120" placeholder="e.g. WELLS FARGO">'
        +'<label>Headline (required)</label>'
        +'<input type="text" id="srDraftHeadline" placeholder="e.g. Statement regarding possible offer for easyJet plc">'
        +'<label>Paste release text (recommended — paste the full RNS announcement here)</label>'
        +'<textarea id="srDraftText" rows="6" placeholder="Paste the entire RNS release text here…"></textarea>'
        +'<label>…or Release URL (static HTML page or PDF only — JS-rendered pages like LSE will not work)</label>'
        +'<input type="text" id="srDraftUrl" placeholder="https://www.example.com/news/… or …/report.pdf">'
        +'<div class="sr-draft-actions"><button class="s-btn pri" id="btnStageDraft">Save</button></div>'
        +'</div>';
      const b=document.getElementById('btnStageDraft'); if(b) b.addEventListener('click',stageDraft);
      const u=document.getElementById('srDraftUrl'); if(u) u.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();stageDraft();} });
    }
  }

  const sendAll=document.getElementById('btnSendAll');
  if(sendAll) sendAll.disabled = stagedReleases.length===0;
}

function stageDraft(){
  const text=(document.getElementById('srDraftText')?.value||'').trim();
  const url=(document.getElementById('srDraftUrl')?.value||'').trim();
  const headline=(document.getElementById('srDraftHeadline')?.value||'').trim();
  // The snap source — the prefix in front of every snap off this release.
  // Required. Capped to match the server's MAX_SOURCE.
  const source=(document.getElementById('srDraftSource')?.value||'').trim().slice(0,120);

  if(stagedReleases.length>=MAX_RELEASES){ toast('Max '+MAX_RELEASES+' releases','w'); return; }
  if(!source){ toast('Enter the snap source','w'); document.getElementById('srDraftSource')?.focus(); return; }
  if(!headline){ toast('Enter the headline','w'); document.getElementById('srDraftHeadline')?.focus(); return; }

  if(text){
    if(text.length < 40){ toast('That looks too short to be a release','w'); return; }
    stagedReleases.push({ mode:'paste', text, headline, source });
    renderSendReleases();
    setTimeout(()=>{ const e=document.getElementById('srDraftSource'); if(e)e.focus(); },40);
    return;
  }

  if(url){
    if(!/^https?:\/\//i.test(url)){ toast('URL must start with http(s)://','w'); return; }
    stagedReleases.push({ mode:'url', url, headline, source });
    renderSendReleases();
    setTimeout(()=>{ const e=document.getElementById('srDraftSource'); if(e)e.focus(); },40);
    return;
  }

  toast('Paste release text (or add a URL) first','w');
}

async function sendAllReleases(){
  if(!stagedReleases.length){ toast('Nothing staged','w'); return; }
  const btn=document.getElementById('btnSendAll');
  btn.disabled=true; const old=btn.textContent; btn.textContent='Processing…';

  const batch=[...stagedReleases];
  stagedReleases=[];
  let sent=0, firstNewServerId=null, totalSnaps=0;

  for(const r of batch){
    try{
      let formatted=null, kind='html', link='';

      if(r.mode==='paste'){
        formatted = formatPastedText(r.text);
        kind='paste';
        link='';
      } else {
        let resp=null;
        try{ resp=await WireClient.fetchArticle(r.url); }
        catch(fe){ toast('Skipped a URL ('+(fe.message||'fetch failed')+')','w'); continue; }
        if(!resp || !resp.kind){ toast('Skipped a URL (nothing came back)','w'); continue; }
        try{
          formatted = await ReleaseFormatter.format({
            kind: resp.kind,
            data: resp.text,
            base64: resp.base64,
            url: resp.sourceUrl || r.url
          });
        }catch(fe){ toast('Skipped a URL (parse failed: '+fe.message+')','w'); continue; }
        kind = resp.kind;
        link = r.url;
      }

      // A PDF legitimately has no html (it renders from base64); accept it if it
      // has base64 OR text. HTML releases still need html or text.
      const hasBody = formatted && (formatted.html || formatted.text || false);
      if(!hasBody){ toast('Skipped a release (empty body)','w'); continue; }

      const title = r.headline || formatted.title || ReleaseBuilder.guessHeadline(formatted.text || '');
      // User-typed snap source wins; blank falls back to auto-detection.
      const source = (r.source && r.source.trim()) || deriveSource(formatted.text || '', title);

      // PDFs are converted to wire-compatible HTML at inject time (text, not a visual copy).
      const bodyHtmlOut = formatted.html || '';
      let injected=null;
      try{
        injected = await WireSync.inject([{
          title, kind, source,
          sourceUrl: link,
          bodyHtml: bodyHtmlOut,
          bodyText: formatted.text || ''
        }]);
      }catch(ie){ toast('Could not send to the wire: '+(ie.message||'failed'),'r'); continue; }

      const res = (injected && injected.results && injected.results[0]) || {};
      if(!res.ok){ toast('Release rejected: '+(res.error||'unknown reason'),'w'); continue; }
      sent++;
      if(firstNewServerId===null) firstNewServerId=res.id;

      if(autoSnapOn){
        try{
          const result = SnapEngine.snap({ bodyText: formatted.text || '', headline: title, sourceOverride: source });
          for(const sn of (result.snaps || [])){
            try{ await WireSync.publish(res.id, sn.text, res.id, true); totalSnaps++; }
            catch(pe){ console.warn('auto-snap publish failed: ' + (pe && pe.message)); }
          }
        }catch(se){ console.warn('Auto-snap failed for a release:', se); }
      }
    }catch(e){ toast('One release failed: '+e.message,'r'); }
  }

  renderSendReleases();
  closeSettings();
  btn.disabled=false; btn.textContent=old;

  try{
    const s = await WireSync.loadState();
    applySnapshot(s.releases, s.history, { archives: s.archives, activity: s.activity, embargoes: s.embargoes });
    if(firstNewServerId && serverIdToLocal.has(firstNewServerId)) selectStory(serverIdToLocal.get(firstNewServerId));
  }catch(e){ console.warn('post-inject resync failed: ' + (e && e.message)); }

  toast(sent+' release'+(sent===1?'':'s')+' sent to the wire'+(autoSnapOn?(' · '+totalSnaps+' auto-snap'+(totalSnaps===1?'':'s')):''),'s');
}

// ═══ SPLITTER ═══
function initSplitters() { makeSplitter('split1','paneBlotter'); }
function makeSplitter(id, paneId) {
  const sp=document.getElementById(id), pane=document.getElementById(paneId), ws=document.getElementById('workspace');
  if(!sp||!pane) return;
  let dragging=false, lastW=0;
  sp.addEventListener('mousedown',e=>{dragging=true;document.body.style.cursor='col-resize';e.preventDefault();});
  window.addEventListener('mousemove',e=>{ if(!dragging)return;
    const rect=ws.getBoundingClientRect();
    let w=e.clientX-rect.left; w=Math.max(240,Math.min(w,rect.width-360)); pane.style.width=w+'px'; pane.style.flex='none';
    lastW=w;
  });
  window.addEventListener('mouseup',()=>{
    if(dragging){ dragging=false; document.body.style.cursor=''; if(lastW) sSet({nw_split_w:lastW}); }
  });
  sp.addEventListener('dblclick',snapSplitToScreen);
}

// ═══ DOCK RESIZERS ═══
function initDockResizers() {
  makeDockResizer('dockResizeAE','dockAE');
  makeDockResizer('dockResizePH','dockPH');
}
function makeDockResizer(handleId, dockId) {
  const handle=document.getElementById(handleId), dock=document.getElementById(dockId);
  if(!handle||!dock) return;
  let dragging=false, startY=0, startH=0;
  handle.addEventListener('mousedown',e=>{ dragging=true; startY=e.clientY; startH=dock.getBoundingClientRect().height; document.body.style.cursor='row-resize'; e.preventDefault(); });
  window.addEventListener('mousemove',e=>{ if(!dragging)return;
    const pane=dock.parentElement; const paneH=pane.getBoundingClientRect().height;
    let h=startH+(startY-e.clientY);
    h=Math.max(80,Math.min(h,paneH-140));
    dock.style.height=h+'px';
  });
  window.addEventListener('mouseup',()=>{ if(dragging){dragging=false;document.body.style.cursor='';} });
}

// ═══ SETTINGS DRAG + RESIZE ═══
function initSettingsDragResize(){
  const panel=document.getElementById('settingsPanel');
  const header=document.getElementById('settingsHeader');
  const resize=document.getElementById('settingsResize');
  if(!panel||!header) return;

  let placed=false;
  function ensurePlaced(){
    if(placed) return;
    const r=panel.getBoundingClientRect();
    panel.style.left=r.left+'px'; panel.style.top=r.top+'px'; panel.style.transform='none';
    placed=true;
  }

  let dragging=false, dx=0, dy=0;
  header.addEventListener('mousedown',e=>{
    if(e.target.id==='btnCloseSettings') return;
    ensurePlaced();
    dragging=true; const r=panel.getBoundingClientRect(); dx=e.clientX-r.left; dy=e.clientY-r.top;
    document.body.style.cursor='move'; e.preventDefault();
  });
  window.addEventListener('mousemove',e=>{
    if(!dragging)return;
    let nx=e.clientX-dx, ny=e.clientY-dy;
    nx=Math.max(0,Math.min(nx,window.innerWidth-80));
    ny=Math.max(0,Math.min(ny,window.innerHeight-40));
    panel.style.left=nx+'px'; panel.style.top=ny+'px';
  });
  window.addEventListener('mouseup',()=>{ if(dragging){dragging=false;document.body.style.cursor='';} });

  if(resize){
    let rz=false, sw=0, sh=0, sx=0, sy=0;
    resize.addEventListener('mousedown',e=>{
      ensurePlaced();
      rz=true; const r=panel.getBoundingClientRect(); sw=r.width; sh=r.height; sx=e.clientX; sy=e.clientY;
      document.body.style.cursor='nwse-resize'; e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove',e=>{
      if(!rz)return;
      let w=sw+(e.clientX-sx), h=sh+(e.clientY-sy);
      w=Math.max(420,Math.min(w,window.innerWidth-20));
      h=Math.max(280,Math.min(h,window.innerHeight-20));
      panel.style.width=w+'px'; panel.style.height=h+'px';
    });
    window.addEventListener('mouseup',()=>{ if(rz){rz=false;document.body.style.cursor='';} });
  }
}

// ═══ STORIES ═══
function addStory(item){
  const id=nextId++;
  const story={ ...item, id, status:'ready',
    timeDisplay:hms(new Date(item.detectedAt||Date.now())), detectedAt:item.detectedAt||Date.now(),
    bodyHtml:item.bodyHtml||'', bodyText:item.bodyText||'', source:item.source||'',
    chain:[], version:1,
    archive:[],
    withdrawn:null,
    activity:[],
    covered:false
  };
  item.__id=id;
  stories.unshift(story); storyById[id]=story;
  if(stories.length>1000){ const drop=stories.pop(); delete storyById[drop.id]; }
  return story;
}

// ═══ SHARED WIRE ═══
const serverIdToLocal = new Map();

function tagFromText(text){
  const t = String(text || '');
  if (/^CORRECTED\s*-\s*/i.test(t)) return 'CORRECTED';
  if (/^RPT\s*-\s*/i.test(t)) return 'RPT';
  return '';
}

function snapFromServer(h){
  return {
    author: h.author || '—',
    time: hms(new Date(Number(h.createdAt) || Date.now())),
    text: h.alert || '',
    tag: h.tag || tagFromText(h.alert),
    flagged: !!h.wrong,
    rowKey: h.rowKey || '',
    serverId: h.id || ''
  };
}

// Build a story from a server release, carrying coverage + withdrawal state.
function storyFromServer(rel){
  const existing = serverIdToLocal.get(rel.id);
  if (existing && storyById[existing]){
    const s = storyById[existing];
    if (rel.bodyHtml) s.bodyHtml = rel.bodyHtml;
    if (rel.bodyText) s.bodyText = rel.bodyText;
    if (rel.wireNo) s.wireNo = Number(rel.wireNo) || s.wireNo;
    applyReleaseState(s, rel);
    return s;
  }
  const story = addStory({
    title: rel.headline || '(untitled release)',
    bodyHtml: rel.bodyHtml || '',
    bodyText: rel.bodyText || '',
    link: rel.sourceUrl || '',
    detectedAt: Number(rel.createdAt) || Date.now(),
    kind: rel.kind || 'html',
    source: rel.source || '',
    feedId: 'TRN'
  });
  story.serverId = rel.id;
  story.wireNo = Number(rel.wireNo || 0) || '';   // cosmetic 1–100; '' for pre-upgrade releases
  serverIdToLocal.set(rel.id, story.id);
  applyReleaseState(story, rel);
  return story;
}

// Coverage + withdrawal state the server folds onto a release row.
function applyReleaseState(story, rel){
  story.covered = !!rel.covered;
  story.coveredBy = rel.coveredBy || '';
  if (rel.withdrawn){
    story.withdrawn = {
      by: rel.withdrawnBy || '—',
      time: hms(new Date(Number(rel.withdrawnAt) || Date.now())),
      advisory: rel.withdrawnAdvisory || ''
    };
  }
}

// Rebuild everything from a server snapshot, including the shared extras.
function applySnapshot(releases, history, extras){
  const ex = extras || {};
  stories = []; storyById = {}; nextId = 1; serverIdToLocal.clear();
  const ordered = (releases || []).slice().sort((a,b) => Number(a.createdAt||0) - Number(b.createdAt||0));
  for (const rel of ordered){
    const story = storyFromServer(rel);
    const chain = (history && history[rel.id]) || [];
    story.chain = chain.slice().sort((a,b) => Number(a.createdAt||0) - Number(b.createdAt||0)).map(snapFromServer);
    // Archived (superseded) chains for this release.
    const arch = ex.archives && ex.archives[rel.id];
    if (arch){
      story.archive = Object.keys(arch)
        .map(v => arch[v])
        .sort((a,b) => Number(a.version||0) - Number(b.version||0))
        .map(a => ({
          v: a.version,
          reason: a.reason,
          by: a.by,
          time: hms(new Date(Number(a.at) || Date.now())),
          advisory: a.reason === 'withdrawal' ? (a.note || '') : '',
          snaps: (a.snaps || []).slice().sort((x,y)=>Number(x.createdAt||0)-Number(y.createdAt||0)).map(snapFromServer)
        }));
      story.version = story.archive.length + 1;
    }
    // Shared headline activity for this release.
    const acts = ex.activity && ex.activity[rel.id];
    if (acts){
      story.activity = acts.map(a => ({
        time: hms(new Date(Number(a.createdAt) || Date.now())),
        who: a.who || '—',
        what: a.what || '',
        id: a.id
      }));
    }
  }
  renderBlotter();
  // Shared embargo bundles.
  if (window.Embargo && Embargo.applySnapshot) Embargo.applySnapshot(ex.embargoes || []);
  if (selectedId && storyById[selectedId]) selectStory(selectedId);
  else { renderPubHistory(); renderActivity(); }
}

function applyPublishedRow(p){
  if(!p || !p.chain) return;
  const localId = serverIdToLocal.get(p.chain);
  const story = localId ? storyById[localId] : null;
  if(!story) return;
  if(!Array.isArray(story.chain)) story.chain = [];
  if(p.rowKey && story.chain.some(c => c.rowKey === p.rowKey)) return;
  story.chain.push(snapFromServer(p));
  if(story.id === selectedId) renderPubHistory();
}

// ── Shared correction applied from the server (own action or broadcast). ──
// Idempotent on version: if we've already recorded this archived version, skip.
function applyCorrection(p){
  if(!p || !p.chain) return;
  const localId = serverIdToLocal.get(p.chain);
  const story = localId ? storyById[localId] : null;
  if(!story) return;
  if(!Array.isArray(story.archive)) story.archive = [];
  const archivedV = Number(p.archivedVersion || 0);
  if(archivedV && story.archive.some(a => a.v === archivedV)) {
    // Already applied this correction.
    return;
  }
  // Archive the chain we currently show as the superseded version.
  if((story.chain || []).length){
    story.archive.push({
      v: archivedV || (story.version || 1),
      reason: 'correction',
      by: p.by || '—',
      time: hms(new Date(Number(p.at) || Date.now())),
      advisory: '',
      snaps: (story.chain || []).slice()
    });
  }
  story.version = Number(p.version || (story.version || 1) + 1);
  story.chain = (p.newChain || []).map(snapFromServer);
  story.withdrawn = null;
  if(story.id === selectedId){ showArchive = false; renderPubHistory(); renderCorrectPanel(); }
}

// ── Shared withdrawal applied from the server. ──
function applyWithdrawal(p){
  if(!p || !p.chain) return;
  const localId = serverIdToLocal.get(p.chain);
  const story = localId ? storyById[localId] : null;
  if(!story) return;
  if(!Array.isArray(story.archive)) story.archive = [];
  const archivedV = Number(p.archivedVersion || 0);
  if(archivedV && story.archive.some(a => a.v === archivedV && a.reason === 'withdrawal')) return;
  if((story.chain || []).length){
    story.archive.push({
      v: archivedV || (story.version || 1),
      reason: 'withdrawal',
      by: p.by || '—',
      time: hms(new Date(Number(p.at) || Date.now())),
      advisory: p.advisory || '',
      snaps: (story.chain || []).slice()
    });
  }
  story.version = (story.version || 1) + 1;
  story.chain = [];
  story.withdrawn = {
    by: p.by || '—',
    time: hms(new Date(Number(p.at) || Date.now())),
    advisory: p.advisory || ''
  };
  if(story.id === selectedId){ showArchive = true; renderPubHistory(); renderWithdrawPanel(); }
}

// ── Shared activity entry applied from the server. ──
function applyActivity(p){
  if(!p || !p.release) return;
  const localId = serverIdToLocal.get(p.release);
  const story = localId ? storyById[localId] : null;
  if(!story) return;
  if(!Array.isArray(story.activity)) story.activity = [];
  if(p.id && story.activity.some(a => a.id === p.id)) return;
  story.activity.unshift({
    time: hms(new Date(Number(p.createdAt) || Date.now())),
    who: p.who || '—',
    what: p.what || '',
    id: p.id
  });
  if(story.activity.length > 300) story.activity.pop();
  if(story.id === selectedId) renderActivity();
}

// ── Shared coverage flag applied from the server. ──
function applyCover(p){
  if(!p || !p.release) return;
  const localId = serverIdToLocal.get(p.release);
  const story = localId ? storyById[localId] : null;
  if(!story) return;
  story.covered = !!p.covered;
  story.coveredBy = p.covered ? (p.by || '') : '';
  renderBlotter();
  if(story.id === selectedId) renderCoverFlag(story);
}

const CONN_STATES = {
  online:       ['conn-live',       'live',           'Connected — releases and snaps are shared with everyone'],
  connecting:   ['conn-connecting', 'connecting…', 'Connecting to the shared wire'],
  reconnecting: ['conn-connecting', 'reconnecting…', 'Connection dropped — trying again'],
  offline:      ['conn-offline',    'offline',        'Not connected. You will still see the wire when you reload, but not the moment someone files']
};

function setConnStatus(state){
  const el = document.getElementById('conn-status'); if (!el) return;
  const known = CONN_STATES[state];
  if (!known) console.warn('unmapped realtime status: ' + state);
  const [cls, text, title] = known || CONN_STATES.offline;
  el.className = 'conn-status ' + cls;
  const label = el.querySelector('.conn-label');
  if (label) label.textContent = text;
  el.title = title;
}

// ═══ HEADLINE ACTIVITY ═══
// Now SHARED: an entry is sent to the server, which stores and broadcasts it.
// applyActivity (from our own response and from the broadcast) is what adds it
// to the feed, so the whole cohort sees the same Headline Activity.
function logActivity(story, what){
  if(!story || !story.serverId) return;
  WireSync.activity(story.serverId, what).catch(e => {
    console.warn('activity log failed: ' + (e && e.message));
  });
}

function renderActivity(){
  const el=document.getElementById('dockActivity'); if(!el) return;
  const s=selectedId?storyById[selectedId]:null;
  if(!s){ el.innerHTML='<div class="dock-empty">Select a release to see who has worked on it.</div>'; return; }
  const acts=s.activity||[];
  if(!acts.length){ el.innerHTML='<div class="dock-empty">Nothing recorded for this release yet.</div>'; return; }
  let h='<table class="act-table"><thead><tr>'
    +'<th style="width:130px">Who</th><th style="width:82px">Time</th><th>Activity</th>'
    +'</tr></thead><tbody>';
  acts.forEach(a=>{
    h+='<tr><td class="act-who">'+esc(a.who)+'</td>'
      +'<td class="act-time">'+esc(a.time)+'</td>'
      +'<td class="act-what">'+a.what+'</td></tr>';
  });
  h+='</tbody></table>';
  el.innerHTML=h;
}

// ═══ COVERAGE FLAG (shared) ═══
async function toggleCoverFlag(){
  if(!requireName()) return;
  const s=selectedId?storyById[selectedId]:null;
  if(!s || s.isBundle) return;
  if(!s.serverId){ toast('That release is not on the shared wire yet','w'); return; }
  const want = !s.covered;
  const b=document.getElementById('btnCoverFlag'); if(b) b.disabled=true;
  try{
    const res = await WireSync.cover(s.serverId, want);
    // Apply straight away; the broadcast echo is harmless (same value).
    s.covered = !!res.covered;
    s.coveredBy = res.by || '';
    logActivity(s, s.covered
      ? '<span class="act-flag">Flagged</span> as fully covered'
      : '<span class="act-unflag">Unflagged</span> — something was missed, release reopened');
    renderCoverFlag(s);
    renderBlotter();
    toast(s.covered?'Flagged as covered for everyone':'Unflagged — release reopened', s.covered?'s':'w');
  }catch(e){
    toast('Could not update coverage: '+(e.message||'try again'),'r');
  }finally{
    if(b) b.disabled=false;
  }
}

function renderCoverFlag(s){
  const b=document.getElementById('btnCoverFlag'); if(!b) return;
  if(!s || s.isBundle){ b.style.display='none'; return; }
  b.style.display='';
  b.classList.toggle('on', !!s.covered);
  b.textContent = s.covered ? '⚑ Flagged' : '⚑ Flag';
  b.title = s.covered
    ? 'Covered'+(s.coveredBy?(' by '+esc(s.coveredBy)):'')+' — click to unflag if something was missed'
    : 'Mark this release as fully covered';
}

// ═══ BLOTTER RENDER ═══
function currentView(){
  const q=(document.getElementById('findStory').value||'').toLowerCase();
  let view=stories.filter(s=>{
    if(q){
      // A pure number matches the wire number exactly; otherwise it's free text
      // across headline / source / feed, as before.
      if(/^\d{1,3}$/.test(q)){ if(String(s.wireNo||'') !== String(parseInt(q,10))) return false; }
      else if(!((s.title+' '+s.feedName+' '+s.feedId+' '+(s.source||'')).toLowerCase().includes(q))) return false;
    }
    return true;
  });
  view.sort((a,b)=>{
    let av,bv;
    if(sortKey==='time'){av=a.detectedAt;bv=b.detectedAt;}
    else if(sortKey==='id'){av=Number(a.wireNo)||0;bv=Number(b.wireNo)||0;}
    else if(sortKey==='head'){av=a.title.toLowerCase();bv=b.title.toLowerCase();}
    else if(sortKey==='src'){av=(a.source||a.feedId).toLowerCase();bv=(b.source||b.feedId).toLowerCase();}
    if(av<bv)return -1*sortDir; if(av>bv)return 1*sortDir; return 0;
  });
  return view;
}
function renderBlotter(){
  const body=document.getElementById('blotterBody'); if(!body)return;
  const view=currentView();
  if(!view.length){ body.innerHTML='<tr class="empty-row"><td colspan="5">Open Settings → Send Releases to inject a training release.</td></tr>'; return; }
  let h='';
  view.forEach((s)=>{
    const breaking=(Date.now()-s.detectedAt)<8000;
    const cls=(s.id===selectedId?'selected ':'')+(breaking?'breaking ':'')+(s.covered?'covered ':'');
    const src = s.source || s.feedId;
    const pill = s.isBundle
      ? '<span class="b-emb'+(s.bundleStatus==='queued'?' pending':'')+'">'+(s.bundleStatus==='queued'?'PENDING':'EMBARGO')+'</span>'
      : '';
    const isPicked = pickMode && s.serverId && picked.has(s.serverId);
    // Cosmetic wire number (1–100, server-generated, non-unique). Bundles have
    // none. data-wireno lets the Find box match by number (templates-stitch.js).
    const wireNo = s.isBundle ? '' : (s.wireNo || '');
    const dateDisp = new Date(s.detectedAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short' });
    h+='<tr class="'+(cls+(pickMode?'picking ':'')+(isPicked?'picked ':'')).trim()+'" data-id="'+s.id+'" data-wireno="'+esc(String(wireNo))+'">'
      +(pickMode
        ? '<td class="b-pick">'+(s.serverId
            ? '<input type="checkbox" data-pick-id="'+esc(s.serverId)+'"'+(isPicked?' checked':'')+'>'
            : '')+'</td>'
        : '')
      +'<td class="b-time">'+esc(s.timeDisplay)+'</td>'
      +'<td class="b-date">'+esc(dateDisp)+'</td>'
      +'<td class="b-id"><span class="b-wireno">'+esc(String(wireNo))+'</span></td>'
      +'<td class="b-head" title="'+esc(s.title)+'">'+pill+(s.covered?'<span class="b-cov" title="Flagged as fully covered">⚑</span> ':'')+esc(s.title)+'</td>'
      +'<td class="b-src" title="'+esc(src)+'">'+esc(src)+'</td>'
      +'</tr>';
  });
  body.innerHTML=h;
  const head=document.querySelector('#blotter thead tr');
  if(head){
    const existing=head.querySelector('th.c-pick');
    if(pickMode && !existing){ const th=document.createElement('th'); th.className='c-pick'; head.insertBefore(th, head.firstChild); }
    if(!pickMode && existing) existing.remove();
  }
  body.querySelectorAll('tr[data-id]').forEach(tr=>tr.addEventListener('click',(e)=>{
    if(pickMode){
      const s=storyById[parseInt(tr.dataset.id,10)];
      if(s && s.serverId && e.target.tagName!=='INPUT') togglePick(s.serverId);
      return;
    }
    selectStory(parseInt(tr.dataset.id,10));
  }));
  body.querySelectorAll('[data-pick-id]').forEach(cb=>cb.addEventListener('change',()=>togglePick(cb.dataset.pickId)));
}

// ═══ SELECT + READER ═══
function selectStory(id){
  selectedId=id; renderBlotter();
  const s=storyById[id]; if(!s)return;
  renderReader(s);
  renderCoverFlag(s);
  try{ window.TemplatesStitch?.setContext({ company: (s.source||'') }); }catch(e){}
  const isB=!!s.isBundle;
  document.getElementById('dockAE').style.display = isB ? 'none' : '';
  document.getElementById('dockPH').style.display = isB ? 'none' : '';
  if(isB) return;
  showArchive=false;
  renderPubHistory();
  renderActivity();
  setAeToSourcePrefix();
  if(mode==='correct') renderCorrectPanel();
  if(mode==='withdraw') renderWithdrawPanel();
}

function highlightNode(root){
  const moneyRe=/(£\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|mln|bln|bn|m))?|\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|mln|bln))?|\b\d[\d,]*(?:\.\d+)?\s?(?:pence|p)\b)/gi;
  const pctRe=/(\d+(?:\.\d+)?\s?(?:%|per cent\.?|percent))/gi;
  const dateRe1=/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/gi;
  const dateRe2=/(\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/gi;
  const kwList=highlightKeywords.filter(Boolean).map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const kwRe=kwList.length?new RegExp('\\b('+kwList.join('|')+')\\b','gi'):null;

  const walker=document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const targets=[];
  let n; while((n=walker.nextNode())){ if(n.nodeValue && n.nodeValue.trim()) targets.push(n); }

  targets.forEach(textNode=>{
    let html=esc(textNode.nodeValue);
    html=html.replace(moneyRe,'\u0001M\u0002$1\u0003');
    html=html.replace(pctRe,'\u0001P\u0002$1\u0003');
    html=html.replace(dateRe1,'\u0001D\u0002$1\u0003');
    html=html.replace(dateRe2,'\u0001D\u0002$1\u0003');
    if(kwRe) html=html.replace(kwRe,'\u0001K\u0002$1\u0003');
    html=html
      .replace(/\u0001M\u0002/g,'<mark class="hl hl-money">').replace(/\u0001P\u0002/g,'<mark class="hl hl-pct">')
      .replace(/\u0001D\u0002/g,'<mark class="hl hl-date">').replace(/\u0001K\u0002/g,'<mark class="hl hl-kw">')
      .replace(/\u0003/g,'</mark>');
    if(html!==esc(textNode.nodeValue)){
      const span=document.createElement('span'); span.innerHTML=html;
      textNode.parentNode.replaceChild(span, textNode);
    }
  });
}

function renderReader(s){
  document.getElementById('readerHeadline').innerHTML=esc(s.title);
  const co=s.source||'';
  const bits=[];
  if(co) bits.push('<span class="co">'+esc(co)+'</span>');
  bits.push('<span class="meta">'+esc(s.feedId)+'</span>');
  bits.push('<span>'+esc(s.timeDisplay)+'</span>');
  bits.push('<span class="meta">'+esc((s.kind||'html').toUpperCase())+'</span>');
  if(s.link) bits.push('<a href="'+esc(s.link)+'" target="_blank">Open ↗</a>');
  document.getElementById('readerSub').innerHTML=bits.join('<span class="sep">·</span>');

  const rb=document.getElementById('readerBody');
  if(s.isBundle){
    rb.innerHTML=bundleBodyHtml(s);
    rb.style.fontSize=(document.getElementById('zoom').value||13)+'px';
    return;
  }
  // Older PDF releases still carry raw base64 behind __PDFB64__. Convert them to
  // wire-compatible text on read instead of drawing the PDF.
  if(typeof s.bodyHtml==='string' && s.bodyHtml.startsWith('__PDFB64__')){
    rb.innerHTML='<div class="reader-placeholder">Preparing PDF text…</div>';
    const sid=s.id;
    ReleaseFormatter.formatPdf(s.bodyHtml.slice('__PDFB64__'.length)).then(f=>{
      if(selectedId!==sid) return;
      rb.innerHTML=ReleaseFormatter.sanitizeStored(f.html);
      try{ highlightNode(rb); }catch(e){}
    }).catch(()=>{ if(selectedId===sid) rb.innerHTML='<p class="rl-p">'+esc(s.bodyText||'(No body text available.)')+'</p>'; });
  } else if(s.bodyHtml){
    rb.classList.remove('pdf-reader');
    // Defence in depth: stored HTML goes through the read-time sanitizer.
    try{ rb.innerHTML = ReleaseFormatter.sanitizeStored(s.bodyHtml); }
    catch(e){ rb.innerHTML = s.bodyHtml; }
    try{ highlightNode(rb); }catch(e){}
  } else {
    rb.classList.remove('pdf-reader');
    rb.innerHTML='<p class="rl-p">'+esc(s.bodyText||'(No body text available.)')+'</p>';
  }
  rb.style.fontSize=(document.getElementById('zoom').value||13)+'px';
}

// ═══ EMBARGO BUNDLES ON THE WIRE ═══
function bundleBodyHtml(s){
  const b=s.bundle||{};
  // Release-based bundles are published by hand; show WHEN, not just by whom.
  // embargoLabel() formats a timestamp the same way the time-based branch does.
  const pubWhen = b.publishedAt ? embargoLabel(b.publishedAt) : '';
  const when=b.kind==='time'
    ? (s.bundleStatus==='queued'
        ? 'Queued to release at <b>'+esc(s.embargoLabel)+'</b>. Nothing has gone out yet.'
        : 'Released at <b>'+esc(s.embargoLabel)+'</b>.')
    : (s.bundleStatus==='published'
        ? 'Release-based embargo, published by hand by <b>'+esc(b.publishedBy||b.createdBy||'—')+'</b>'
          +(pubWhen?' at <b>'+esc(pubWhen)+'</b>':'')+'.'
        : 'Release-based embargo, held — not yet published. Set up by <b>'+esc(b.createdBy||'—')+'</b>.');
  let h='<div class="emb-rl">'
    +'<div class="emb-rl-note">'+when+'<br>Bundle of '+(b.alerts||[]).length+' snap'
    +((b.alerts||[]).length===1?'':'s')+', set up by <b>'+esc(b.createdBy||'—')+'</b>.</div>';
  (b.alerts||[]).forEach(a=>{
    const meta=[
      a.meta?.products&&('Products: '+a.meta.products),
      a.meta?.topics&&('Topics: '+a.meta.topics),
      a.meta?.rics&&('RICs: '+a.meta.rics),
      a.meta?.named&&('Named Items: '+a.meta.named),
      a.meta?.language&&('Language: '+a.meta.language)
    ].filter(Boolean).join(' · ');
    h+='<div class="emb-rl-snap">'+esc(a.text)+'</div>';
    if(meta) h+='<div class="emb-rl-meta">'+esc(meta)+'</div>';
  });
  return h+'</div>';
}

function embargoLabel(ts){
  if(!ts) return '';
  const d=new Date(ts), pad=(n)=>String(n).padStart(2,'0');
  return pad(d.getDate())+' '+d.toLocaleString('en-GB',{month:'short'}).toUpperCase()+' '+d.getFullYear()
    +' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
}

// When a bundle actually crossed the wire. A time-based bundle crosses at its
// releasedAt (or embargoAt as a floor); a release-based one at publishedAt. A
// still-queued time-based bundle has not crossed yet, so it sorts by its
// embargo time (when it WILL cross). Everything falls back to createdAt. This
// is what the blotter sorts on, so a release injected after an embargo crossed
// correctly appears above it, and the embargo no longer pins itself to the top.
function bundleWireTime(b){
  if(!b) return Date.now();
  if(b.status==='released') return Number(b.releasedAt || b.embargoAt || b.createdAt || Date.now());
  if(b.status==='published') return Number(b.publishedAt || b.createdAt || Date.now());
  if(b.kind==='time') return Number(b.embargoAt || b.createdAt || Date.now());
  return Number(b.createdAt || Date.now());
}

// A bundle becomes a row on the Releases page. Keyed by bundle.id (a server
// UUID now), so the same bundle from a snapshot and from a broadcast is one row.
function putBundleOnWire(bundle){
  const when=bundleWireTime(bundle);
  const existing=stories.find(x=>x.isBundle && x.bundle && x.bundle.id===bundle.id);
  if(existing){
    existing.bundle=bundle;
    existing.bundleStatus=bundle.status;
    existing.title=bundle.title;
    existing.embargoLabel=embargoLabel(bundle.embargoAt);
    // Re-stamp to the real crossing time so ordering tracks the status change
    // (queued -> released, held -> published), not the moment it was filed.
    existing.detectedAt=when;
    existing.timeDisplay=hms(new Date(when));
    renderBlotter();
    if(existing.id===selectedId) renderReader(existing);
    return existing;
  }
  const story=addStory({
    title: bundle.title,
    bodyHtml:'', bodyText:(bundle.alerts||[]).map(a=>a.text).join('\n'),
    link:'', detectedAt:when, kind:'embargo',
    source:'EMBARGO', feedId:'TRN'
  });
  story.isBundle=true;
  story.bundle=bundle;
  story.bundleStatus=bundle.status;
  story.embargoLabel=embargoLabel(bundle.embargoAt);
  renderBlotter();
  return story;
}

// ═══ ALERT EDITOR ═══
function aeSourcePrefix(){
  const s=selectedId?storyById[selectedId]:null;
  const src=((s&&s.source)||'').trim().toUpperCase();
  return src ? src+': ' : '';
}
function setAeToSourcePrefix(){
  const el=document.getElementById('aeBody'); if(!el) return;
  el.value=aeSourcePrefix();
  updateAeCharCount();
}
function aeSetSnapText(text){
  const el=document.getElementById('aeBody'); if(!el) return;
  const m=(el.value||'').match(/^([^:]{1,60}:\s*)/);
  el.value=((m?m[1]:aeSourcePrefix())+text).toUpperCase();
  updateAeCharCount();
}
// Appends to the snap body after the SOURCE: prefix, space-joined. Used by
// Ctrl/Cmd-select stitching so several fragments build one snap.
function aeAppendSnapText(text){
  const el=document.getElementById('aeBody'); if(!el) return;
  const m=(el.value||'').match(/^([^:]{1,60}:\s*)/);
  const prefix = m ? m[1] : aeSourcePrefix();
  const bodyNow = (el.value||'').slice(prefix.length).trim();
  const joined = (bodyNow ? (bodyNow + ' ' + text) : text);
  el.value = (prefix + joined).toUpperCase();
  updateAeCharCount();
}

function captureSelection(ev){
  const sel=window.getSelection ? window.getSelection() : null;
  if(!sel) return;
  const text=(sel.toString()||'').replace(/\s+/g,' ').trim();
  if(!text) return;
  const rb=document.getElementById('readerBody');
  if(rb && sel.anchorNode && !rb.contains(sel.anchorNode)) return;

  // Keep templates' ~selected~ in step with the live highlight.
  try{ window.TemplatesStitch?.setSelected(stripArticles(text), !!(ev && (ev.ctrlKey || ev.metaKey))); }catch(e){}

  // STITCHING: holding Ctrl (Win/Linux) or Cmd (Mac) while selecting APPENDS
  // the fragment to the current snap instead of replacing it, so a snap can be
  // assembled from several highlights. A plain select replaces, as before.
  const stitch = !!(ev && (ev.ctrlKey || ev.metaKey));
  if(stitch) aeAppendSnapText(stripArticles(text));
  else aeSetSnapText(stripArticles(text));
}
function resetAlertEditorBody(){
  try{ window.TemplatesStitch?.setSelected(''); }catch(e){}
  const el=document.getElementById('aeBody'); if(!el) return;
  if(el.value===aeSourcePrefix()) return;
  setAeToSourcePrefix();
}
function aeComposed(){
  const line=(document.getElementById('aeBody').value||'').trim().toUpperCase();
  return /^[^:]{1,60}:$/.test(line) ? '' : line;
}
function updateAeCharCount(){
  const line=aeComposed();
  const el=document.getElementById('aeCharCount'); if(!el)return;
  const n=line.length; el.textContent=n+' chars'; el.classList.toggle('over',n>150);
}
async function publishFromAlertEditor(){
  if(!requireName()) return;
  const s=selectedId?storyById[selectedId]:null;
  if(!s){ toast('Select a release first','w'); return; }
  if(s.isBundle){ toast('Embargo bundles are filed from the Embargoes panel','w'); return; }
  const line=aeComposed();
  if(!line){ toast('Nothing to publish — highlight text or type a snap','w'); return; }
  if(!s.serverId){ toast('That release is not on the shared wire yet','w'); return; }

  const btn=document.getElementById('aePublish');
  if(btn) btn.disabled=true;
  try{
    const row = await WireSync.publish(s.serverId, line, s.serverId);
    applyPublishedRow(row);
    setAeToSourcePrefix();
    // Headline Activity is shared now — everyone sees who filed what.
    logActivity(s,'Filed a snap: <span class="act-kw">'+esc(line.slice(0,70))+(line.length>70?'…':'')+'</span>');
    toast('Published to the wire','s');
  }catch(e){
    toast('Publish failed: '+(e.message||'try again'),'r');
  }finally{
    if(btn) btn.disabled=false;
  }
}

function loadSnapIntoEditor(index){
  const s=selectedId?storyById[selectedId]:null;
  if(!s || !Array.isArray(s.chain)) return;
  const entry=s.chain[index];
  if(!entry) return;
  const aeBody=document.getElementById('aeBody');
  if(aeBody){ aeBody.value=String(entry.text||'').toUpperCase(); }
  try{ window.TemplatesStitch?.loadText(entry.text); }catch(e){}
  updateAeCharCount();
  toast('Loaded into Alert Editor','i');
}

// ═══ PUBLISH HISTORY ═══
function appendSnap(story, entry){
  if(!story) return;
  if(!Array.isArray(story.chain)) story.chain=[];
  story.chain.push({
    author: entry.author || '—', time: hms(new Date()),
    text: entry.text || '', tag: entry.tag || '',
    category: entry.category || '', flagged: false
  });
  if(story.chain.length>500) story.chain.shift();
  if(story.id===selectedId) renderPubHistory();
}
const addToHistory = appendSnap;

async function toggleSnapFlag(index){
  const s=selectedId?storyById[selectedId]:null;
  if(!s || !Array.isArray(s.chain)) return;
  const entry=s.chain[index];
  if(!entry) return;
  if(!s.serverId || !entry.rowKey){
    entry.flagged=!entry.flagged;
    renderPubHistory();
    return;
  }
  const want=!entry.flagged;
  try{
    await WireSync.flag(s.serverId, entry.rowKey, want);
    entry.flagged=want;
    renderPubHistory();
    toast(want ? 'Flagged as wrong for everyone' : 'Flag removed', want ? 'w' : 'i');
  }catch(e){
    toast('Could not flag: '+(e.message||'try again'),'r');
  }
}

function chainRows(chain, opts){
  const o=opts||{};
  let h='';
  chain.slice().reverse().forEach(p=>{
    const i=chain.indexOf(p);
    const flagged=!!p.flagged;
    const cls=[flagged?'ph-flagged':'', o.struck?'ph-row-wd':''].filter(Boolean).join(' ');
    h+='<tr'+(cls?' class="'+cls+'"':'')+(o.clickable?' data-load="'+i+'" title="Click to load into the Alert Editor"':'')+'>'
      +'<td class="ph-author">'+esc(p.author)+'</td>'
      +'<td class="ph-time">'+esc(p.time)+'</td>'
      +'<td class="ph-text">'+esc(p.text)+'</td>'
      +'<td class="ph-flagcell">'
      +(o.clickable
        ? '<button class="ph-x'+(flagged?' active':'')+'" data-hidx="'+i+'" title="'+(flagged?'Marked wrong — click to clear':'Mark this snap as wrong')+'" aria-pressed="'+flagged+'">✕</button>'
        : '')
      +'</td></tr>';
  });
  return h;
}

function phTableOpen(){
  return '<table class="ph-table"><thead><tr>'
    +'<th style="width:130px">Author</th>'
    +'<th style="width:82px">Publish Time</th>'
    +'<th>Alert text</th>'
    +'<th class="c-flag" title="Flag a wrong snap">Flag</th>'
    +'</tr></thead><tbody>';
}

function renderPubHistory(){
  const el=document.getElementById('dockPubhist'); if(!el)return;
  const scope=document.getElementById('phScope');
  const s=selectedId?storyById[selectedId]:null;
  if(scope) scope.textContent = s ? ('· Chain #'+s.id+(s.version>1?(' v'+s.version):'')) : '';

  if(!s){ el.innerHTML='<div class="dock-empty">Select a release to see its publish history.</div>'; return; }

  const chain=s.chain||[];
  const arch=s.archive||[];
  let h='';

  if(s.withdrawn){
    h+='<div class="ph-wd-banner"><b>CHAIN WITHDRAWN</b> by '+esc(s.withdrawn.by)+' at '+esc(s.withdrawn.time)
      +'<br>Advisory: '+esc(s.withdrawn.advisory)+'</div>';
  }

  if(arch.length){
    h+='<div class="ph-arch-bar">'
      +'<button class="ph-arch-btn" id="phArchToggle">'+(showArchive?'Hide':'Show')+' previous chain'+(arch.length>1?'s ('+arch.length+')':'')+'</button>'
      +'<span class="ph-arch-note">'+(s.withdrawn?'The withdrawn chain is kept here.':'Replaced by a correction — the original is kept here.')+'</span>'
      +'</div>';
  }

  if(!chain.length && !s.withdrawn){
    h+='<div class="dock-empty">No published snaps for this release yet. Auto-snaps appear here on arrival; publish more from the Alert Editor.</div>';
  } else if(chain.length){
    h+=phTableOpen()+chainRows(chain,{clickable:true})+'</tbody></table>';
  }

  if(showArchive && arch.length){
    arch.slice().reverse().forEach(a=>{
      h+='<div class="ph-arch">'
        +'<div class="ph-arch-hdr"><b>v'+a.v+'</b> · '+esc(a.reason==='withdrawal'?'withdrawn':'corrected')
        +' by '+esc(a.by)+' at '+esc(a.time)
        +(a.advisory?(' · advisory: '+esc(a.advisory)):'')+'</div>'
        +phTableOpen()+chainRows(a.snaps,{struck:true})+'</tbody></table>'
        +'</div>';
    });
  }

  el.innerHTML=h;
  const at=document.getElementById('phArchToggle');
  if(at) at.addEventListener('click',()=>{ showArchive=!showArchive; renderPubHistory(); });
  el.querySelectorAll('.ph-x').forEach(b=>b.addEventListener('click',(e)=>{ e.stopPropagation(); toggleSnapFlag(parseInt(b.dataset.hidx,10)); }));
  el.querySelectorAll('tr[data-load]').forEach(tr=>tr.addEventListener('click',()=>loadSnapIntoEditor(parseInt(tr.dataset.load,10))));
}

// ═══ CORRECTION (shared) ═══
function renderCorrectPanel(){
  const host=document.getElementById('correctChain'); if(!host) return;
  const s=selectedId?storyById[selectedId]:null;
  const count=document.getElementById('correctCount');

  if(!s || s.isBundle){ host.innerHTML='<div class="chain-empty">Pick a release from the list to correct its chain.</div>'; if(count)count.textContent=''; return; }
  if(s.withdrawn){ host.innerHTML='<div class="chain-empty">This chain was withdrawn. There is nothing live to correct.</div>'; if(count)count.textContent=''; return; }
  const chain=s.chain||[];
  if(!chain.length){ host.innerHTML='<div class="chain-empty">Nothing has been filed off this release yet, so there is nothing to correct.</div>'; if(count)count.textContent=''; return; }

  let h='';
  chain.forEach((p,i)=>{
    h+='<div class="chain-row" data-row="'+i+'">'
      +'<input type="checkbox" class="chain-pick" data-pick="'+i+'" title="This snap was wrong">'
      +'<span class="chain-tag rpt" data-tag="'+i+'">RPT</span>'
      +'<textarea class="chain-text" data-text="'+i+'" rows="2" spellcheck="false" readonly>'+esc(p.text)+'</textarea>'
      +'<span class="chain-author">'+esc(p.author)+'</span>'
      +'</div>';
  });
  host.innerHTML=h;

  host.querySelectorAll('[data-pick]').forEach(cb=>cb.addEventListener('change',()=>{
    const i=cb.dataset.pick;
    const row=host.querySelector('[data-row="'+i+'"]');
    const tag=host.querySelector('[data-tag="'+i+'"]');
    const ta=host.querySelector('[data-text="'+i+'"]');
    const on=cb.checked;
    row?.classList.toggle('picked',on);
    if(tag){ tag.className='chain-tag '+(on?'cor':'rpt'); tag.textContent=on?'CORRECTED':'RPT'; }
    if(ta){
      ta.readOnly=!on;
      if(on && !/^CORRECTED\s+-\s+/i.test(ta.value)) ta.value='CORRECTED - '+ta.value;
      if(!on) ta.value=ta.value.replace(/^CORRECTED\s+-\s+/i,'');
      if(on){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
    updateCorrectCount();
  }));
  host.querySelectorAll('[data-text]').forEach(ta=>ta.addEventListener('input',()=>{ ta.value=ta.value.toUpperCase(); updateCorrectCount(); }));
  updateCorrectCount();
}

function updateCorrectCount(){
  const host=document.getElementById('correctChain');
  const count=document.getElementById('correctCount'); if(!host||!count) return;
  const picked=host.querySelectorAll('[data-pick]:checked').length;
  const total=host.querySelectorAll('[data-pick]').length;
  count.textContent = total ? (picked+' corrected · '+(total-picked)+' repeated · '+total+' snaps refiled') : '';
}

// Files the corrected chain to the SERVER, which archives the old one, replaces
// the live one and broadcasts. applyCorrection (from our response + broadcast)
// updates the view for everyone.
async function fileCorrection(){
  if(!requireName()) return;
  const s=selectedId?storyById[selectedId]:null;
  if(!s || s.isBundle){ toast('Pick a release first','w'); return; }
  if(!s.serverId){ toast('That release is not on the shared wire yet','w'); return; }
  if(s.withdrawn){ toast('That chain was withdrawn — nothing to correct','w'); return; }
  const host=document.getElementById('correctChain');
  const rows=[...host.querySelectorAll('[data-row]')];
  if(!rows.length){ toast('Nothing to correct','w'); return; }

  const picked=rows.filter(r=>r.querySelector('[data-pick]').checked);
  if(!picked.length){ toast('Tick the snap that was wrong first','w'); return; }

  const bad=picked.find(r=>{
    const v=r.querySelector('[data-text]').value.trim();
    return !v || /^CORRECTED\s*-\s*$/i.test(v);
  });
  if(bad){ toast('Write the corrected wording before filing','w'); bad.querySelector('[data-text]').focus(); return; }

  // Build the full new chain, oldest first, each with its tag.
  const snaps=rows.map(r=>{
    const on=r.querySelector('[data-pick]').checked;
    const raw=r.querySelector('[data-text]').value.trim().toUpperCase();
    const text = on ? raw : ('RPT - '+raw.replace(/^RPT\s+-\s+/i,''));
    return { text, tag: on ? 'CORRECTED' : 'RPT' };
  });

  const nCor=picked.length, nRpt=snaps.length-nCor;
  const btn=document.getElementById('correctFile'); if(btn) btn.disabled=true;
  try{
    const res = await WireSync.correct(s.serverId, snaps,
      nCor+' corrected, '+nRpt+' repeated');
    // Apply the server's answer straight away (broadcast echo is idempotent).
    applyCorrection({
      chain: s.serverId,
      version: res.version,
      archivedVersion: res.archivedVersion,
      by: snapperName,
      at: Date.now(),
      newChain: res.newChain
    });
    logActivity(s, 'Filed a <span class="act-kw">correction</span> — '+nCor+' corrected, '+nRpt+' repeated, whole chain refiled as v'+(res.version||((s.version||1))));
    renderCorrectPanel();
    toast('Correction filed for everyone — chain refiled as v'+(res.version||''),'s');
  }catch(e){
    toast('Could not file the correction: '+(e.message||'try again'),'r');
  }finally{
    if(btn) btn.disabled=false;
  }
}

// ═══ WITHDRAW (shared) ═══
function renderWithdrawPanel(){
  const host=document.getElementById('withdrawChain'); if(!host) return;
  const s=selectedId?storyById[selectedId]:null;
  const count=document.getElementById('withdrawCount');

  if(!s || s.isBundle){ host.innerHTML='<div class="chain-empty">Pick a release from the list to withdraw its chain.</div>'; if(count)count.textContent=''; return; }
  if(s.withdrawn){
    host.innerHTML='<div class="chain-empty">Already withdrawn by '+esc(s.withdrawn.by)+' at '+esc(s.withdrawn.time)+'.</div>';
    if(count)count.textContent='';
    return;
  }
  const chain=s.chain||[];
  if(!chain.length){ host.innerHTML='<div class="chain-empty">Nothing has been filed off this release, so there is nothing to withdraw.</div>'; if(count)count.textContent=''; return; }

  let h='';
  chain.slice().reverse().forEach(p=>{
    h+='<div class="chain-row">'
      +'<span class="chain-tag rpt">'+esc(p.tag||'LIVE')+'</span>'
      +'<textarea class="chain-text" rows="2" readonly spellcheck="false">'+esc(p.text)+'</textarea>'
      +'<span class="chain-author">'+esc(p.author)+'</span>'
      +'</div>';
  });
  host.innerHTML=h;
  if(count) count.textContent=chain.length+' snap'+(chain.length===1?'':'s')+' will be withdrawn';
}

async function fileWithdrawal(){
  if(!requireName()) return;
  const s=selectedId?storyById[selectedId]:null;
  if(!s || s.isBundle){ toast('Pick a release first','w'); return; }
  if(!s.serverId){ toast('That release is not on the shared wire yet','w'); return; }
  if(s.withdrawn){ toast('That chain is already withdrawn','w'); return; }
  const chain=(s.chain||[]).slice();
  if(!chain.length){ toast('Nothing to withdraw','w'); return; }

  const adv=(document.getElementById('withdrawAdvisory').value||'').trim().toUpperCase();
  if(!adv){ toast('Type the advisory — why is the chain being withdrawn?','w'); document.getElementById('withdrawAdvisory').focus(); return; }

  const ok=window.confirm('Withdraw all '+chain.length+' snap'+(chain.length===1?'':'s')+' on chain #'+s.id+' for everyone?\n\nThe whole chain is withdrawn — this is not per-snap. It stays readable in Publish History.');
  if(!ok) return;

  const btn=document.getElementById('withdrawFile'); if(btn) btn.disabled=true;
  try{
    const res = await WireSync.withdraw(s.serverId, adv);
    applyWithdrawal({
      chain: s.serverId,
      archivedVersion: res.archivedVersion,
      by: snapperName,
      advisory: adv,
      at: Date.now()
    });
    logActivity(s, '<span class="act-wd">Withdrew</span> the chain ('+chain.length+' snap'+(chain.length===1?'':'s')+') — advisory: '+esc(adv));
    document.getElementById('withdrawAdvisory').value='';
    renderWithdrawPanel();
    toast('Chain withdrawn for everyone','s');
  }catch(e){
    toast('Could not withdraw the chain: '+(e.message||'try again'),'r');
  }finally{
    if(btn) btn.disabled=false;
  }
}
