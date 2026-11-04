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

  // One page → [{text, gap}] (gap = blank space above the line, in line-heights).
  // Runs on a line are glued with a gap test so "Rev"+"en"+"ue" stays one word.
  function pageToLines(items) {
    const runs = items.filter(it => it.str).map(it => {
      const tr = it.transform, h = it.height || Math.abs(tr[3]) || 10;
      return { str: it.str, x: tr[4], y: tr[5], xEnd: tr[4] + (it.width || 0), h };
    });
    const rows = [];
    runs.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    for (const r of runs) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - r.y) <= Math.max(2.2, r.h * 0.55)) last.runs.push(r);
      else rows.push({ y: r.y, h: r.h, runs: [r] });
    }
    const lines = [];
    let prev = null;
    for (const row of rows) {
      row.runs.sort((a, b) => a.x - b.x);
      let s = '';
      row.runs.forEach((r, i) => {
        if (!i) { s = r.str; return; }
        const p = row.runs[i - 1];
        s += ((r.x - p.xEnd) < Math.max(p.h, r.h, 4) * 0.07 ? '' : ' ') + r.str;
      });
      s = s.replace(/\s+/g, ' ').trim();
      if (!s) continue;
      lines.push({ text: s, gap: prev ? (prev.y - row.y) / Math.max(row.h, prev.h, 1) : 0 });
      prev = row;
    }
    return lines;
  }

  const normHF = (t) => t.toLowerCase().replace(/\d+/g, '#');

  function linesToParagraphs(lines) {
    const paras = [];
    let cur = null;
    for (const ln of lines) {
      const t = ln.text;
      const startNew = cur === null || ln.gap > 1.7 || isBulletStart(t);
      if (startNew) { if (cur) paras.push(cur); cur = t; }
      else cur = (/[\-\u2010]$/.test(cur) && /^[a-z]/.test(t)) ? cur.slice(0, -1) + t : cur + ' ' + t;
    }
    if (cur) paras.push(cur);
    return paras;
  }

  async function formatPdf(base64) {
    const pdfjs = await ensurePdfjs();
    const pdf = await pdfjs.getDocument({ data: base64ToUint8Array(base64), disableFontFace: true }).promise;
    const pages = [];
    const n = Math.min(pdf.numPages, PDF_MAX_PAGES);
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      pages.push(pageToLines((await page.getTextContent()).items));
      page.cleanup();
    }
    pdf.destroy();

    // Running headers/footers (same text ignoring digits on ≥3 pages) and bare page numbers.
    const seen = {};
    pages.forEach(pg => new Set(pg.map(l => normHF(l.text))).forEach(k => { seen[k] = (seen[k] || 0) + 1; }));
    const junk = (t) => /^(page\s+)?\d+(\s*(of|\/)\s*\d+)?$/i.test(t) || (pages.length >= 3 && t.length < 90 && seen[normHF(t)] >= 3);
    const lines = [];
    pages.forEach(pg => pg.forEach(l => { if (!junk(l.text)) lines.push(l); }));

    let html = '', text = '';
    for (const para of linesToParagraphs(lines)) {
      const t = para.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      text += t + '\n';
      html += isBulletStart(t)
        ? '<ul class="rl-list"><li>' + esc(t.replace(/^\s*(?:[•‣▪◦·\-–—\*]|\(?\d{1,2}[\.\)])\s+/, '')) + '</li></ul>'
        : '<p class="rl-p">' + esc(t) + '</p>';
    }
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
