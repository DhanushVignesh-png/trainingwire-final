// Training Wire — Release Builder v3.3
// Builds normalized story items from a fetched URL (HTML or PDF).
//
// NAMED ReleaseBuilder, not WireClient. On the hosted build, WireClient is the
// API client in wire-client.js. A top-level `const WireClient` here would sit
// in the global lexical scope and SHADOW window.WireClient for every bare
// reference in terminal.js — the API client would silently vanish. The binding
// has to differ, not just the export.
console.log('Training Wire: Release Builder v3.3 loaded');

const ReleaseBuilder = (() => {
  'use strict';

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

  function stripTags(html) {
    if (!html) return '';
    return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  function guessHeadline(body) {
    if (!body) return 'Untitled Release';
    const firstLine = String(body).split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
    return firstLine.slice(0, 200) || 'Untitled Release';
  }

  // Detect source type from a URL string (fast client-side hint; background confirms).
  function detectSourceType(url) {
    if (/\.pdf(\?|#|$)/i.test(url || '')) return 'pdf';
    return 'html';
  }

  // Build a normalized story item.
  // opts: { title, bodyHtml, bodyText, link }
  //  - bodyHtml : formatted, structured HTML for the reader (tables/bullets/paras)
  //  - bodyText : plain-text fallback (used for keyword search / headline guess)
  function buildRelease(opts) {
    const title = (opts.title || '').trim() || guessHeadline(opts.bodyText || '');
    const bodyHtml = opts.bodyHtml || '';
    const bodyText = (opts.bodyText || '').trim();
    const link = (opts.link || '').trim();
    return {
      feedId: 'TRN',
      feedName: 'Training',
      title,
      link,
      guid: link || (title + '|' + Date.now()),
      pubDate: '',
      pubEpoch: Date.now(),
      bodyHtml,
      bodyText
    };
  }

  return { buildRelease, stripTags, decodeEntities, guessHeadline, detectSourceType };
})();

if (typeof window !== 'undefined') window.ReleaseBuilder = ReleaseBuilder;