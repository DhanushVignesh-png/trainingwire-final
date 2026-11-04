// FILE: frontend/release-formatter.js
// Training Wire — Universal Release Formatter (1.6 v3.5) + Builder + Security Sanitizer.
//
// THREE responsibilities, ONE global (no name collisions with WireClient):
//   1) format(source)      — INJECT-TIME. Turns raw fetched HTML/PDF into clean
//                            structured HTML (real tables/bullets/paras) + plain text.
//                            This runs in the INJECTOR'S browser only.
//   2) buildRelease(...)   — normalises a story item (folded in from 1.6's builder).
//   3) sanitizeStored(html)— READ-TIME. Untrusted stored HTML is re-sanitised through
//                            a strict allow-list before it EVER hits innerHTML, so a
//                            malicious release can't XSS other users. Fail closed.
//
// PDF path uses PDF.js via dynamic import of local vendor files (CSP: worker-src blob:).
'use strict';

const ReleaseFormatter = (() => {
  'use strict';

  // ══════════════════════════════════════════════════════════
  //  SHARED HELPERS
  // ══════════════════════════════════════════════════════════
  const esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
  const isNumericCell = (s) => {
    const t = String(s || '').trim();
    if (!t) return false;
    return /^[\$\(]?\-?[\d,]+(?:\.\d+)?\)?%?$/.test(t.replace(/\s/g, '')) ||
           /^\$$/.test(t) || /^\(\d/.test(t) || /^\-+$/.test(t);
  };
  const looksLikeSectionHeader = (s) => {
    const t = String(s || '').trim();
    if (!t || t.length > 60) return false;
    return /:$/.test(t) || (/^[A-Z][A-Za-z''\s&,]+$/.test(t) && !/\d/.test(t));
  };
  const isBulletStart = (s) => /^\s*(?:[•‣▪◦·\-–—\*]|\(?\d{1,2}[\.\)])\s+/.test(String(s || ''));
  const cleanText = (s) => String(s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();

  // ══════════════════════════════════════════════════════════
  //  HTML PATH — recursive parse (SEC/EDGAR div/span/XBRL aware)
  // ══════════════════════════════════════════════════════════
  const KILL = 'script,style,noscript,nav,header,footer,aside,form,iframe,svg,button,input,select,textarea,link,meta';

  function unwrapXbrl(doc) {
    const all = Array.from(doc.querySelectorAll('*')).filter(el => {
      const tn = el.tagName ? el.tagName.toLowerCase() : '';
      return tn.startsWith('ix:') || (tn.indexOf(':') !== -1 && /^(ix|xbrli|link|xlink)\b/.test(tn.split(':')[0]));
    });
    all.forEach(el => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });
  }

  function pickArticleRoot(doc) {
    const cands = [
      doc.querySelector('article'),
      doc.querySelector('[itemprop="articleBody"]'),
      doc.querySelector('.release-body, .news-release, .prnews_body, .release, .press-release'),
      doc.querySelector('main'),
      doc.body
    ].filter(Boolean);
    let best = doc.body, bestLen = 0;
    for (const c of cands) {
      const len = (c.textContent || '').replace(/\s+/g, ' ').trim().length;
      if (len > bestLen) { best = c; bestLen = len; }
    }
    return best;
  }

  function convertTable(tableEl) {
    const rows = Array.from(tableEl.querySelectorAll('tr'));
    if (!rows.length) return '';
    const allText = cleanText(tableEl.textContent);
    if (!allText) return '';
    let out = '<table class="rl-table">';
    let emitted = 0;
    rows.forEach((tr, ri) => {
      const cells = Array.from(tr.children).filter(c => /^(td|th)$/i.test(c.tagName));
      if (!cells.length) return;
      const isHead = cells.every(c => /^th$/i.test(c.tagName)) || (ri === 0 && !!tableEl.querySelector('thead'));
      const rowHasText = cells.some(c => cleanText(c.textContent));
      if (!rowHasText && !isHead) return;
      out += '<tr>';
      cells.forEach(c => {
        const txt = cleanText(c.textContent);
        const span = c.getAttribute('colspan');
        const spanAttr = span && +span > 1 ? ' colspan="' + (+span) + '"' : '';
        const tag = isHead ? 'th' : 'td';
        const alignCls = (!isHead && (isNumericCell(txt) || txt === '')) ? ' class="num"' : '';
        out += '<' + tag + spanAttr + alignCls + '>' + esc(txt) + '</' + tag + '>';
      });
      out += '</tr>';
      emitted++;
    });
    out += '</table>';
    return emitted ? out : '';
  }

  function convertList(listEl) {
    const tag = listEl.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul';
    let out = '<' + tag + ' class="rl-list">';
    let any = false;
    Array.from(listEl.children).forEach(li => {
      if (li.tagName && li.tagName.toLowerCase() === 'li') {
        const txt = cleanText(li.textContent);
        if (txt) { out += '<li>' + esc(txt) + '</li>'; any = true; }
      }
    });
    out += '</' + tag + '>';
    return any ? out : '';
  }

  const HEADING_TAGS = new Set(['h1','h2','h3','h4','h5','h6']);
  function looksLikeStyledHeading(el, txt) {
    if (!txt || txt.length > 120) return false;
    if (/[.;]$/.test(txt)) return false;
    const style = (el.getAttribute && el.getAttribute('style') || '').toLowerCase();
    const boldTag = /^(b|strong)$/i.test(el.tagName || '');
    const bold = boldTag || /font-weight\s*:\s*(bold|[6-9]00)/.test(style);
    const big = /font-size\s*:\s*(1[3-9]|[2-9]\d)(px|pt)/.test(style);
    const centered = /text-align\s*:\s*center/.test(style);
    if (txt.length <= 90 && (big || (bold && txt.length <= 70))) return true;
    if (centered && bold && txt.length <= 90) return true;
    return false;
  }
  function isCentered(el) {
    const style = (el.getAttribute && el.getAttribute('style') || '').toLowerCase();
    return /text-align\s*:\s*center/.test(style) || (el.getAttribute && el.getAttribute('align') === 'center');
  }

  const BLOCK_CHILD_SEL = 'p,div,section,article,main,table,ul,ol,blockquote,pre,h1,h2,h3,h4,h5,h6,li,tr';

  function walkHtml(root) {
    let out = '';
    function emitParaOrHeading(el, txt) {
      if (!txt) return;
      const tag = (el.tagName || '').toLowerCase();
      if (HEADING_TAGS.has(tag)) { out += '<h4 class="rl-h">' + esc(txt) + '</h4>'; return; }
      if (looksLikeStyledHeading(el, txt)) { out += '<h4 class="rl-h">' + esc(txt) + '</h4>'; return; }
      const centerCls = isCentered(el) ? ' rl-center' : '';
      out += '<p class="rl-p' + centerCls + '">' + esc(txt) + '</p>';
    }
    function recurse(node) {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = cleanText(child.nodeValue);
          if (t) out += '<p class="rl-p">' + esc(t) + '</p>';
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const el = child;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'br') continue;
        if (tag === 'table') { out += convertTable(el); continue; }
        if (tag === 'ul' || tag === 'ol') { out += convertList(el); continue; }
        if (tag === 'blockquote') {
          const t = cleanText(el.textContent);
          if (t) out += '<blockquote class="rl-quote">' + esc(t) + '</blockquote>';
          continue;
        }
        if (tag === 'pre') { if (cleanText(el.textContent)) out += '<pre class="rl-pre">' + esc(el.textContent) + '</pre>'; continue; }
        if (HEADING_TAGS.has(tag)) { emitParaOrHeading(el, cleanText(el.textContent)); continue; }
        if (tag === 'p') { emitParaOrHeading(el, cleanText(el.textContent)); continue; }
        const hasBlockChild = el.querySelector(BLOCK_CHILD_SEL);
        if (hasBlockChild) recurse(el);
        else emitParaOrHeading(el, cleanText(el.textContent));
      }
    }
    recurse(root);
    return out;
  }

  function tidyHtml(html) {
    return html
      .replace(/(<p class="rl-p[^"]*"><\/p>)+/g, '')
      .replace(/(<p class="rl-p">\s*<\/p>)/g, '');
  }

  function formatHtml(rawHtml) {
    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
    doc.querySelectorAll(KILL).forEach(n => n.remove());
    doc.querySelectorAll('img,picture,figure').forEach(n => n.remove());
    unwrapXbrl(doc);
    const root = pickArticleRoot(doc);
    let html = tidyHtml(walkHtml(root));
    if (!html || cleanText(root.textContent).length < 40) {
      const txt = cleanText(root.textContent || doc.body.textContent);
      html = txt.split(/\n{2,}/).map(p => '<p class="rl-p">' + esc(p) + '</p>').join('');
    }
    const title =
      cleanText(doc.querySelector('h1')?.textContent) ||
      cleanText(doc.querySelector('title')?.textContent) || '';
    const text = cleanText(root.textContent || '');
    return { title, html, text };
  }

  // ══════════════════════════════════════════════════════════
  //  PDF PATH — wire-compatible text, NOT a visual copy.
  //  Many press-release PDFs are laid out for print. The wire needs the
  //  words, not the layout, so we pull the text out, drop page numbers and
  //  running headers/footers, and join wrapped lines into paragraphs and
  //  bullets. No canvas, no tables, no base64 stored — light on memory and
  //  the reader shows ordinary selectable HTML like any other release.
  // ══════════════════════════════════════════════════════════
  const PDF_MAX_PAGES = 40;
  let pdfjsLib = null;
  async function ensurePdfjs() {
    if (pdfjsLib) return pdfjsLib;
    const mod = await import('./vendor/pdf.min.mjs');
    mod.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', document.baseURI).toString();
    pdfjsLib = mod;
    return pdfjsLib;
  }
  function base64ToUint8Array(b64) {
    const binary = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ── Layout-aware text extraction (no drawing). Each page becomes rows of
  // "segments" (a run of words; a wide gap starts a new segment). From those we
  // recover: running headers (dropped), contents leaders (dropped), real numeric
  // tables, two-column layouts (read left column, then right), headings by font
  // size, bullets, and wrapped-line paragraphs.
  const isNum = (s) => {
    const t = String(s || '').replace(/\s/g, '');
    return /^[\$£€\(]?[-–]?[\d,]+(?:\.\d+)?[\)%]?$/.test(t) || /^(n\/m|n\/a|nm|–|—|-|\(\d[\d,.]*\))$/i.test(t);
  };
  const rowText = (r) => r.segs.map(s => s.text).join(' ');
  const numSegs = (r) => r.segs.filter(s => isNum(s.text)).length;
  const isTabRow = (r) => r.segs.length >= 3 || (r.segs.length >= 2 && numSegs(r) >= 1);
  const normHF = (t) => t.toLowerCase().replace(/\d+/g, '#');

  function pageToRows(items) {
    const runs = [];
    for (const it of items) {
      if (!it.str) continue;
      const tr = it.transform;
      runs.push({ str: it.str.replace(/[\uE000-\uF8FF\u25A0-\u25AB\u2022\u25CF\u25CB\u2023]/g, '•'), x: tr[4], y: tr[5], xEnd: tr[4] + (it.width || 0), h: Math.abs(it.height || tr[3]) || 10 });
    }
    runs.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const grouped = [];
    for (const r of runs) {
      const last = grouped[grouped.length - 1];
      if (last && Math.abs(last.y - r.y) <= Math.max(2.2, Math.min(last.h, r.h) * 0.55)) {
        last.runs.push(r);
        if (r.str.trim()) last.h = Math.max(last.h, r.h);
      } else grouped.push({ y: r.y, h: r.h, runs: [r] });
    }
    const rows = [];
    for (const g of grouped) {
      g.runs.sort((a, b) => a.x - b.x);
      const gapMax = Math.max(g.h * 0.9, 5);
      const segs = [];
      let cur = null, prev = null;
      for (const r of g.runs) {
        if (!r.str.trim()) continue;   // some PDFs emit gap-wide space items; measure gaps between real runs only
        if (cur && r.str.trim() && (r.x - prev.xEnd) > gapMax) { segs.push(cur); cur = null; }
        if (!cur) cur = { text: r.str, x: r.x, xEnd: r.xEnd };
        else { cur.text += ((r.x - prev.xEnd) < Math.max(prev.h, r.h, 4) * 0.07 ? '' : ' ') + r.str; cur.xEnd = r.xEnd; }
        prev = r;
      }
      if (cur) segs.push(cur);
      segs.forEach(s => { s.text = s.text.replace(/\s+/g, ' ').trim(); });
      const clean = segs.filter(s => s.text);
      if (clean.length) rows.push({ y: g.y, h: g.h, segs: clean });
    }
    return rows;
  }

  // Numeric table from a run of tabular rows. Columns = recurring right edges of numeric cells.
  function buildTable(run) {
    const data = run.filter(r => numSegs(r) >= 2);
    const xs = [];
    data.forEach(r => r.segs.forEach(s => { if (isNum(s.text)) xs.push(s.xEnd); }));
    xs.sort((p, q) => p - q);
    const cl = [];
    for (const x of xs) {
      const l = cl[cl.length - 1];
      if (l && Math.abs(l.c - x) <= 14) { l.v.push(x); l.c = l.v.reduce((p, q) => p + q, 0) / l.v.length; }
      else cl.push({ c: x, v: [x] });
    }
    const cols = cl.filter(c => c.v.length >= Math.max(2, Math.ceil(data.length * 0.4))).map(c => c.c);
    if (cols.length < 2) return null;
    const nearest = (x) => { let bi = 0, bd = Infinity; cols.forEach((c, i) => { const d = Math.abs(c - x); if (d < bd) { bd = d; bi = i; } }); return bi; };
    let html = '<table class="rl-table">', text = '', seenData = false;
    for (const r of run) {
      const cells = new Array(cols.length).fill('');
      const label = [];
      for (const s of r.segs) {
        if (s.xEnd < cols[0] - 30 && !isNum(s.text)) label.push(s.text);
        else { const i = nearest(s.xEnd); cells[i] = (cells[i] ? cells[i] + ' ' : '') + s.text; }
      }
      const isData = numSegs(r) >= 1;
      if (isData) seenData = true;
      const tag = seenData ? 'td' : 'th';
      html += '<tr><' + tag + (seenData ? ' class="rl-label"' : '') + '>' + esc(label.join(' ')) + '</' + tag + '>' +
        cells.map(c => '<' + tag + ' class="num">' + esc(c) + '</' + tag + '>').join('') + '</tr>';
      text += (label.join(' ') + ' ' + cells.filter(Boolean).join(' ')).trim() + '\n';
    }
    return { html: html + '</table>', text };
  }

  // Two-column layout: find an x where a column of text starts (≥3 rows begin there),
  // check nothing on the left runs across it, then read the whole left column first
  // and the right column after. Rows may sit on slightly different baselines — we only
  // look at where each piece of text starts.
  function reorderColumns(rows) {
    const xs = [];
    rows.forEach((r, i) => r.segs.forEach((s, k) => {
      if (k === 0 || s.x - r.segs[k - 1].xEnd >= Math.max(18, r.h * 2.5)) xs.push({ x: s.x, i });
    }));
    xs.sort((p, q) => p.x - q.x);
    const cands = [];
    for (let k = 0; k < xs.length;) {
      let m = k; while (m + 1 < xs.length && xs[m + 1].x - xs[k].x <= 6) m++;
      const idx = [...new Set(xs.slice(k, m + 1).map(o => o.i))];
      if (idx.length >= 3) cands.push({ g: xs[k].x, idx });
      k = m + 1;
    }
    cands.sort((p, q) => q.idx.length - p.idx.length);
    for (const c of cands) {
      const G = c.g - 6, a = Math.min(...c.idx), b = Math.max(...c.idx);
      const L = [], R = [];
      let ok = true, leftN = 0, minLeft = Infinity;
      for (let i = a; i <= b && ok; i++) {
        const r = rows[i];
        const l = r.segs.filter(s => s.x < G), rt = r.segs.filter(s => s.x >= G);
        if (l.some(s => s.xEnd > G - 4)) ok = false;
        l.forEach(s => { leftN++; minLeft = Math.min(minLeft, s.x); });
        if (l.length) L.push({ y: r.y, h: r.h, segs: l });
        if (rt.length) R.push({ y: r.y, h: r.h, segs: rt, brk: !R.length });
      }
      if (ok && leftN >= 3 && G - minLeft >= 90) return rows.slice(0, a).concat(L, R, rows.slice(b + 1));
    }
    return rows;
  }
  // One page of rows → ordered elements (tables built, columns untangled).
  function pageElements(rows) {
    const tab = rows.map(isTabRow);
    const spans = [];
    for (let a = 0; a < rows.length;) {
      if (!tab[a]) { a++; continue; }
      let b = a; while (b + 1 < rows.length && tab[b + 1]) b++;
      const run = rows.slice(a, b + 1);
      if (run.length >= 3 && run.filter(r => numSegs(r) >= 2).length >= 2) {
        const t = buildTable(run);
        if (t) spans.push({ a, b, t });
      }
      a = b + 1;
    }
    const els = [];
    let seq = [];
    const flushSeq = () => { reorderColumns(seq).forEach(r => els.push({ kind: 'row', row: r })); seq = []; };
    for (let i = 0; i < rows.length; i++) {
      const sp = spans.find(s => s.a === i);
      if (sp) { flushSeq(); els.push({ kind: 'table', t: sp.t }); i = sp.b; }
      else seq.push(rows[i]);
    }
    flushSeq();
    if (els.length) els[0].pageStart = true;
    return els;
  }

  async function formatPdf(base64) {
    const pdfjs = await ensurePdfjs();
    const pdf = await pdfjs.getDocument({ data: base64ToUint8Array(base64), disableFontFace: true }).promise;
    const pages = [];
    const n = Math.min(pdf.numPages, PDF_MAX_PAGES);
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      pages.push(pageToRows((await page.getTextContent()).items));
      page.cleanup();
    }
    pdf.destroy();

    // Drop running headers/footers (same text ignoring digits on ≥3 pages), bare page
    // numbers, and contents lines with dot leaders.
    const seen = {};
    pages.forEach(pg => new Set(pg.map(r => normHF(rowText(r)))).forEach(k => { seen[k] = (seen[k] || 0) + 1; }));
    const junk = (r) => {
      const t = rowText(r);
      return /^page\s+\d+(\s*(of|\/)\s*\d+)?$/i.test(t) || /\.{5,}|(\.\s){5,}|…{3,}/.test(t) ||
             (pages.length >= 3 && t.length < 160 && seen[normHF(t)] >= 3);
    };
    const pageNo = (r) => /^\d{1,3}(\s*(of|\/)\s*\d+)?$/.test(rowText(r));
    const clean = pages.map(pg => pg.filter((r, i) => !junk(r) && !(pageNo(r) && (i === 0 || i === pg.length - 1))));

    // Body font size = the most common size by amount of text.
    const sizes = {};
    clean.forEach(pg => pg.forEach(r => { const k = Math.round(r.h * 2) / 2; sizes[k] = (sizes[k] || 0) + rowText(r).length; }));
    const body = Number(Object.keys(sizes).sort((p, q) => sizes[q] - sizes[p])[0]) || 10;

    let html = '', text = '', cur = null, head = null, prev = null;
    const flushHead = () => { if (!head) return; html += '<h' + head.lv + ' class="rl-h">' + esc(head.t) + '</h' + head.lv + '>'; text += head.t + '\n'; head = null; };
    const flushPara = () => {
      if (cur === null) return;
      const t = cur.replace(/\s+/g, ' ').trim(); cur = null;
      if (!t) return;
      text += t + '\n';
      html += isBulletStart(t)
        ? '<ul class="rl-list"><li>' + esc(t.replace(/^\s*(?:[•‣▪◦·\-–—\*]|\(?\d{1,2}[\.\)])\s+/, '')) + '</li></ul>'
        : '<p class="rl-p">' + esc(t) + '</p>';
    };

    for (const pg of clean) {
      for (const el of pageElements(pg)) {
        if (el.kind === 'table') { flushHead(); flushPara(); html += el.t.html; text += el.t.text; prev = null; continue; }
        const r = el.row, t = rowText(r);
        if (t.length <= 110 && r.h >= body * 1.22 && !isBulletStart(t)) {
          flushPara();
          if (head && Math.abs(head.h - r.h) < 0.6) head.t += ' ' + t;
          else { flushHead(); head = { t, h: r.h, lv: r.h >= body * 1.8 ? 2 : 3 }; }
          prev = r; continue;
        }
        flushHead();
        const gap = (prev && !el.pageStart) ? (prev.y - r.y) / Math.max(r.h, prev.h, 1) : null;
        let startNew;
        if (cur === null) startNew = true;
        else if (isBulletStart(t) || r.brk) startNew = true;
        else if (gap === null) startNew = !(/[a-z,;]$/.test(cur) && /^[a-z]/.test(t));   // paragraph continues across a page break
        else startNew = gap > 1.9 || (gap > 1.45 && /[\.\!\?"”]$/.test(cur) && /^[A-Z]/.test(t));
        if (startNew) { flushPara(); cur = t; }
        else cur = /[\-\u2010]$/.test(cur) ? (/^[a-z]/.test(t) ? cur.slice(0, -1) + t : cur + t) : cur + ' ' + t;
        prev = r;
      }
    }
    flushHead(); flushPara();
    return { title: pickPdfTitle(text), html, text: text.trim() };
  }
  function pickPdfTitle(text) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    for (const l of lines) {
      if (l.length < 15) continue;
      if (/contact:?$/i.test(l)) continue;
      if (/^(investor|media|press)\b/i.test(l) && l.length < 40) continue;
      if (isBulletStart(l)) continue;
      return l.slice(0, 200);
    }
    return (lines[0] || 'Untitled Release').slice(0, 200);
  }

  // ══════════════════════════════════════════════════════════
  //  BUILDER (folded in from 1.6 wire-client.js) — no global clash
  // ══════════════════════════════════════════════════════════
  function decodeEntities(s) {
    if (!s) return '';
    let t = String(s);
    t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
         .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
         .replace(/&#39;/gi, "'").replace(/&mdash;/gi, '\u2014').replace(/&ndash;/gi, '\u2013')
         .replace(/&rsquo;/gi, '\u2019').replace(/&lsquo;/gi, '\u2018')
         .replace(/&ldquo;/gi, '\u201C').replace(/&rdquo;/gi, '\u201D').replace(/&hellip;/gi, '\u2026');
    t = t.replace(/&#(\d+);/g, (m, c) => { try { return String.fromCharCode(parseInt(c, 10)); } catch (e) { return m; } });
    t = t.replace(/&#x([0-9a-fA-F]+);/g, (m, c) => { try { return String.fromCharCode(parseInt(c, 16)); } catch (e) { return m; } });
    return t;
  }
  function guessHeadline(body) {
    if (!body) return 'Untitled Release';
    const firstLine = String(body).split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
    return firstLine.slice(0, 200) || 'Untitled Release';
  }
  function detectSourceType(url) {
    if (/\.pdf(\?|#|$)/i.test(url || '')) return 'pdf';
    return 'html';
  }

  // ══════════════════════════════════════════════════════════
  //  SECURITY SANITIZER — READ-TIME defense-in-depth
  //  Stored HTML is produced by our own formatter (only rl-* tags), but we NEVER
  //  trust storage. This strips anything not on the allow-list before innerHTML.
  // ══════════════════════════════════════════════════════════
  const ALLOWED_TAGS = new Set([
    'a','b','blockquote','br','caption','col','colgroup','div','em','h1','h2','h3','h4','h5','h6',
    'i','li','mark','ol','p','pre','q','s','section','small','span','strong','sub','sup',
    'table','tbody','td','tfoot','th','thead','tr','u','ul'
  ]);
  const ALLOWED_ATTRS = {
    'a': new Set(['href','title']),
    'td': new Set(['colspan','rowspan','class']),
    'th': new Set(['colspan','rowspan','scope','class']),
    'col': new Set(['span']),
    'colgroup': new Set(['span']),
    'tr': new Set(['class']),
    '*': new Set(['class'])   // our formatter uses class="rl-*"/"num" — allow class only
  };
  const SAFE_URL = /^(https?:|mailto:|tel:)/i;
  function isSafeUrl(v) {
    if (!v) return false;
    const cleaned = String(v).replace(/[\u0000-\u001F\u007F-\u009F\s]/g, '');
    if (/^javascript:/i.test(cleaned) || /^vbscript:/i.test(cleaned) || /^data:/i.test(cleaned)) return false;
    return SAFE_URL.test(String(v).trim());
  }
  function sanitizeStored(dirty) {
    const doc = new DOMParser().parseFromString(String(dirty || ''), 'text/html');
    doc.querySelectorAll('script,style,link,meta,iframe,object,embed,form,input,button,textarea,select,noscript,base,svg,math')
      .forEach(n => n.remove());
    const out = document.createElement('div');
    (function walk(src, dest) {
      for (const node of Array.from(src.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) { dest.appendChild(document.createTextNode(node.nodeValue)); continue; }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = node.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) { walk(node, dest); continue; }
        const el = document.createElement(tag);
        const tagAllow = ALLOWED_ATTRS[tag] || new Set();
        const globalAllow = ALLOWED_ATTRS['*'];
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || name === 'style' || name === 'srcset') continue;
          if (!(tagAllow.has(name) || globalAllow.has(name))) continue;
          if (name === 'href' && !isSafeUrl(attr.value)) continue;
          // Only allow our own class tokens to avoid CSS-based tricks.
          if (name === 'class') {
            const safe = attr.value.split(/\s+/).filter(c => /^(rl-[a-z-]+|num)$/.test(c)).join(' ');
            if (safe) el.setAttribute('class', safe);
            continue;
          }
          el.setAttribute(name, attr.value);
        }
        if (tag === 'a') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer nofollow'); }
        dest.appendChild(el);
        walk(node, el);
      }
    })(doc.body, out);
    return out.innerHTML;
  }

  // ══════════════════════════════════════════════════════════
  //  PUBLIC
  // ══════════════════════════════════════════════════════════
  async function format(source) {
    if (source.kind === 'pdf') return await formatPdf(source.base64);
    return formatHtml(source.data || '');
  }
  function buildRelease(opts) {
    const title = (opts.title || '').trim() || guessHeadline(opts.bodyText || '');
    return {
      feedId: 'TRN', feedName: 'Training',
      title, link: (opts.link || '').trim(),
      bodyHtml: opts.bodyHtml || '',
      bodyText: (opts.bodyText || '').trim(),
    };
  }

  return {
    format, formatHtml, formatPdf, isNumericCell,
    buildRelease, guessHeadline, detectSourceType, decodeEntities,
    sanitizeStored,
    ensurePdfjs,   // reader's renderPdfInto reuses this loader (one pdf.js instance)
  };
})();

if (typeof window !== 'undefined') window.ReleaseFormatter = ReleaseFormatter;
