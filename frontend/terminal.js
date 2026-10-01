// Training Wire — Controller v3.9
// Paste-first release injection: paste raw RNS text (always works, fully offline)
// OR add a static HTML/PDF URL. RNS-aware SOURCE detection (reads the company under
// "RNS Number"). Rule-based Auto-Snap engine auto-publishes snaps as author "Auto"
// the moment a release lands. Manual Alert Editor is the human publish path (with
// article-stripping). Click any published snap → loads it into the Alert Editor.
// Per-snap "wrong" flagging, Clear-all.
//
// v3.9: the author name comes from the signed-in account (see auth.js) instead of
// a free-text toolbar field, the snap is a single line with the source inside it
// rather than a separate boxed field, and PDF export is gone.
console.log('Training Wire: Controller v3.9');

// ═══ STATE ═══
let stories = [];
let storyById = {};
let nextId = 1;
let selectedId = null;

let sortKey = 'time', sortDir = -1;
let highlightKeywords = [];
let snapperName = '';
let autoSnapOn = true;

// Which list the left pane is showing, and therefore which editor the right
// pane offers: file a snap, correct a chain, or withdraw one.
let mode = 'live';              // 'live' | 'correct' | 'withdraw'
let phTab = 'pubhist';          // 'pubhist' | 'activity'
let showArchive = false;        // superseded chains visible in Publish History

const MAX_RELEASES = 25;
let stagedReleases = [];          // { mode:'url'|'paste', url?, text?, headline }

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
// No getUA() here any more: URL fetching happens in the API, which sets its own
// User-Agent. The browser never makes that request.

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
// An SEC EDGAR filing page is titled "Filing Detail", which is not a source.
// The source is the filer, which EDGAR prints as "NAME (Filer) CIK: …" — or
// "(Filed by)" on the acquirer side of a 13D/G, where the subject company is
// tagged "(Subject)" instead. Preference order follows that: whoever filed it.
const EDGAR_HINT = /\bSEC Accession No\b|\bEDGAR\b|\bFiling Detail\b/i;
const EDGAR_ROLE = ['Filer', 'Filed by', 'Subject'];

// Address words and US state codes. EDGAR prints the filer's mailing and
// business addresses immediately before its name, and in the extracted text
// the whole block runs together on one line:
//
//   Business Address 3555 FARNAM STREET OMAHA NE 68131 4023461400
//   BERKSHIRE HATHAWAY INC (Filer) CIK: 0001067983
//
// So the name cannot be found by taking a fixed window of characters before
// "(Filer)" — that swallows the address. Instead walk back word by word from
// the marker and stop at the first thing a company name cannot contain.
const FILER_ADDR_WORD = /^(?:address|mailing|business|street|avenue|ave|road|rd|suite|ste|floor|fl|box|drive|boulevard|blvd|lane|plaza|parkway|pkwy|po|p\.?o\.?)$/i;
const FILER_STATE = /^(?:a[lkzr]|c[aot]|de|fl|ga|hi|i[adln]|k[sy]|la|m[adeinost]|n[cdehjmvy]|o[hkr]|pa|ri|s[cd]|t[nx]|ut|v[at]|w[aivy]|dc)$/i;

function filerNameBefore(tail){
  const toks = String(tail).split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = toks.length - 1; i >= 0 && out.length < 8; i--){
    const tok = toks[i];
    const bare = tok.replace(/[.,]+$/, '');
    if (/[()]/.test(tok)) break;                       // another marker, e.g. "(formerly X)"
    if (/^\d[\d\-]*$/.test(bare)) break;               // ZIP, phone, street number
    if (FILER_ADDR_WORD.test(bare)) break;             // "Business Address", "STREET"
    if (out.length && FILER_STATE.test(bare)) break;   // "OMAHA NE" -> stop at NE
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

// ═══ PASTED TEXT → formatted HTML + clean plain text ═══
// Splits pasted RNS text into paragraphs / bullets, escapes it, and returns the same
// { title, html, text } shape the formatter produces — so the rest of the pipeline
// (source detection, snap engine, reader) is identical for pasted and fetched releases.
function formatPastedText(raw){
  const text = String(raw || '').replace(/\r\n?/g, '\n').replace(/\u00A0/g, ' ');
  // Blank line → paragraph boundary. Single newlines inside a block are kept as breaks.
  const blocks = text.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
  const isBullet = (l) => /^\s*(?:[•‣▪◦·\-–—\*]|\(?\d{1,2}[\.\)]|\([a-z]\))\s+/.test(l);

  let html = '';
  for (const block of blocks){
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    // If most lines in the block look like bullets, render a list.
    const bulletCount = lines.filter(isBullet).length;
    if (lines.length > 1 && bulletCount >= Math.ceil(lines.length * 0.6)){
      html += '<ul class="rl-list">';
      for (const l of lines){
        const clean = l.replace(/^\s*(?:[•‣▪◦·\-–—\*]|\(?\d{1,2}[\.\)]|\([a-z]\))\s+/, '');
        html += '<li>' + esc(clean) + '</li>';
      }
      html += '</ul>';
    } else {
      // Join wrapped lines into one paragraph.
      const para = lines.join(' ').replace(/\s+/g, ' ').trim();
      if (para) html += '<p class="rl-p">' + esc(para) + '</p>';
    }
  }

  // Plain text (normalised) for source detection, snap engine and keyword search.
  // We KEEP single newlines so the RNS metadata block ("RNS Number" on its own line,
  // company on the next line) survives — the source detector relies on that.
  const plain = text.split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Title guess = first meaningful line that isn't RNS boilerplate.
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
  Embargo.init({ onFile: putBundleOnWire, whoAmI: () => snapperName || '—' });
  window.addEventListener('resize', reflowOverlays);
  reflowOverlays();
  // The gate covers the whole tool until someone signs in. The username they
  // registered with is the author name on every snap they file.
  Auth.init({ onSignedIn: (acct) => {
    snapperName = acct.username;
    renderWho(acct);
    // The tool is only now visible, so anything that needs real measurements
    // has to run here rather than at DOMContentLoaded.
    applySavedSplit();
    reflowOverlays();
    toast('Signed in as ' + acct.username, 's');
  }});
});

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
  bind('btnClearReleases','click',clearAllReleases);

  bind('autoSnapToggle','change',()=>{ autoSnapOn=document.getElementById('autoSnapToggle').checked; sSet({nw_autosnap:autoSnapOn}); toast(autoSnapOn?'Auto-snap ON':'Auto-snap OFF', autoSnapOn?'s':'i'); });

  bind('findStory','input',renderBlotter);
  document.querySelectorAll('.blotter th.sortable').forEach(th=>th.addEventListener('click',()=>{
    const k=th.dataset.sort; if(sortKey===k) sortDir=-sortDir; else {sortKey=k; sortDir=-1;} renderBlotter();
  }));

  // Releases / Correction / Withdraw pick the editor. Embargoes is a floating
  // panel instead, so the wire stays visible behind it.
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
    // One click in the release body discards the staged snap. mouseup fires
    // first, so a click that ENDS a selection still fills the editor — only a
    // click that leaves nothing selected clears it.
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

function openSettings(){ const m=document.getElementById('settingsModal'); m.style.display='grid'; centreOnFirstScreen(m); }
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
// The tool is meant to be stretched across two monitors: the releases list on
// one screen, the release body on the other. Two things follow from that.
//
// 1. The useful split is the bezel between the screens, not the middle of the
//    window. screenSeam() works out where that falls in window coordinates.
// 2. A dialog centred on the whole window lands ON the bezel, split in half.
//    centreOnFirstScreen() pads the overlay so it centres inside screen one.
function screenSeam(){
  try{
    const aw = window.screen && window.screen.availWidth;
    if(!aw) return 0;
    // Only treat it as spanning when the window is clearly wider than one screen.
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

// Put the divider on the screen edge, or mid-window on a single screen.
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

// ═══ CLEAR ALL RELEASES ═══
function clearAllReleases(){
  if(!stories.length){ toast('No releases to clear','i'); return; }
  const ok = window.confirm(
    'Clear ALL releases?\n\nThis removes every release AND its publish history, and resets the tool to its initial state. This cannot be undone.'
  );
  if(!ok) return;

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
  toast('All releases cleared','s');
}

// ═══ AUTHOR ═══
// The author name comes from the signed-in account, so there is nothing to
// validate at publish time beyond still being signed in.
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

// Where the divider was left last time — on a two-screen setup that is the
// bezel, and it should not have to be re-dragged every session.
//
// Applied again once the tool is revealed: #app-root starts hidden behind the
// auth gate, and a hidden element measures zero, so clamping against the
// workspace width while it is still hidden collapses the pane to its minimum.
let savedSplitW = 0;
function applySavedSplit(){
  if(!savedSplitW) return;
  const pane=document.getElementById('paneBlotter'), ws=document.getElementById('workspace');
  if(!pane||!ws) return;
  const total=ws.getBoundingClientRect().width;
  if(total<400) return;                       // still hidden — try again on reveal
  pane.style.width=Math.max(240,Math.min(savedSplitW,total-360))+'px';
  pane.style.flex='none';
}
function saveTemplate(){
  const raw=document.getElementById('templateKeywords').value;
  highlightKeywords=raw.split(',').map(s=>s.trim()).filter(Boolean);
  sSet({nw_hl_keywords:highlightKeywords},()=>{toast('Keywords saved','s');if(selectedId)renderReader(storyById[selectedId]);});
}

// ═══ SEND RELEASES (paste text OR URL, up to 15) ═══
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
        h+='<div class="sr-staged-row">'
          +'<span class="sr-badge">'+(i+1)+'</span>'
          +'<span class="sr-hl" title="'+esc(r.headline?r.headline:(r.mode==='paste'?'Pasted release text':r.url))+'">'+esc(label)+'</span>'
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
        +'<label>Headline (optional — leave blank to auto-detect)</label>'
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

  if(stagedReleases.length>=MAX_RELEASES){ toast('Max '+MAX_RELEASES+' releases','w'); return; }

  // Paste takes priority when both are filled.
  if(text){
    if(text.length < 40){ toast('That looks too short to be a release','w'); return; }
    stagedReleases.push({ mode:'paste', text, headline });
    renderSendReleases();
    setTimeout(()=>{ const e=document.getElementById('srDraftHeadline'); if(e)e.focus(); },40);
    return;
  }

  if(url){
    if(!/^https?:\/\//i.test(url)){ toast('URL must start with http(s)://','w'); return; }
    stagedReleases.push({ mode:'url', url, headline });
    renderSendReleases();
    setTimeout(()=>{ const e=document.getElementById('srDraftHeadline'); if(e)e.focus(); },40);
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
  let sent=0, firstNewId=null, totalSnaps=0;

  for(const r of batch){
    try{
      let formatted=null, kind='html', link='';

      if(r.mode==='paste'){
        // No network — format the pasted text directly.
        formatted = formatPastedText(r.text);
        kind='paste';
        link='';
      } else {
        // URL path — fetched by the API, not the browser. The server-side proxy
        // is what makes this work at all on a hosted page: a direct fetch from
        // the page would be blocked by CORS, and it is hardened there against
        // SSRF, oversized bodies and redirect loops.
        let resp=null;
        try{ resp=await WireClient.fetchArticle(r.url); }
        catch(fe){ toast('Skipped a URL ('+(fe.message||'fetch failed')+')','w'); continue; }
        if(!resp || !resp.success){ toast('Skipped a URL (fetch failed'+(resp&&resp.status?' '+resp.status:'')+')','w'); continue; }
        try{
          formatted = await ReleaseFormatter.format({ kind: resp.kind, data: resp.data, base64: resp.base64, url: resp.finalUrl || r.url });
        }catch(fe){ toast('Skipped a URL (parse failed: '+fe.message+')','w'); continue; }
        kind = resp.kind;
        link = r.url;
      }

      if(!formatted || (!formatted.html && !formatted.text)){ toast('Skipped a release (empty body)','w'); continue; }

      const title = r.headline || formatted.title || ReleaseBuilder.guessHeadline(formatted.text || '');
      const source = deriveSource(formatted.text || '', title);

      const item = ReleaseBuilder.buildRelease({ title, bodyHtml: formatted.html, bodyText: formatted.text, link });
      item.detectedAt=Date.now();
      item.kind=kind;
      item.source=source;
      const story=addStory(item);
      if(firstNewId===null) firstNewId=item.__id;
      sent++;

      // Headline Activity starts here: who put this release on the wire.
      logActivity(story, 'Entered the release onto the wire');

      // ── AUTO-SNAP ──
      if(autoSnapOn){
        try{
          const result = SnapEngine.snap({ bodyText: formatted.text || '', headline: title });
          if(result.source && (!story.source || story.source.length < 2)) story.source = result.source;
          const snaps = result.snaps || [];
          snaps.forEach(sn=>{
            appendSnap(story, { author: 'Auto', text: sn.text, category: sn.category });
            totalSnaps++;
          });
          if(snaps.length){
            story.activity.unshift({ time:hms(new Date()), who:'Auto',
              what:'Auto-snapped '+snaps.length+' alert'+(snaps.length===1?'':'s')+' on arrival' });
          }
        }catch(se){ console.warn('Auto-snap failed for a release:', se); }
      }
    }catch(e){ toast('One release failed: '+e.message,'r'); }
  }

  renderSendReleases();
  renderBlotter();
  if(firstNewId!==null) selectStory(firstNewId);
  closeSettings();
  btn.disabled=false; btn.textContent=old;
  toast(sent+' release'+(sent===1?'':'s')+' sent'+(autoSnapOn?(' · '+totalSnaps+' auto-snap'+(totalSnaps===1?'':'s')):''),'s');
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
  // Double-click drops the divider on the screen edge, so each monitor gets
  // one pane without fiddling.
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
    // The published snaps for this release, oldest first — a chain, not a log.
    // Corrections and withdrawals replace the whole thing, so order matters.
    chain:[], version:1,
    // Superseded chains, kept so the desk can still read what went out.
    archive:[],
    withdrawn:null,
    // Who did what to this release. "entered" is logged by the caller.
    activity:[],
    // Coverage flag: every story in this release has been snapped.
    covered:false
  };
  item.__id=id;
  stories.unshift(story); storyById[id]=story;
  if(stories.length>1000){ const drop=stories.pop(); delete storyById[drop.id]; }
  return story;
}

// ═══ HEADLINE ACTIVITY ═══
// Who touched this release, so a missed snap can be traced back to someone.
function logActivity(story, what){
  if(!story) return;
  if(!Array.isArray(story.activity)) story.activity=[];
  story.activity.unshift({ time:hms(new Date()), who:snapperName||'—', what:what||'' });
  if(story.activity.length>300) story.activity.pop();
  if(story.id===selectedId) renderActivity();
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

// ═══ COVERAGE FLAG ═══
// Flagged = this release is fully covered. Unflag it when something was
// missed, so it comes back into view and the reopen is on the record.
function toggleCoverFlag(){
  if(!requireName()) return;
  const s=selectedId?storyById[selectedId]:null;
  if(!s || s.isBundle) return;
  s.covered=!s.covered;
  logActivity(s, s.covered
    ? '<span class="act-flag">Flagged</span> as fully covered'
    : '<span class="act-unflag">Unflagged</span> — something was missed, release reopened');
  renderCoverFlag(s);
  renderBlotter();
  toast(s.covered?'Flagged as covered':'Unflagged — release reopened', s.covered?'s':'w');
}

function renderCoverFlag(s){
  const b=document.getElementById('btnCoverFlag'); if(!b) return;
  if(!s || s.isBundle){ b.style.display='none'; return; }
  b.style.display='';
  b.classList.toggle('on', !!s.covered);
  b.textContent = s.covered ? '⚑ Flagged' : '⚑ Flag';
  b.title = s.covered
    ? 'Covered by ' + esc(s.activity?.find(a=>/Flagged/.test(a.what))?.who || '—') + ' — click to unflag if something was missed'
    : 'Mark this release as fully covered';
}

// ═══ BLOTTER RENDER ═══
function currentView(){
  const q=(document.getElementById('findStory').value||'').toLowerCase();
  let view=stories.filter(s=>{
    if(q&&!((s.title+' '+s.feedName+' '+s.feedId+' '+(s.source||'')).toLowerCase().includes(q)))return false;
    return true;
  });
  view.sort((a,b)=>{
    let av,bv;
    if(sortKey==='time'){av=a.detectedAt;bv=b.detectedAt;}
    else if(sortKey==='id'){av=a.id;bv=b.id;}
    else if(sortKey==='head'){av=a.title.toLowerCase();bv=b.title.toLowerCase();}
    else if(sortKey==='src'){av=(a.source||a.feedId).toLowerCase();bv=(b.source||b.feedId).toLowerCase();}
    if(av<bv)return -1*sortDir; if(av>bv)return 1*sortDir; return 0;
  });
  return view;
}
function renderBlotter(){
  const body=document.getElementById('blotterBody'); if(!body)return;
  const view=currentView();
  if(!view.length){ body.innerHTML='<tr class="empty-row"><td colspan="4">Open Settings → Send Releases to inject a training release.</td></tr>'; return; }
  let h='';
  view.forEach((s)=>{
    const breaking=(Date.now()-s.detectedAt)<8000;
    const cls=(s.id===selectedId?'selected ':'')+(breaking?'breaking ':'')+(s.covered?'covered ':'');
    const src = s.source || s.feedId;
    // Bundles sit on the wire alongside real releases: PENDING until their
    // embargo lifts, then EMBARGO.
    const pill = s.isBundle
      ? '<span class="b-emb'+(s.bundleStatus==='queued'?' pending':'')+'">'+(s.bundleStatus==='queued'?'PENDING':'EMBARGO')+'</span>'
      : '';
    h+='<tr class="'+cls.trim()+'" data-id="'+s.id+'">'
      +'<td class="b-time">'+esc(s.timeDisplay)+'</td>'
      +'<td class="b-id">'+s.id+'</td>'
      +'<td class="b-head" title="'+esc(s.title)+'">'+pill+(s.covered?'<span class="b-cov" title="Flagged as fully covered">⚑</span> ':'')+esc(s.title)+'</td>'
      +'<td class="b-src" title="'+esc(src)+'">'+esc(src)+'</td>'
      +'</tr>';
  });
  body.innerHTML=h;
  body.querySelectorAll('tr[data-id]').forEach(tr=>tr.addEventListener('click',()=>selectStory(parseInt(tr.dataset.id,10))));
}

// ═══ SELECT + READER ═══
function selectStory(id){
  selectedId=id; renderBlotter();
  const s=storyById[id]; if(!s)return;
  renderReader(s);
  renderCoverFlag(s);
  // An embargo bundle is not a release you snap off: no alert editor, no
  // publish history. Its snaps are the body.
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

// Highlight keywords inside text nodes of the formatted HTML (never breaks tags).
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
  if(s.bodyHtml){
    rb.innerHTML=s.bodyHtml;
    try{ highlightNode(rb); }catch(e){}
  } else {
    rb.innerHTML='<p class="rl-p">'+esc(s.bodyText||'(No body text available.)')+'</p>';
  }
  rb.style.fontSize=(document.getElementById('zoom').value||13)+'px';
}

// ═══ EMBARGO BUNDLES ON THE WIRE ═══
// The body of a bundle row is the snaps themselves, with their metadata.
function bundleBodyHtml(s){
  const b=s.bundle||{};
  const when=b.kind==='time'
    ? (s.bundleStatus==='queued'
        ? 'Queued to release at <b>'+esc(s.embargoLabel)+'</b>. Nothing has gone out yet.'
        : 'Released at <b>'+esc(s.embargoLabel)+'</b>.')
    : 'Release-based embargo, published by hand by <b>'+esc(b.publishedBy||b.createdBy||'—')+'</b>.';
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

// A bundle becomes a row on the Releases page: queued time-based ones land
// immediately as PENDING, release-based ones only once published by hand.
function putBundleOnWire(bundle){
  const existing=stories.find(x=>x.isBundle && x.bundle && x.bundle.id===bundle.id);
  if(existing){
    existing.bundle=bundle;
    existing.bundleStatus=bundle.status;
    renderBlotter();
    if(existing.id===selectedId) renderReader(existing);
    return existing;
  }
  const story=addStory({
    title: bundle.title,
    bodyHtml:'', bodyText:(bundle.alerts||[]).map(a=>a.text).join('\n'),
    link:'', detectedAt:Date.now(), kind:'embargo',
    source:'EMBARGO', feedId:'TRN'
  });
  story.isBundle=true;
  story.bundle=bundle;
  story.bundleStatus=bundle.status;
  story.embargoLabel=embargoLabel(bundle.embargoAt);
  renderBlotter();
  return story;
}

// Fired by the embargo clock when a queued bundle's time arrives.
window.onEmbargoReleased = function(bundle){
  const story=stories.find(x=>x.isBundle && x.bundle && x.bundle.id===bundle.id);
  if(!story) { putBundleOnWire(bundle); return; }
  story.bundle=bundle;
  story.bundleStatus='released';
  story.detectedAt=Date.now();
  story.timeDisplay=hms(new Date());
  renderBlotter();
  if(story.id===selectedId) renderReader(story);
  toast('Embargo lifted — '+bundle.title,'s');
};

// ═══ ALERT EDITOR ═══
// A snap is ONE line — "SOURCE: BODY". The source is part of that text, not a
// separate field, so it can be edited, retagged ("CORRECTED - FORTERRA: …") or
// deleted like any other words.
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
// Replace the snap text while keeping whatever source prefix is already typed,
// so highlighting a second passage does not wipe an edited source.
function aeSetSnapText(text){
  const el=document.getElementById('aeBody'); if(!el) return;
  const m=(el.value||'').match(/^([^:]{1,60}:\s*)/);
  el.value=((m?m[1]:aeSourcePrefix())+text).toUpperCase();
  updateAeCharCount();
}
function captureSelection(){
  const sel=window.getSelection ? window.getSelection() : null;
  if(!sel) return;
  const text=(sel.toString()||'').replace(/\s+/g,' ').trim();
  if(!text) return;
  const rb=document.getElementById('readerBody');
  if(rb && sel.anchorNode && !rb.contains(sel.anchorNode)) return;
  aeSetSnapText(stripArticles(text));
}
// Clear and double-click both return to the bare source prefix, which is the
// editor's working state for the selected release.
function resetAlertEditorBody(){
  const el=document.getElementById('aeBody'); if(!el) return;
  if(el.value===aeSourcePrefix()) return;
  setAeToSourcePrefix();
}
function aeComposed(){
  const line=(document.getElementById('aeBody').value||'').trim().toUpperCase();
  // A bare "FORTERRA:" with no snap text is nothing to publish.
  return /^[^:]{1,60}:$/.test(line) ? '' : line;
}
function updateAeCharCount(){
  const line=aeComposed();
  const el=document.getElementById('aeCharCount'); if(!el)return;
  const n=line.length; el.textContent=n+' chars'; el.classList.toggle('over',n>150);
}
function publishFromAlertEditor(){
  if(!requireName()) return;
  const s=selectedId?storyById[selectedId]:null;
  if(!s){ toast('Select a release first','w'); return; }
  if(s.isBundle){ toast('Embargo bundles are filed from the Embargoes panel','w'); return; }
  const line=aeComposed();
  if(!line){ toast('Nothing to publish — highlight text or type a snap','w'); return; }
  appendSnap(s,{ author:snapperName, text:line });
  logActivity(s,'Filed a snap: <span class="act-kw">'+esc(line.slice(0,70))+(line.length>70?'…':'')+'</span>');
  toast('Published','s');
}

function loadSnapIntoEditor(index){
  const s=selectedId?storyById[selectedId]:null;
  if(!s || !Array.isArray(s.chain)) return;
  const entry=s.chain[index];
  if(!entry) return;
  const aeBody=document.getElementById('aeBody');
  if(aeBody){ aeBody.value=String(entry.text||'').toUpperCase(); aeBody.focus(); }
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
// Kept as an alias so the auto-snap path and any future caller read naturally.
const addToHistory = appendSnap;

function toggleSnapFlag(index){
  const s=selectedId?storyById[selectedId]:null;
  if(!s || !Array.isArray(s.chain)) return;
  const entry=s.chain[index];
  if(!entry) return;
  entry.flagged=!entry.flagged;
  renderPubHistory();
  toast(entry.flagged ? 'Snap flagged as wrong' : 'Flag removed', entry.flagged ? 'w' : 'i');
}

// No tag chip here on purpose: the tag is part of the alert line itself
// ("CORRECTED - EUROCELL PLC: …"), so a chip beside it just says it twice.
function chainRows(chain, opts){
  const o=opts||{};
  let h='';
  // Newest first on screen; the chain itself is stored oldest first.
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

// ═══ CORRECTION ═══
// A correction refiles the WHOLE chain. The snaps you tick are corrected and
// carry CORRECTED; everything else refiles unchanged as RPT. The chain that
// went out before is archived, not deleted.
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
      // The tool puts the tag on the front of the line. The journalist writes
      // the actual correction wording — "BEN GUYATT (NOT 'THE ROCK')" is a
      // judgement call, not something to generate.
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

function fileCorrection(){
  if(!requireName()) return;
  const s=selectedId?storyById[selectedId]:null;
  if(!s || s.isBundle){ toast('Pick a release first','w'); return; }
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

  const old=(s.chain||[]).slice();
  const now=hms(new Date());
  const newChain=rows.map(r=>{
    const i=parseInt(r.dataset.row,10);
    const on=r.querySelector('[data-pick]').checked;
    const text=r.querySelector('[data-text]').value.trim().toUpperCase();
    const prev=old[i]||{};
    return {
      author: snapperName, time: now,
      text: on ? text : ('RPT - '+text.replace(/^RPT\s+-\s+/i,'')),
      tag: on ? 'CORRECTED' : 'RPT',
      category: prev.category||'', flagged:false
    };
  });

  if(!Array.isArray(s.archive)) s.archive=[];
  s.archive.push({ v:s.version||1, reason:'correction', by:snapperName, time:now, snaps:old });
  s.version=(s.version||1)+1;
  s.chain=newChain;

  const nCor=picked.length, nRpt=newChain.length-nCor;
  logActivity(s, 'Filed a <span class="act-kw">correction</span> — '+nCor+' corrected, '+nRpt+' repeated, whole chain refiled as v'+s.version);
  showArchive=false;
  renderPubHistory();
  renderCorrectPanel();
  toast('Correction filed — chain refiled as v'+s.version,'s');
}

// ═══ WITHDRAW ═══
// The whole chain goes. The advisory is the record of why.
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

function fileWithdrawal(){
  if(!requireName()) return;
  const s=selectedId?storyById[selectedId]:null;
  if(!s || s.isBundle){ toast('Pick a release first','w'); return; }
  if(s.withdrawn){ toast('That chain is already withdrawn','w'); return; }
  const chain=(s.chain||[]).slice();
  if(!chain.length){ toast('Nothing to withdraw','w'); return; }

  const adv=(document.getElementById('withdrawAdvisory').value||'').trim().toUpperCase();
  if(!adv){ toast('Type the advisory — why is the chain being withdrawn?','w'); document.getElementById('withdrawAdvisory').focus(); return; }

  const ok=window.confirm('Withdraw all '+chain.length+' snap'+(chain.length===1?'':'s')+' on chain #'+s.id+'?\n\nThe whole chain is withdrawn — this is not per-snap. It stays readable in Publish History.');
  if(!ok) return;

  const now=hms(new Date());
  if(!Array.isArray(s.archive)) s.archive=[];
  s.archive.push({ v:s.version||1, reason:'withdrawal', by:snapperName, time:now, advisory:adv, snaps:chain });
  s.version=(s.version||1)+1;
  s.chain=[];
  s.withdrawn={ by:snapperName, time:now, advisory:adv };

  logActivity(s, '<span class="act-wd">Withdrew</span> the chain ('+chain.length+' snap'+(chain.length===1?'':'s')+') — advisory: '+esc(adv));
  document.getElementById('withdrawAdvisory').value='';
  showArchive=true;
  renderPubHistory();
  renderWithdrawPanel();
  toast('Chain withdrawn','s');
}
