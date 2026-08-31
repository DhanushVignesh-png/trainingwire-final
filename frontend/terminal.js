// FILE: frontend/terminal.js
// Training Wire — Controller (1.6 UX, cloud backend).
// Boots the auth gate, then runs the 1.6 blotter: shared releases from everyone,
// formatted reader with tables/bullets/highlights, Alert Editor (article-stripping)
// that publishes to the cloud, per-release Publish History docked under the blotter
// with X-flag toggling (synced to everyone), Clear (global reset), PDF export,
// draggable+resizable Settings with Send Releases (client fetches + formats, then
// posts finished bodies to /api/inject). Realtime keeps every terminal in sync.
//
// ── PERFORMANCE (free tier, 20 concurrent trainees) ──
// A 'release' event carries METADATA ONLY. We insert that instantly for a snappy
// blotter and DO NOT pull the whole wire. The full body is lazy-loaded via
// /api/release the first time a user opens that release, then cached in memory.
// This replaces the old hydrate()-on-every-event behaviour, which re-downloaded
// the entire snapshot (all bodies) per event — a bandwidth storm at 20 users.
// hydrate() now runs only on login and on reconnect (one authoritative pull).
'use strict';

(function () {
  console.log('Training Wire: Controller (cloud/1.6)');

  // ═══ STATE ═══
  const state = {
    email: '',
    releases: [],            // [{id, kind, headline, source, bodyHtml, bodyText, sourceUrl, injectedBy, createdAt}]
    history: {},             // releaseId(chain) -> [{rowKey, alert, author, wrong, createdAt}]
    selectedId: null,        // release id (UUID)
  };
  let sortKey = 'time', sortDir = -1;
  let highlightKeywords = [];
  const MAX_RELEASES = 15;
  let stagedReleases = [];   // { url, headline }

  // Tracks release ids whose full body is currently being lazy-fetched, so we
  // never fire two concurrent /api/release calls for the same release.
  const bodyFetching = {};

  // Friendly incrementing display id (#1, #2…) mapped to each UUID (1.6 look).
  const displayIdMap = {};
  let displaySeq = 0;
  function displayId(uuid) {
    if (!displayIdMap[uuid]) displayIdMap[uuid] = ++displaySeq;
    return displayIdMap[uuid];
  }

  const DEFAULT_HIGHLIGHT_KEYWORDS = [
    'dividend','cash','per share','buyback','repurchase','acquisition','acquire','merger',
    'results','revenue','earnings','guidance','profit','loss','net income','EBITDA',
    'market','management','CEO','CFO','appoints','appointed','resigns','stepping down',
    'agreement','contract','partnership','FDA','approval','launch','offering','IPO',
    'United States','quarterly','annual','forecast','outlook','record','completes'
  ];

  // ═══ TINY HELPERS ═══
  function esc(t){ if(t==null)return ''; const d=document.createElement('div'); d.textContent=String(t); return d.innerHTML; }
  function bind(id,ev,fn){ const e=document.getElementById(id); if(e) e.addEventListener(ev,fn); }
  function hms(ts){ return new Date(ts).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
  function toast(msg,type='i'){ const c=document.getElementById('toastContainer'); if(!c)return; const t=document.createElement('div'); t.className='toast '+type; t.textContent=msg; c.appendChild(t); setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(()=>t.remove(),300);},3200); }
  function lsGet(k,def){ try{ const v=localStorage.getItem(k); return v==null?def:JSON.parse(v); }catch(e){ return def; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }

  // ═══ BOOT ═══
  const authRoot = document.getElementById('auth-root');
  const appRoot = document.getElementById('app-root');
  const auth = new window.AuthFlow(authRoot, onAuthed);
  auth.start();

  async function onAuthed(){
    authRoot.hidden = true;
    appRoot.hidden = false;
    initEvents();
    loadPrefs();
    initSplitters();
    initDockResizers();
    initSettingsDragResize();
    renderSendReleases();
    await hydrate();
    startRealtime();
  }

  // ═══ SNAPSHOT (initial + every reconnect) ═══
  // This is the ONE authoritative full pull. It brings every release body. We run
  // it on login and on reconnect only — never per realtime event.
  async function hydrate(){
    try{
      const snap = await window.WireClient.getState();
      state.email = snap.user || '';
      state.releases = Array.isArray(snap.releases) ? snap.releases : [];
      state.history = (snap.history && typeof snap.history==='object') ? snap.history : {};
      renderUserChip();
      renderBlotter();
      renderPubHistory();
      if (state.selectedId && !state.releases.find(r=>r.id===state.selectedId)) {
        state.selectedId = null;
        renderReader(null);
      } else if (state.selectedId) {
        renderReader(state.releases.find(r=>r.id===state.selectedId));
      }
    }catch(err){
      if(err.status===401) return bounceToLogin();
      toast(err.message||'Could not load the wire.','r');
    }
  }

  // ═══ REALTIME ═══
  function startRealtime(){
    const rt = window.WireRealtime;
    rt.onStatus(setConnStatus);
    rt.onResync(()=>{ hydrate(); });   // reconnect → single authoritative pull
    rt.on('release',(p)=>{ upsertReleaseMeta(p); renderBlotter(); toast('New release on the wire','i'); });
    rt.on('publish',(p)=>{ addHistory(p); if(p.chain===state.selectedId) renderPubHistory(); });
    rt.on('flag',(p)=>{ applyFlag(p); if(p.chain===state.selectedId) renderPubHistory(); });
    rt.on('clear',(p)=>{
      state.releases=[]; state.history={}; state.selectedId=null;
      renderBlotter(); renderPubHistory(); renderReader(null);
      toast('Wire cleared'+(p&&p.by?(' by '+p.by):''),'w');
    });
    rt.start();
  }
  function setConnStatus(status){
    const el=document.getElementById('conn-status'); if(!el)return;
    const label=el.querySelector('.conn-label');
    el.classList.remove('conn-online','conn-offline','conn-connecting');
    if(status==='online'){ el.classList.add('conn-online'); label.textContent='live'; }
    else if(status==='offline'){ el.classList.add('conn-offline'); label.textContent='offline'; }
    else { el.classList.add('conn-connecting'); label.textContent= status==='reconnecting'?'reconnecting…':'connecting…'; }
  }

  // A 'release' broadcast is LIGHT (metadata only, no body). Insert it instantly.
  // The body is lazy-loaded on first open (loadReleaseBody). We DO NOT call
  // hydrate() here — that would re-pull the entire wire on every event.
  function upsertReleaseMeta(r){
    if(!r||!r.id) return;
    const i=state.releases.findIndex(x=>x.id===r.id);
    const meta={ id:r.id, kind:r.kind, headline:r.headline||'', source:r.source||'', sourceUrl:r.sourceUrl||'', injectedBy:r.injectedBy||'', createdAt:r.createdAt||Date.now() };
    if(i===-1){
      state.releases.unshift({ ...meta, bodyHtml:'', bodyText:'' });
    } else {
      // Keep any body we already fetched/cached; refresh the metadata only.
      state.releases[i]={ ...state.releases[i], ...meta };
    }
    state.releases.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  }

  // Lazy-load a single release body via /api/release, cache it, refresh the reader
  // if that release is still the one on screen. Guarded against double-fetch.
  async function loadReleaseBody(id){
    if(!id || bodyFetching[id]) return;
    bodyFetching[id]=true;
    try{
      const res=await window.WireClient.getRelease(id);
      const full=res && res.release;
      if(full){
        const i=state.releases.findIndex(x=>x.id===id);
        if(i!==-1){
          state.releases[i]={ ...state.releases[i],
            bodyHtml: full.bodyHtml || '',
            bodyText: full.bodyText || '',
            contentType: full.contentType || state.releases[i].contentType,
          };
        }
        // Only re-render if the user is still looking at this release.
        if(state.selectedId===id) renderReader(state.releases[i]);
      }
    }catch(err){
      if(err.status===401){ bounceToLogin(); return; }
      // Reader already shows a fallback; just note it failed.
      if(state.selectedId===id){
        const rb=document.getElementById('readerBody');
        if(rb && rb.querySelector('.reader-loading')){
          rb.innerHTML='<div class="reader-placeholder">Could not load this release body. It may have been cleared. Try selecting it again.</div>';
        }
      }
    }finally{
      delete bodyFetching[id];
    }
  }

  function addHistory(h){
    if(!h||!h.chain) return;
    if(!state.history[h.chain]) state.history[h.chain]=[];
    const arr=state.history[h.chain];
    if(!arr.find(x=>x.rowKey===h.rowKey)) arr.unshift(h);
  }
  function applyFlag(f){
    if(!f||!f.chain) return;
    const arr=state.history[f.chain]; if(!arr) return;
    const row=arr.find(x=>x.rowKey===f.rowKey);
    if(row){ row.wrong=!!f.wrong; row.flaggedBy=f.flaggedBy||''; }
  }

  // ═══ EVENTS ═══
  function initEvents(){
    bind('btnLogout','click',doLogout);
    bind('btnSettings','click',()=>{ openSettings(); setTimeout(()=>{const e=document.getElementById('srDraftUrl'); if(e)e.focus();},60); });
    bind('btnCloseSettings','click',closeSettings);
    const sm=document.getElementById('settingsModal'); if(sm) sm.addEventListener('click',e=>{ if(e.target===sm) closeSettings(); });

    bind('btnSendAll','click',sendAllReleases);
    bind('btnClearAll','click',()=>{ stagedReleases=[]; renderSendReleases(); });
    bind('btnClearReleases','click',clearWire);

    bind('findStory','input',renderBlotter);
    document.querySelectorAll('.blotter th.sortable').forEach(th=>th.addEventListener('click',()=>{
      const k=th.dataset.sort; if(sortKey===k) sortDir=-sortDir; else {sortKey=k; sortDir=-1;} renderBlotter();
    }));

    bind('btnSaveTemplate','click',saveTemplate);
    bind('btnResetTemplate','click',()=>{ highlightKeywords=[...DEFAULT_HIGHLIGHT_KEYWORDS]; document.getElementById('templateKeywords').value=highlightKeywords.join(', '); lsSet('nw_hl_keywords',highlightKeywords); toast('Keywords reset','i'); if(state.selectedId) renderReader(currentStory()); });

    bind('zoom','input',()=>{ document.getElementById('readerBody').style.fontSize=document.getElementById('zoom').value+'px'; });
    bind('btnExportPdf','click',exportReaderPdf);

    const rb=document.getElementById('readerBody');
    if(rb){ rb.addEventListener('mouseup',captureSelection); rb.addEventListener('keyup',captureSelection); }
    document.addEventListener('dblclick',(e)=>{ const inAe=e.target&&(e.target.id==='aeBody'||e.target.id==='aeSource'); if(!inAe) resetAlertEditorBody(); });

    bind('aeBody','input',updateAeCharCount);
    bind('aeSource','input',updateAeCharCount);
    bind('aeClear','click',()=>{ document.getElementById('aeBody').value=''; updateAeCharCount(); });
    bind('aePublish','click',publishFromAlertEditor);
  }

  function openSettings(){ document.getElementById('settingsModal').style.display='grid'; }
  function closeSettings(){ document.getElementById('settingsModal').style.display='none'; }

  async function doLogout(){
    try{ window.WireRealtime.stop(); }catch(e){}
    window.WireClient.clearTokens();
    bounceToLogin();
  }
  function bounceToLogin(){
    appRoot.hidden=true; authRoot.hidden=false; authRoot.innerHTML='';
    const a=new window.AuthFlow(authRoot,onAuthed); a.start();
  }

  // ═══ PREFS (localStorage; no chrome.storage) ═══
  function loadPrefs(){
    const kw=lsGet('nw_hl_keywords',null);
    highlightKeywords=(kw&&kw.length)?kw:[...DEFAULT_HIGHLIGHT_KEYWORDS];
    const ta=document.getElementById('templateKeywords'); if(ta) ta.value=highlightKeywords.join(', ');
  }
  function saveTemplate(){
    const raw=document.getElementById('templateKeywords').value;
    highlightKeywords=raw.split(',').map(s=>s.trim()).filter(Boolean);
    lsSet('nw_hl_keywords',highlightKeywords);
    toast('Keywords saved','s');
    if(state.selectedId) renderReader(currentStory());
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
          const mode=window.ReleaseFormatter.detectSourceType(r.url).toUpperCase();
          const label=r.headline?r.headline:r.url;
          h+='<div class="sr-staged-row">'
            +'<span class="sr-badge">'+(i+1)+'</span>'
            +'<span class="sr-hl" title="'+esc(r.headline?r.headline+' — '+r.url:r.url)+'">'+esc(label)+'</span>'
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
          +'<input type="text" id="srDraftHeadline" placeholder="e.g. NIKE, Inc. Reports Fiscal 2026 Fourth Quarter and Full Year Results">'
          +'<label>Release URL (HTML page or PDF)</label>'
          +'<input type="text" id="srDraftUrl" placeholder="https://www.example.com/news/… or …/report.pdf">'
          +'<div class="sr-draft-actions"><button class="s-btn pri" id="btnStageDraft">Save</button></div>'
          +'</div>';
        bind('btnStageDraft','click',stageDraft);
        const u=document.getElementById('srDraftUrl'); if(u) u.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();stageDraft();} });
        const hd=document.getElementById('srDraftHeadline'); if(hd) hd.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();document.getElementById('srDraftUrl').focus();} });
      }
    }
    const sendAll=document.getElementById('btnSendAll'); if(sendAll) sendAll.disabled=stagedReleases.length===0;
  }
  function stageDraft(){
    const url=(document.getElementById('srDraftUrl')?.value||'').trim();
    const headline=(document.getElementById('srDraftHeadline')?.value||'').trim();
    if(!url){ toast('Paste a URL first','w'); return; }
    if(!/^https?:\/\//i.test(url)){ toast('URL must start with http(s)://','w'); return; }
    if(stagedReleases.length>=MAX_RELEASES){ toast('Max '+MAX_RELEASES+' releases','w'); return; }
    stagedReleases.push({ url, headline });
    renderSendReleases();
    setTimeout(()=>{ const e=document.getElementById('srDraftHeadline'); if(e)e.focus(); },40);
  }

  // Client fetches (via hardened /api/article-fetch), formats with 1.6 formatter,
  // then posts the FINISHED body to /api/inject (Option A).
  async function sendAllReleases(){
    if(!stagedReleases.length){ toast('Nothing staged','w'); return; }
    const btn=document.getElementById('btnSendAll');
    btn.disabled=true; const old=btn.textContent; btn.textContent='Fetching…';
    const batch=[...stagedReleases];
    stagedReleases=[];
    const payloadItems=[];
    let skipped=0;

    for(const r of batch){
      let fetched;
      try{
        fetched=await window.WireClient.fetchArticle(r.url);   // {kind, text|base64, sourceUrl}
      }catch(e){
        if(e.status===401){ btn.disabled=false; btn.textContent=old; return bounceToLogin(); }
        skipped++; toast('Skipped a URL (fetch failed)','w'); continue;
      }
      let formatted;
      try{
        formatted=await window.ReleaseFormatter.format({ kind:fetched.kind, data:fetched.text, base64:fetched.base64, url:fetched.sourceUrl||r.url });
      }catch(fe){ skipped++; toast('Skipped a URL (parse failed)','w'); continue; }
      if(!formatted || (!formatted.html && !formatted.text)){ skipped++; toast('Skipped a URL (empty release)','w'); continue; }
      const title=r.headline || formatted.title || window.ReleaseFormatter.guessHeadline(formatted.text||'');
      const source=deriveSource(title);
      payloadItems.push({ title, bodyHtml:formatted.html, bodyText:formatted.text, kind:fetched.kind, sourceUrl:fetched.sourceUrl||r.url, source });
    }

    if(!payloadItems.length){ btn.disabled=false; btn.textContent=old; renderSendReleases(); toast('No releases sent','w'); return; }

    btn.textContent='Sending…';
    try{
      const res=await window.WireClient.injectReleases(payloadItems);
      const okCount=res.injected||0;
      const fails=(res.results||[]).filter(x=>!x.ok);
      if(okCount) toast('Sent '+okCount+' release'+(okCount===1?'':'s')+' to the wire','s');
      if(fails.length) toast(fails.length+' failed: '+(fails[0].error||'error'),'r');
    }catch(err){
      if(err.status===401) return bounceToLogin();
      toast(err.message||'Send failed.','r');
    }finally{
      btn.disabled=false; btn.textContent=old;
      renderSendReleases();
      closeSettings();
      // The 'release' broadcasts will populate our own blotter live. No hydrate().
    }
  }

  // ═══ SOURCE-FROM-HEADLINE (1.6) ═══
  function deriveSource(headline){
    let h=String(headline||'').replace(/\s+/g,' ').trim();
    if(!h) return '';
    const actionRe=/\b(announces?|announced|reports?|reported|posts?|posted|declares?|declared|names?|named|appoints?|appointed|completes?|completed|launches?|launched|to\s+report|to\s+announce|delivers?|delivered|provides?|provided|sets?|raises?|raised|cuts?|updates?|files?|filed|acquires?|acquired|prices?|priced|issues?|issued|expands?|unveils?|introduces?)\b/i;
    const m=h.match(actionRe);
    let candidate='';
    if(m&&m.index>0) candidate=h.slice(0,m.index).trim();
    else { const cut=h.split(/\b(?:fiscal|first|second|third|fourth|q[1-4]|full[-\s]?year|quarter|half[-\s]?year)\b/i)[0]; candidate=(cut||'').trim(); }
    candidate=candidate.replace(/[,:;\-–—]\s*$/,'').trim();
    candidate=candidate.replace(/\s+\b(and|the|its|to)$/i,'').trim();
    if(!candidate) return '';
    if(candidate.length<2||candidate.length>60) return '';
    if(candidate.split(' ').filter(Boolean).length>7) return '';
    if(!/[A-Z]/.test(candidate)) return '';
    return candidate;
  }

  // ═══ CLEAR (global reset — everyone) ═══
  async function clearWire(){
    if(!state.releases.length){ toast('No releases to clear','i'); return; }
    const ok=window.confirm('Clear ALL releases?\n\nThis removes every release AND its publish history for EVERYONE connected. This cannot be undone.');
    if(!ok) return;
    try{
      await window.WireClient.clearWire();
      // 'clear' realtime event wipes state for everyone incl. us.
      toast('Wire cleared','s');
    }catch(err){
      if(err.status===401) return bounceToLogin();
      toast(err.message||'Clear failed.','r');
    }
  }

  // ═══ BLOTTER ═══
  function currentView(){
    const q=(document.getElementById('findStory').value||'').toLowerCase();
    let view=state.releases.filter(s=>{
      if(q&&!((s.headline+' '+(s.source||'')+' '+(s.sourceUrl||'')).toLowerCase().includes(q))) return false;
      return true;
    });
    view.sort((a,b)=>{
      let av,bv;
      if(sortKey==='time'){ av=a.createdAt; bv=b.createdAt; }
      else if(sortKey==='id'){ av=displayId(a.id); bv=displayId(b.id); }
      else if(sortKey==='head'){ av=(a.headline||'').toLowerCase(); bv=(b.headline||'').toLowerCase(); }
      else if(sortKey==='src'){ av=(a.source||'').toLowerCase(); bv=(b.source||'').toLowerCase(); }
      if(av<bv) return -1*sortDir; if(av>bv) return 1*sortDir; return 0;
    });
    return view;
  }
  function renderBlotter(){
    const body=document.getElementById('blotterBody'); if(!body)return;
    const view=currentView();
    if(!view.length){ body.innerHTML='<tr class="empty-row"><td colspan="4">No releases yet. Open Settings → Send Releases to inject one.</td></tr>'; return; }
    let h='';
    view.forEach((s)=>{
      const breaking=(Date.now()-s.createdAt)<8000;
      const cls=(s.id===state.selectedId?'selected ':'')+(breaking?'breaking ':'');
      const src=s.source||(s.kind==='pdf'?'PDF':'WEB');
      h+='<tr class="'+cls.trim()+'" data-id="'+esc(s.id)+'">'
        +'<td class="b-time">'+esc(hms(s.createdAt))+'</td>'
        +'<td class="b-id">'+displayId(s.id)+'</td>'
        +'<td class="b-head" title="'+esc(s.headline)+'">'+esc(s.headline||'(untitled)')+'</td>'
        +'<td class="b-src" title="'+esc(src)+'">'+esc(src)+'</td>'
        +'</tr>';
    });
    body.innerHTML=h;
    body.querySelectorAll('tr[data-id]').forEach(tr=>tr.addEventListener('click',()=>selectStory(tr.dataset.id)));
  }

  // ═══ SELECT + READER ═══
  function currentStory(){ return state.selectedId ? state.releases.find(r=>r.id===state.selectedId) : null; }
  function selectStory(id){
    state.selectedId=id;
    renderBlotter();
    const s=currentStory();
    renderReader(s);
    renderPubHistory();
    const aeSrc=document.getElementById('aeSource');
    const aeBody=document.getElementById('aeBody');
    if(aeSrc) aeSrc.value=((s&&s.source)||'').toUpperCase();
    if(aeBody) aeBody.value='';
    updateAeCharCount();
    // Lazy-load the body if we only have metadata for this release.
    if(s && !s.bodyHtml && !s.bodyText) loadReleaseBody(id);
  }

  function highlightNode(root){
    const moneyRe=/(\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|mln|bln))?)/gi;
    const pctRe=/(\d+(?:\.\d+)?\s?%)/g;
    const dateRe1=/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/gi;
    const dateRe2=/(\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/gi;
    const kwList=highlightKeywords.filter(Boolean).map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    const kwRe=kwList.length?new RegExp('\\b('+kwList.join('|')+')\\b','gi'):null;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null);
    const targets=[]; let n; while((n=walker.nextNode())){ if(n.nodeValue&&n.nodeValue.trim()) targets.push(n); }
    targets.forEach(textNode=>{
      let html=esc(textNode.nodeValue);
      html=html.replace(moneyRe,'\u0001M\u0002$1\u0003').replace(pctRe,'\u0001P\u0002$1\u0003')
               .replace(dateRe1,'\u0001D\u0002$1\u0003').replace(dateRe2,'\u0001D\u0002$1\u0003');
      if(kwRe) html=html.replace(kwRe,'\u0001K\u0002$1\u0003');
      html=html.replace(/\u0001M\u0002/g,'<mark class="hl hl-money">').replace(/\u0001P\u0002/g,'<mark class="hl hl-pct">')
               .replace(/\u0001D\u0002/g,'<mark class="hl hl-date">').replace(/\u0001K\u0002/g,'<mark class="hl hl-kw">')
               .replace(/\u0003/g,'</mark>');
      if(html!==esc(textNode.nodeValue)){ const span=document.createElement('span'); span.innerHTML=html; textNode.parentNode.replaceChild(span,textNode); }
    });
  }

  function renderReader(s){
    const headline=document.getElementById('readerHeadline');
    const sub=document.getElementById('readerSub');
    const rb=document.getElementById('readerBody');
    const srcTag=document.getElementById('readerSrcTag');
    if(!s){
      headline.textContent='Select a release';
      sub.innerHTML='';
      rb.innerHTML='<div class="reader-placeholder">The full formatted release body appears here. Highlight any text to send it to the Alert Editor.</div>';
      if(srcTag) srcTag.textContent='';
      return;
    }
    headline.textContent=s.headline||'(untitled)';
    const co=s.source||'';
    sub.innerHTML=
      (co?'<span class="co">'+esc(co)+'</span>':'')
      +'<span class="src-chip">#'+displayId(s.id)+'</span>'
      +'<span>'+esc(hms(s.createdAt))+'</span>'
      +'<span class="src-chip">'+esc((s.kind||'html').toUpperCase())+'</span>'
      +(s.injectedBy?'<span class="src-chip">'+esc(s.injectedBy.split('@')[0])+'</span>':'')
      +(s.sourceUrl?'<a href="'+esc(s.sourceUrl)+'" target="_blank" rel="noopener noreferrer nofollow">Open ↗</a>':'');
    // SECURITY: stored HTML is re-sanitised before it touches innerHTML.
    if(s.bodyHtml){
      rb.innerHTML=window.ReleaseFormatter.sanitizeStored(s.bodyHtml);
      try{ highlightNode(rb); }catch(e){}
    } else if(s.bodyText){
      rb.innerHTML='<p class="rl-p">'+esc(s.bodyText)+'</p>';
      try{ highlightNode(rb); }catch(e){}
    } else if(bodyFetching[s.id]){
      // Body is on its way — show a tiny loading line, headline already visible.
      rb.innerHTML='<div class="reader-placeholder reader-loading">Loading release…</div>';
    } else {
      // No body yet and not fetching: kick a lazy load and show loading.
      rb.innerHTML='<div class="reader-placeholder reader-loading">Loading release…</div>';
      loadReleaseBody(s.id);
    }
    rb.style.fontSize=(document.getElementById('zoom').value||13)+'px';
    if(srcTag) srcTag.textContent='Source: '+((s.kind||'html').toUpperCase());
  }

  // ═══ ALERT EDITOR ═══
  function stripArticles(text){
    if(!text) return '';
    let t=String(text);
    t=t.replace(/\b(a|an|the)\b/gi,'');
    t=t.replace(/\s{2,}/g,' ').replace(/\s+([,.;:!?)])/g,'$1').replace(/([(])\s+/g,'$1');
    return t.trim();
  }
  function captureSelection(){
    const sel=window.getSelection?window.getSelection():null; if(!sel) return;
    const text=(sel.toString()||'').replace(/\s+/g,' ').trim(); if(!text) return;
    const rb=document.getElementById('readerBody');
    if(rb&&sel.anchorNode&&!rb.contains(sel.anchorNode)) return;
    const aeBody=document.getElementById('aeBody');
    const aeSrc=document.getElementById('aeSource');
    const s=currentStory();
    if(aeSrc&&!aeSrc.value&&s) aeSrc.value=(s.source||'').toUpperCase();
    aeBody.value=stripArticles(text).toUpperCase();
    updateAeCharCount();
  }
  function resetAlertEditorBody(){ const aeBody=document.getElementById('aeBody'); if(aeBody&&aeBody.value){ aeBody.value=''; updateAeCharCount(); } }
  function aeComposed(){
    const src=(document.getElementById('aeSource').value||'').trim().toUpperCase();
    const body=(document.getElementById('aeBody').value||'').trim().toUpperCase();
    if(!body) return '';
    return (src?src+': ':'')+body;
  }
  function updateAeCharCount(){ const line=aeComposed(); const el=document.getElementById('aeCharCount'); if(!el)return; const n=line.length; el.textContent=n+' chars'; el.classList.toggle('over',n>100); }

  async function publishFromAlertEditor(){
    const s=currentStory();
    if(!s){ toast('Select a release first','w'); return; }
    let line=aeComposed();
    if(!line){ toast('Nothing to publish — highlight text or type a snap','w'); return; }
    if(line.length>240) line=line.slice(0,240);
    const btn=document.getElementById('aePublish');
    btn.disabled=true; const old=btn.textContent; btn.textContent='Publishing…';
    try{
      // chain = release id (per-release history, 1.6 "Chain #ID"); author = email.
      await window.WireClient.publishAlert(s.id, line, s.id);
      document.getElementById('aeBody').value='';
      updateAeCharCount();
      toast('Published','s');
      // 'publish' realtime event updates history for everyone incl. us.
    }catch(err){
      if(err.status===401) return bounceToLogin();
      toast(err.message||'Publish failed.','r');
    }finally{
      btn.disabled=false; btn.textContent=old;
    }
  }

  // ═══ PUBLISH HISTORY (per-release, docked) ═══
  function renderPubHistory(){
    const el=document.getElementById('dockPubhist'); if(!el)return;
    const scope=document.getElementById('phScope');
    const s=currentStory();
    if(scope) scope.textContent = s ? ('· Chain #'+displayId(s.id)) : '';
    if(!s){ el.innerHTML='<div class="dock-empty">Select a release to see its publish history.</div>'; return; }
    const hist=state.history[s.id]||[];
    if(!hist.length){ el.innerHTML='<div class="dock-empty">No published snaps for this release yet. Publish from the Alert Editor.</div>'; return; }
    let h='<table class="ph-table"><thead><tr>'
      +'<th style="width:150px">Author</th>'
      +'<th style="width:82px">Publish Time</th>'
      +'<th>Alert text</th>'
      +'<th class="c-flag" title="Flag a wrong snap">Flag</th>'
      +'</tr></thead><tbody>';
    hist.forEach((p)=>{
      const flagged=!!p.wrong;
      const rowCls=flagged?' class="ph-flagged"':'';
      const btnCls='ph-x'+(flagged?' active':'');
      const btnTitle=flagged?'Marked wrong — click to clear':'Mark this snap as wrong';
      h+='<tr'+rowCls+'>'
        +'<td class="ph-author" title="'+esc(p.author)+'">'+esc((p.author||'').split('@')[0])+'</td>'
        +'<td class="ph-time">'+esc(hms(p.createdAt))+'</td>'
        +'<td class="ph-text">'+esc(p.alert)+'</td>'
        +'<td class="ph-flagcell"><button class="'+btnCls+'" data-row="'+esc(p.rowKey)+'" title="'+esc(btnTitle)+'" aria-pressed="'+flagged+'">✕</button></td>'
        +'</tr>';
    });
    h+='</tbody></table>';
    el.innerHTML=h;
    el.querySelectorAll('.ph-x').forEach(b=>b.addEventListener('click',()=>toggleSnapFlag(s.id,b.dataset.row)));
  }
  async function toggleSnapFlag(chain,rowKey){
    const arr=state.history[chain]||[];
    const row=arr.find(x=>x.rowKey===rowKey); if(!row) return;
    const desired=!row.wrong;
    try{
      await window.WireClient.flagAlert(chain,rowKey,desired);
      // optimistic; 'flag' event will confirm for everyone
      row.wrong=desired; renderPubHistory();
      toast(desired?'Snap flagged as wrong':'Flag removed', desired?'w':'i');
    }catch(err){
      if(err.status===401) return bounceToLogin();
      toast(err.message||'Could not update flag.','r');
    }
  }

  // ═══ PDF EXPORT (print) ═══
  function exportReaderPdf(){
    const s=currentStory();
    if(!s){ toast('Select a release first','w'); return; }
    if(!s.bodyHtml && !s.bodyText){ toast('Release still loading — try again in a moment','w'); if(!bodyFetching[s.id]) loadReleaseBody(s.id); return; }
    let root=document.getElementById('pdfExportRoot');
    if(!root){ root=document.createElement('div'); root.id='pdfExportRoot'; document.body.appendChild(root); }
    const meta=[s.source,'#'+displayId(s.id),hms(s.createdAt),s.sourceUrl].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');
    const safeBody = s.bodyHtml ? window.ReleaseFormatter.sanitizeStored(s.bodyHtml) : ('<p class="rl-p">'+esc(s.bodyText||'')+'</p>');
    root.innerHTML='<div class="pdf-title">'+esc(s.headline)+'</div><div class="pdf-meta">'+meta+'</div>'+safeBody;
    const cleanup=()=>{ root.innerHTML=''; window.removeEventListener('afterprint',cleanup); };
    window.addEventListener('afterprint',cleanup);
    setTimeout(()=>window.print(),60);
  }

  // ═══ USER CHIP ═══
  function renderUserChip(){ const chip=document.getElementById('user-chip'); if(!chip)return; chip.textContent=state.email||''; chip.title=state.email||''; }

  // ═══ SPLITTER ═══
  function initSplitters(){ makeSplitter('split1','paneBlotter'); }
  function makeSplitter(id,paneId){
    const sp=document.getElementById(id), pane=document.getElementById(paneId), ws=document.getElementById('workspace');
    if(!sp||!pane) return;
    let dragging=false;
    sp.addEventListener('mousedown',e=>{ dragging=true; document.body.style.cursor='col-resize'; e.preventDefault(); });
    window.addEventListener('mousemove',e=>{ if(!dragging)return; const rect=ws.getBoundingClientRect(); let w=e.clientX-rect.left; w=Math.max(240,Math.min(w,rect.width-360)); pane.style.width=w+'px'; pane.style.flex='none'; });
    window.addEventListener('mouseup',()=>{ if(dragging){ dragging=false; document.body.style.cursor=''; } });
  }

  // ═══ DOCK RESIZERS ═══
  function initDockResizers(){ makeDockResizer('dockResizeAE','dockAE'); makeDockResizer('dockResizePH','dockPH'); }
  function makeDockResizer(handleId,dockId){
    const handle=document.getElementById(handleId), dock=document.getElementById(dockId);
    if(!handle||!dock) return;
    let dragging=false, startY=0, startH=0;
    handle.addEventListener('mousedown',e=>{ dragging=true; startY=e.clientY; startH=dock.getBoundingClientRect().height; document.body.style.cursor='row-resize'; e.preventDefault(); });
    window.addEventListener('mousemove',e=>{ if(!dragging)return; const paneH=dock.parentElement.getBoundingClientRect().height; let h=startH+(startY-e.clientY); h=Math.max(80,Math.min(h,paneH-140)); dock.style.height=h+'px'; });
    window.addEventListener('mouseup',()=>{ if(dragging){ dragging=false; document.body.style.cursor=''; } });
  }

  // ═══ SETTINGS DRAG + RESIZE ═══
  function initSettingsDragResize(){
    const panel=document.getElementById('settingsPanel');
    const header=document.getElementById('settingsHeader');
    const resize=document.getElementById('settingsResize');
    if(!panel||!header) return;
    let placed=false;
    function ensurePlaced(){ if(placed)return; const r=panel.getBoundingClientRect(); panel.style.left=r.left+'px'; panel.style.top=r.top+'px'; panel.style.transform='none'; placed=true; }
    let dragging=false, dx=0, dy=0;
    header.addEventListener('mousedown',e=>{ if(e.target.id==='btnCloseSettings')return; ensurePlaced(); dragging=true; const r=panel.getBoundingClientRect(); dx=e.clientX-r.left; dy=e.clientY-r.top; document.body.style.cursor='move'; e.preventDefault(); });
    window.addEventListener('mousemove',e=>{ if(!dragging)return; let nx=e.clientX-dx, ny=e.clientY-dy; nx=Math.max(0,Math.min(nx,window.innerWidth-80)); ny=Math.max(0,Math.min(ny,window.innerHeight-40)); panel.style.left=nx+'px'; panel.style.top=ny+'px'; });
    window.addEventListener('mouseup',()=>{ if(dragging){ dragging=false; document.body.style.cursor=''; } });
    if(resize){
      let rz=false, sw=0, sh=0, sx=0, sy=0;
      resize.addEventListener('mousedown',e=>{ ensurePlaced(); rz=true; const r=panel.getBoundingClientRect(); sw=r.width; sh=r.height; sx=e.clientX; sy=e.clientY; document.body.style.cursor='nwse-resize'; e.preventDefault(); e.stopPropagation(); });
      window.addEventListener('mousemove',e=>{ if(!rz)return; let w=sw+(e.clientX-sx), h=sh+(e.clientY-sy); w=Math.max(420,Math.min(w,window.innerWidth-20)); h=Math.max(280,Math.min(h,window.innerHeight-20)); panel.style.width=w+'px'; panel.style.height=h+'px'; });
      window.addEventListener('mouseup',()=>{ if(rz){ rz=false; document.body.style.cursor=''; } });
    }
  }

})();
