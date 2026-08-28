// FILE: frontend/release-formatter.js
// Training Wire — release renderer (SECURITY-CRITICAL).
// Injected releases contain third-party HTML fetched from arbitrary news sources.
// This file is the ONLY thing allowed to turn that untrusted HTML into DOM. It runs
// a strict allow-list sanitizer (tags + attributes), neutralises every script/style/
// event-handler/dangerous-URL vector, and renders PDFs from base64 via blob URLs.
// If a tag/attr isn't on the allow-list, it does not survive. Fail closed, always.
'use strict';

(function () {
  // ── Allow-lists ───────────────────────────────────────────────────────────
  const ALLOWED_TAGS = new Set([
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup',
    'dd', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5',
    'h6', 'hr', 'i', 'img', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'section', 'small',
    'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
    'time', 'tr', 'u', 'ul', 'wbr'
  ]);

  // Per-tag attribute allow-list. Anything not listed is stripped.
  const ALLOWED_ATTRS = {
    'a': new Set(['href', 'title']),
    'img': new Set(['src', 'alt', 'title', 'width', 'height']),
    'time': new Set(['datetime']),
    'td': new Set(['colspan', 'rowspan']),
    'th': new Set(['colspan', 'rowspan', 'scope']),
    'col': new Set(['span']),
    'colgroup': new Set(['span']),
    '*': new Set(['title'])   // globally allowed on any tag
  };

  // URL schemes we permit on href/src.
  const SAFE_URL = /^(https?:|mailto:|tel:)/i;
  const SAFE_IMG_URL = /^(https?:|data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,)/i;

  function isSafeUrl(value, isImage) {
    if (!value) return false;
    const v = value.trim();
    // Block anything that could smuggle javascript: via whitespace/control chars.
    // eslint-disable-next-line no-control-regex
    const cleaned = v.replace(/[\u0000-\u001F\u007F-\u009F\s]/g, '');
    if (/^javascript:/i.test(cleaned)) return false;
    if (/^vbscript:/i.test(cleaned)) return false;
    if (/^data:/i.test(cleaned) && !isImage) return false;
    return isImage ? SAFE_IMG_URL.test(v) : SAFE_URL.test(v);
  }

  // ── Core sanitizer ─────────────────────────────────────────────────────────
  // Parse in an inert document (no scripts run, no resources load), then walk the
  // tree and rebuild only what's on the allow-list.
  function sanitizeHtml(dirty) {
    const doc = new DOMParser().parseFromString(String(dirty || ''), 'text/html');

    // Kill obviously dangerous nodes up front.
    doc.querySelectorAll('script, style, link, meta, iframe, object, embed, form, input, button, textarea, select, noscript, base, svg, math')
      .forEach((n) => n.remove());

    const out = document.createElement('div');
    walk(doc.body, out);
    return out;
  }

  function walk(srcNode, destParent) {
    const children = Array.from(srcNode.childNodes);
    for (const node of children) {
      if (node.nodeType === Node.TEXT_NODE) {
        destParent.appendChild(document.createTextNode(node.nodeValue));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = node.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        // Tag not allowed — but keep its (sanitized) children so text survives.
        walk(node, destParent);
        continue;
      }

      const el = document.createElement(tag);
      copyAttrs(node, el, tag);

      // Harden links: force safe target/rel so a release can't hijack the tab.
      if (tag === 'a') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
      }
      // Lazy-load + async-decode images so a heavy release can't jank the UI.
      if (tag === 'img') {
        el.setAttribute('loading', 'lazy');
        el.setAttribute('decoding', 'async');
        el.setAttribute('referrerpolicy', 'no-referrer');
      }

      destParent.appendChild(el);
      walk(node, el);   // recurse into allowed element
    }
  }

  function copyAttrs(srcEl, destEl, tag) {
    const tagAllow = ALLOWED_ATTRS[tag] || new Set();
    const globalAllow = ALLOWED_ATTRS['*'];
    for (const attr of Array.from(srcEl.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      // Never allow event handlers or style, full stop.
      if (name.startsWith('on')) continue;
      if (name === 'style') continue;
      if (name === 'srcset') continue;   // avoid candidate-URL bypass

      const allowed = tagAllow.has(name) || globalAllow.has(name);
      if (!allowed) continue;

      // URL-bearing attributes get scheme-checked.
      if (name === 'href') {
        if (!isSafeUrl(value, false)) continue;
      }
      if (name === 'src') {
        if (!isSafeUrl(value, true)) continue;
      }

      destEl.setAttribute(name, value);
    }
  }

  // ── Public: render an HTML release into a container ──────────────────────────
  function renderHtmlRelease(release, container) {
    container.innerHTML = '';
    const wrapper = document.createElement('article');
    wrapper.className = 'release-body';

    if (release.headline) {
      const h = document.createElement('h2');
      h.className = 'release-headline';
      h.textContent = release.headline;   // textContent = no injection possible
      wrapper.appendChild(h);
    }

    const clean = sanitizeHtml(release.html || '');
    wrapper.appendChild(clean);

    if (release.sourceUrl) {
      const src = document.createElement('a');
      src.className = 'release-source';
      src.href = isSafeUrl(release.sourceUrl, false) ? release.sourceUrl : '#';
      src.target = '_blank';
      src.rel = 'noopener noreferrer nofollow';
      src.textContent = 'View original source';
      wrapper.appendChild(src);
    }

    container.appendChild(wrapper);
    return wrapper;
  }

  // ── Public: render a PDF release from base64 via a blob URL ──────────────────
  const _blobUrls = new Set();
  function renderPdfRelease(release, container) {
    container.innerHTML = '';
    const wrapper = document.createElement('article');
    wrapper.className = 'release-body release-pdf';

    if (release.headline) {
      const h = document.createElement('h2');
      h.className = 'release-headline';
      h.textContent = release.headline;
      wrapper.appendChild(h);
    }

    let blobUrl = null;
    try {
      const bytes = base64ToBytes(release.base64 || '');
      const blob = new Blob([bytes], { type: 'application/pdf' });
      blobUrl = URL.createObjectURL(blob);
      _blobUrls.add(blobUrl);
    } catch (e) {
      const err = document.createElement('p');
      err.className = 'release-error';
      err.textContent = 'This PDF release could not be displayed.';
      wrapper.appendChild(err);
      container.appendChild(wrapper);
      return wrapper;
    }

    // Use <embed> against a blob: URL — CSP frame-src blob: allows exactly this
    // and nothing else. #toolbar tweaks keep the viewer chrome minimal.
    const frame = document.createElement('embed');
    frame.className = 'release-pdf-frame';
    frame.type = 'application/pdf';
    frame.src = blobUrl + '#toolbar=1&navpanes=0&view=FitH';
    wrapper.appendChild(frame);

    const dl = document.createElement('a');
    dl.className = 'release-pdf-download';
    dl.href = blobUrl;
    dl.download = (release.headline ? slug(release.headline) : 'release') + '.pdf';
    dl.textContent = 'Open / download PDF';
    wrapper.appendChild(dl);

    container.appendChild(wrapper);
    return wrapper;
  }

  // Free blob URLs when a release view is torn down (prevents memory leaks).
  function revokeAll() {
    for (const u of _blobUrls) { try { URL.revokeObjectURL(u); } catch (e) {} }
    _blobUrls.clear();
  }

  // ── Router ───────────────────────────────────────────────────────────────
  function render(release, container) {
    if (!release || !container) return null;
    if (release.kind === 'pdf') return renderPdfRelease(release, container);
    return renderHtmlRelease(release, container);
  }

  // Plain-text preview (for list rows / cards) — strips ALL markup safely.
  function preview(release, maxLen = 180) {
    if (release.headline) return truncate(release.headline, maxLen);
    if (release.kind === 'pdf') return '[PDF release]';
    const doc = new DOMParser().parseFromString(release.html || '', 'text/html');
    const text = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    return truncate(text, maxLen) || '[Empty release]';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function base64ToBytes(b64) {
    const clean = String(b64).replace(/\s/g, '');
    const bin = atob(clean);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'release'; }

  window.ReleaseFormatter = { render, renderHtmlRelease, renderPdfRelease, preview, sanitizeHtml, revokeAll };
})();