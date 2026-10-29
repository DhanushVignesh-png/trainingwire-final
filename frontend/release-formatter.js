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
  //  PDF PATH — gap-analysis word joining + global column model
  //
  //  The old path produced "dancing" output for two reasons:
  //    1) it joined every text item on a line with a single space, so PDF.js
  //       glyph runs became "Phas e II I" / "Rev en ue" / "los s"; and
  //    2) it detected columns per row-batch with loose clustering, so the same
  //       figure landed under different columns on different rows.
  //
  //  This rewrite fixes both:
  //    - WORD JOINING is decided by the real horizontal gap between two items,
  //      measured against the font size. A gap smaller than a fraction of the
  //      space width means the two runs are one word (no space); a large gap
  //      means a column break. This kills the split-word artefacts outright.
  //    - COLUMNS are modelled ONCE PER PAGE from the right edges of every
  //      numeric cell, then every row's figures are snapped to that fixed set
  //      of columns. Figures therefore line up vertically across all rows.
  //
  //  PDF.js is loaded from local vendor files (CSP allows worker-src 'self'
  //  blob:). Image-only / scanned PDFs have no text layer and are out of scope.
  // ══════════════════════════════════════════════════════════
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
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // One text run from PDF.js, with geometry we actually need.
  //   x    left edge           xEnd right edge
  //   y    baseline            h    glyph height (~font size)
  //   sp   nominal space width for this run's font (0 when PDF.js omits it)
  function toRun(it) {
    const tr = it.transform;
    const x = tr[4];
    const y = tr[5];
    const h = it.height || Math.abs(tr[3]) || 10;
    const w = it.width || 0;
    // PDF.js does not give a space width directly; estimate from font height.
    // 0.25 * font size is a reliable nominal space for body text.
    const sp = h * 0.25;
    return { str: it.str, x, y, xEnd: x + w, w, h, sp, eol: !!it.hasEOL };
  }

  // Cluster runs into visual lines by baseline. yTol scales with font height so
  // a heading line and a footnote line are both grouped correctly.
  function clusterLines(runs) {
    const sorted = runs.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const lines = [];
    for (const r of sorted) {
      if (!r.str) continue;
      const tol = Math.max(2.2, (r.h || 10) * 0.55);
      let line = null;
      // Search from the end: lines are built top-down, matches are usually recent.
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
        if (Math.abs(lines[i].y - r.y) <= tol) { line = lines[i]; break; }
      }
      if (!line) { line = { y: r.y, h: r.h || 10, runs: [] }; lines.push(line); }
      line.runs.push(r);
      line.h = Math.max(line.h, r.h || 10);
    }
    lines.forEach(l => l.runs.sort((a, b) => a.x - b.x));
    lines.sort((a, b) => b.y - a.y);
    return lines;
  }

  // ── WORD JOINING ──
  // Walk a line's runs left to right and decide, at each boundary, whether the
  // two runs are: the same word (no separator), separate words (one space), or
  // a column break (recorded as a segment boundary). Returns:
  //   { text, segments:[{ text, x, xEnd }] }
  // where segments are the whitespace-separated "cells" of the line, each
  // carrying its own geometry so the column model can use their right edges.
  function joinLineRuns(runs) {
    const segs = [];
    let curText = '';
    let curX = null, curEnd = null;
    let fullText = '';

    const pushSeg = () => {
      const t = curText.replace(/\s+/g, ' ').trim();
      if (t) segs.push({ text: t, x: curX, xEnd: curEnd });
      curText = ''; curX = null; curEnd = null;
    };

    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const piece = r.str;
      if (!piece) continue;
      if (curText === '') {
        curText = piece; curX = r.x; curEnd = r.xEnd; fullText += piece;
        continue;
      }
      const prev = runs[i - 1];
      const gap = r.x - (prev ? prev.xEnd : curEnd);
      const sp = Math.max(prev ? prev.sp : r.sp, r.sp, 1);

      // Tunables, all expressed as multiples of the nominal space width:
      //   < 0.28 sp  → glued: same word, insert nothing  ("Rev"+"en"+"ue")
      //   < 2.2  sp  → ordinary inter-word space
      //   ≥ 2.2  sp  → a visual column gap: break into a new segment
      if (gap < sp * 0.28) {
        // Same word. Also handle a soft hyphen split across runs.
        if (/[\u2010\u2011-]$/.test(curText) && /^[a-z]/.test(piece)) {
          curText = curText.replace(/[\u2010\u2011-]$/, '') + piece;
          fullText = fullText.replace(/[\u2010\u2011-]$/, '') + piece;
        } else {
          curText += piece; fullText += piece;
        }
        curEnd = r.xEnd;
      } else if (gap < sp * 2.2) {
        curText += ' ' + piece; curEnd = r.xEnd; fullText += ' ' + piece;
      } else {
        pushSeg();
        curText = piece; curX = r.x; curEnd = r.xEnd; fullText += '   ' + piece;
      }
    }
    pushSeg();
    return { text: fullText.replace(/\s+/g, ' ').trim(), segments: segs };
  }

  // A segment that is a figure (money, percent, count, bracketed negative, dash).
  const isNumericSeg = (s) => isNumericCell(s);

  // ── GLOBAL COLUMN MODEL ──
  // Collect the RIGHT edge of every numeric segment across the whole page, then
  // cluster those edges. Each surviving cluster is one figure column. Using the
  // right edge (not the centre) is what makes right-aligned figures line up.
  function buildColumnModel(lines) {
    const edges = [];
    for (const ln of lines) {
      for (const seg of ln.segments) {
        if (isNumericSeg(seg.text)) edges.push(seg.xEnd);
      }
    }
    if (edges.length < 3) return [];
    edges.sort((a, b) => a - b);
    const clusters = [];
    const TOL = 14;   // points; two edges within this are the same column
    for (const e of edges) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(last.edge - e) <= TOL) {
        last.vals.push(e);
        last.edge = last.vals.reduce((s, v) => s + v, 0) / last.vals.length;
      } else {
        clusters.push({ edge: e, vals: [e] });
      }
    }
    // Keep only columns that recur — a column appears on several rows. This
    // discards stray inline figures in prose ("$0.25 per share").
    return clusters.filter(c => c.vals.length >= 3).map(c => c.edge).sort((a, b) => a - b);
  }

  // Lay one line's segments onto the fixed column model.
  //   label — everything left of the first figure column (joined)
  //   cols  — one string per model column, '' where the line has no figure
  // Returns null when the line has no figure sitting in any model column (prose).
  function layoutRow(line, colEdges) {
    const cols = new Array(colEdges.length).fill('');
    const labelParts = [];
    let placed = 0;
    for (const seg of line.segments) {
      if (isNumericSeg(seg.text)) {
        // Snap to the nearest column by right edge.
        let bestI = -1, bestD = Infinity;
        for (let i = 0; i < colEdges.length; i++) {
          const d = Math.abs(colEdges[i] - seg.xEnd);
          if (d < bestD) { bestD = d; bestI = i; }
        }
        if (bestI >= 0 && bestD <= 26) {
          cols[bestI] = (cols[bestI] ? cols[bestI] + ' ' : '') + seg.text;
          placed++;
          continue;
        }
      }
      labelParts.push(seg.text);
    }
    if (!placed) return null;
    return { label: labelParts.join(' ').replace(/\s+/g, ' ').trim(), cols };
  }

  // A run of consecutive table rows → one <table>. A standalone label row with
  // no figures that reads like a section header spans the whole width.
  function emitTable(rowBuf, colEdges, plainRef) {
    if (!rowBuf.length) return '';
    let out = '<table class="rl-table rl-table-text">';
    for (const r of rowBuf) {
      if (r.section) {
        out += '<tr class="rl-sec"><td colspan="' + (colEdges.length + 1) + '">' + esc(r.label) + '</td></tr>';
        plainRef.text += r.label + '\n';
        continue;
      }
      out += '<tr><td class="rl-label">' + esc(r.label) + '</td>';
      for (const c of r.cols) out += '<td class="num">' + esc(c) + '</td>';
      out += '</tr>';
      plainRef.text += (r.label + ' ' + r.cols.join(' ')).replace(/\s+/g, ' ').trim() + '\n';
    }
    out += '</table>';
    return out;
  }

  // Prose assembly: join wrapped lines into paragraphs, keep bullets separate.
  function emitProse(proseBuf, plainRef) {
    if (!proseBuf.length) return '';
    const paras = [];
    let cur = '', prevH = 12;
    for (const ln of proseBuf) {
      const t = ln.text.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const h = ln.h || prevH;
      let startNew = false;
      if (!cur) startNew = true;
      else if (isBulletStart(t)) startNew = true;
      else if (/[.!?:;""]$/.test(cur)) startNew = true;   // sentence ended → new para only on big gap handled below
      // A short previous line that ended a sentence is a paragraph end.
      if (startNew) { if (cur) paras.push(cur); cur = t; }
      else {
        if (/[\u2010\u2011-]$/.test(cur)) cur = cur.replace(/[\u2010\u2011-]$/, '') + t;
        else cur += ' ' + t;
      }
      prevH = h;
    }
    if (cur) paras.push(cur);

    let out = '';
    for (const p of paras) {
      const t = p.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      plainRef.text += t + '\n';
      if (isBulletStart(t)) {
        const clean = t.replace(/^\s*(?:[•‣▪◦·\-–—\*]|\(?\d{1,2}[\.\)])\s+/, '');
        out += '<ul class="rl-list"><li>' + esc(clean) + '</li></ul>';
      } else if (looksLikeSectionHeader(t) && t.length <= 70) {
        out += '<h4 class="rl-h">' + esc(t) + '</h4>';
      } else {
        out += '<p class="rl-p">' + esc(t) + '</p>';
      }
    }
    return out;
  }

  // A label-only line that introduces a table section ("Current assets:").
  function isSectionLabel(label) {
    const t = String(label || '').trim();
    if (!t || t.length > 60) return false;
    return /:$/.test(t) || looksLikeSectionHeader(t);
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
      const runs = content.items
        .filter(it => it.str && it.str.length)
        .map(toRun)
        .filter(r => r.str && r.str.trim());
      if (!runs.length) continue;

      // 1) group into visual lines, 2) word-join each line into segments.
      const lines = clusterLines(runs).map(l => {
        const j = joinLineRuns(l.runs);
        return { y: l.y, h: l.h, text: j.text, segments: j.segments };
      }).filter(l => l.text);

      // 3) model the page's figure columns once.
      const colEdges = buildColumnModel(lines);

      // 4) walk lines, routing each to a table run or to prose, flushing the
      //    opposite buffer at every switch so order is preserved.
      let rowBuf = [];
      let proseBuf = [];
      const flushTable = () => { if (rowBuf.length) { html += emitTable(rowBuf, colEdges, plainRef); rowBuf = []; } };
      const flushProse = () => { if (proseBuf.length) { html += emitProse(proseBuf, plainRef); proseBuf = []; } };

      for (const ln of lines) {
        const bullet = isBulletStart(ln.text);
        const row = colEdges.length ? layoutRow(ln, colEdges) : null;

        if (row && !bullet) {
          // A figure-bearing line → table row.
          flushProse();
          rowBuf.push(row);
        } else if (colEdges.length && rowBuf.length && isSectionLabel(ln.text) && !bullet) {
          // A section label sitting inside a table block ("Current assets:").
          rowBuf.push({ section: true, label: ln.text });
        } else {
          // Prose.
          flushTable();
          proseBuf.push(ln);
        }
      }
      flushTable();
      flushProse();
    }

    html = html
      .replace(/(<p class="rl-p">\s*<\/p>)+/g, '')
      .replace(/<table class="rl-table rl-table-text"><\/table>/g, '');

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
