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
  //  PDF PATH — PDF.js text + coordinate clustering
  // ══════════════════════════════════════════════════════════
  let pdfjsLib = null;
  async function ensurePdfjs() {
    if (pdfjsLib) return pdfjsLib;
    // Local vendor files (same-origin). CSP allows worker-src 'self' blob:.
    const mod = await import('./vendor/pdf.min.mjs');
    mod.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', document.baseURI).toString();
    pdfjsLib = mod;
    return pdfjsLib;
  }
  function base64ToUint8Array(b64) {
    const binary = atob(String(b64).replace(/\s/g, ''));
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function itemsToRows(items) {
    const yTol = 3;
    const rows = [];
    const sorted = items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
    for (const it of sorted) {
      if (!it.str || !it.str.trim()) continue;
      let row = rows.find(r => Math.abs(r.y - it.y) <= yTol);
      if (!row) { row = { y: it.y, h: it.h || 10, cells: [] }; rows.push(row); }
      row.cells.push(it);
      row.h = Math.max(row.h, it.h || 10);
    }
    rows.forEach(r => r.cells.sort((a, b) => a.x - b.x));
    rows.sort((a, b) => b.y - a.y);
    return rows;
  }
  const rowText = (r) => r.cells.map(c => c.str).join(' ').replace(/\s+/g, ' ').trim();
  const rowLeftX = (r) => (r.cells.length ? r.cells[0].x : 0);
  function detectNumericColumns(rows) {
    const xs = [];
    rows.forEach(r => r.cells.forEach(c => { if (isNumericCell(c.str)) xs.push(c.x + c.w / 2); }));
    if (!xs.length) return [];
    xs.sort((a, b) => a - b);
    const clusters = [];
    for (const x of xs) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(last.center - x) <= 25) { last.vals.push(x); last.center = last.vals.reduce((s, v) => s + v, 0) / last.vals.length; }
      else clusters.push({ center: x, vals: [x] });
    }
    return clusters.filter(c => c.vals.length >= 3).map(c => c.center);
  }
  function assignToColumns(row, colCenters) {
    const cols = new Array(colCenters.length).fill('');
    const labelParts = [];
    for (const c of row.cells) {
      const cx = c.x + c.w / 2;
      let placed = false;
      if (isNumericCell(c.str) && colCenters.length) {
        let bestI = -1, bestD = Infinity;
        colCenters.forEach((cc, i) => { const d = Math.abs(cc - cx); if (d < bestD) { bestD = d; bestI = i; } });
        if (bestI >= 0 && bestD <= 40) { cols[bestI] = (cols[bestI] ? cols[bestI] + ' ' : '') + c.str.trim(); placed = true; }
      }
      if (!placed) labelParts.push(c.str.trim());
    }
    return { label: labelParts.join(' ').replace(/\s+/g, ' ').trim(), cols };
  }
  function runIsRealTable(rows, colCenters) {
    if (colCenters.length < 2) return false;
    let multiColRows = 0, bulletRows = 0, dataRows = 0;
    for (const r of rows) {
      const { cols } = assignToColumns(r, colCenters);
      const filled = cols.filter(c => c && c.trim()).length;
      if (filled >= 2) multiColRows++;
      if (filled >= 1) dataRows++;
      if (isBulletStart(rowText(r))) bulletRows++;
    }
    if (multiColRows < 3) return false;
    if (bulletRows > rows.length * 0.4) return false;
    if (dataRows < rows.length * 0.5) return false;
    return true;
  }
  function buildTableFromRows(rows, colCenters) {
    let out = '<table class="rl-table">';
    for (const r of rows) {
      const { label, cols } = assignToColumns(r, colCenters);
      const hasNums = cols.some(c => c && c.trim());
      if (!label && !hasNums) continue;
      if (label && !hasNums && looksLikeSectionHeader(label)) {
        out += '<tr class="rl-sec"><td colspan="' + (colCenters.length + 1) + '">' + esc(label) + '</td></tr>';
        continue;
      }
      out += '<tr><td class="rl-label">' + esc(label) + '</td>';
      for (const c of cols) out += '<td class="num">' + esc(c) + '</td>';
      out += '</tr>';
    }
    out += '</table>';
    return out;
  }
  function rowsToParagraphs(rows) {
    const paras = [];
    let cur = null, prevY = null, prevH = 12, prevLeft = null;
    for (const r of rows) {
      const text = rowText(r);
      if (!text) continue;
      const y = r.y, h = r.h || prevH, left = rowLeftX(r);
      let startNew = false;
      if (cur === null) startNew = true;
      else if (isBulletStart(text)) startNew = true;
      else if (prevY !== null) {
        const gap = prevY - y;
        const lineStep = Math.max(h, prevH);
        if (gap > lineStep * 1.6) startNew = true;
        else if (left > prevLeft + 8 && /[\.\!\?""]\s*$/.test(cur)) startNew = true;
      }
      if (startNew) { if (cur) paras.push(cur); cur = text; }
      else {
        if (/[\-\u2010]$/.test(cur)) cur = cur.replace(/[\-\u2010]$/, '') + text;
        else cur = cur + ' ' + text;
      }
      prevY = y; prevH = h; prevLeft = left;
    }
    if (cur) paras.push(cur);
    return paras;
  }
  function paragraphsToHtml(paras, plainRef) {
    let out = '';
    for (const p of paras) {
      const t = p.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      plainRef.text += t + '\n';
      if (isBulletStart(t)) {
        const clean = t.replace(/^\s*(?:[•‣▪◦·\-–—\*]|\(?\d{1,2}[\.\)])\s+/, '');
        out += '<ul class="rl-list"><li>' + esc(clean) + '</li></ul>';
      } else {
        out += '<p class="rl-p">' + esc(t) + '</p>';
      }
    }
    return out;
  }
  async function formatPdf(base64) {
    const pdfjs = await ensurePdfjs();
    const data = base64ToUint8Array(base64);
    const pdf = await pdfjs.getDocument({ data }).promise;
    let html = '';
    const plainRef = { text: '' };
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = content.items.map(it => {
        const tr = it.transform;
        return { str: it.str, x: tr[4], y: tr[5], w: it.width || 0, h: it.height || Math.abs(tr[3]) || 10 };
      }).filter(it => it.str && it.str.trim());
      const rows = itemsToRows(items);
      const colCenters = detectNumericColumns(rows);
      if (colCenters.length >= 2) {
        let proseBuf = [], tableBuf = [];
        const flushProse = () => { if (!proseBuf.length) return; html += paragraphsToHtml(rowsToParagraphs(proseBuf), plainRef); proseBuf = []; };
        const flushTable = () => {
          if (!tableBuf.length) return;
          if (runIsRealTable(tableBuf, colCenters)) { html += buildTableFromRows(tableBuf, colCenters); tableBuf.forEach(r => { plainRef.text += rowText(r) + '\n'; }); }
          else html += paragraphsToHtml(rowsToParagraphs(tableBuf), plainRef);
          tableBuf = [];
        };
        for (const r of rows) {
          const { cols } = assignToColumns(r, colCenters);
          const filled = cols.filter(c => c && c.trim()).length;
          const bullet = isBulletStart(rowText(r));
          if (filled >= 2 && !bullet) { flushProse(); tableBuf.push(r); }
          else { flushTable(); proseBuf.push(r); }
        }
        flushProse(); flushTable();
      } else {
        html += paragraphsToHtml(rowsToParagraphs(rows), plainRef);
      }
    }
    const title = pickPdfTitle(plainRef.text);
    return { title, html, text: plainRef.text.trim() };
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
  };
})();

if (typeof window !== 'undefined') window.ReleaseFormatter = ReleaseFormatter;
