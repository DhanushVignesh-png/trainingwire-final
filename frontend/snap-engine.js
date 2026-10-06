// Training Wire — Snap Engine v6.2 (BOARD + DEAL; precision hardening)
// Rule-based (NO AI) auto-snapper for UK / LSE RNS releases ONLY.
// Categories: BOARD appointments/departures + DEALS (firm/possible/increased),
// RESPONSE, RULE 2.8. NO trading updates, NO profit warnings, NO per-share value.
//
// v6.1 CHANGES vs v6.0 (BOARD + shared; deal path preserved):
//   1. DEFINED-TERM STRIP on the board path. Removes inline ("CEO") / ("CFO")
//      defined terms that sit between a name and its role (unblocks Rank, Wood).
//   2. APPOSITIVE PATTERN: "NAME, [currently/the Company's] ROLE, <verb>".
//   3. ROLE INHERITANCE for succession: "X ... as CEO, succeeding Y" => Y steps
//      down AS CEO (not generic BOARD). "X will succeed Y as CEO" => X appointed
//      CEO + Y steps down AS CEO (both sides).
//   4. matchAll: multiple people in one sentence are ALL captured.
//   5. SOURCE FALLBACK for non-standard (non "RNS Number:") layouts (Fermi).
//   6. CHAIR / SID / NED phrasing hardening (user will test).
//   7. "step up to / assume / take up the role of ROLE" = APPOINTMENT (and is
//      never mis-read as a departure — "step up" != "step down").
//   8. "succeed" as an appointment verb (see #3).
//   9. NO CONTRADICTORY SNAPS: a person appointed to a role is not also emitted
//      as stepping down from that same role in the same release.
//  13. EFFECTIVE DATES are never emitted — see the note above BACKGROUND_ONLY.
//
// v6.2 CHANGES vs v6.1 (BOARD only; deal path byte-identical):
//   A. GLUE REPAIR no longer eats surnames. "Harris" became "Harr is",
//      "Thomas" "Thom as", "basis" "bas is". Two narrow rules replace one
//      broad one; honorifics glued to forenames ("MrMark") are also split.
//   B. ROLE SCOPE replaces the divisional regex, which ran under /i where
//      "of" matches the "Of" inside "Officer" — so every plain
//      "Chief Executive Officer" was discarded as divisional. Scope is now
//      decided by comparing the entity named after the role against the
//      filer's own name and defined short names. Committee chairs
//      ("Chairman of the Audit Committee") are not board changes and are
//      not emitted; "Chairman of the Board" is.
//   C. NAMES: the pattern lists run case-insensitively, so a greedy NAME
//      swallows neighbouring glue; that is now trimmed rather than causing a
//      rejection. Forenames that double as stop words survive ("Will
//      Truman"), as do parenthesised nicknames ("Tat Cheung (Stephen) Wong").
//   D. EFFECTIVE DATES removed entirely (see #13).
//   E. New phrasings: "as the company's new CFO", "X appointed as ROLE" with
//      no auxiliary, "appointed X to the role of ROLE", "X will join the
//      Board as ROLE", "appoint ROLE, NAME, as ROLE", "NAME, the current
//      ROLE, has been appointed ROLE", "on an interim basis", a role taken
//      from the release title when the sentence states none, plus the roles
//      "Non-Executive Chair" and "Chief Finance Officer".
//   F. New departures: "step down from his/her role as", "is leaving",
//      "retirement of X from the Board", role stated before the name with a
//      bare "has", the "informed the Board that ... and step down" idiom,
//      and a role picked up from later in the same sentence when the
//      departure itself names none.
//
// Regression fixtures for all of the above live in test/ — run
// `node test/run.js --all` after any change to this file.
console.log('Training Wire: Snap Engine v6.2 loaded');

const SnapEngine = (() => {
  'use strict';

  const HARD_CAP = 220;
  const WORD_WINDOW_BOARD = 700;
  const WORD_WINDOW_DEAL = 4000;

  const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
  const DATE_LINE = new RegExp('^\\s*\\d{1,2}(?:st|nd|rd|th)?\\s+(' + MONTHS + ')\\s+\\d{4}\\s*$', 'i');

  // ── text utils ──────────────────────────────────────────────────────────
  const clean = (s) => String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function stripTerminalJunk(text) {
    let t = String(text || '');
    t = t.replace(/London Stock Exchange plc is not responsible[\s\S]*$/i, '');
    t = t.replace(/\u00A9\s*\d{4}\s*London Stock Exchange plc\.[\s\S]*$/i, '');
    t = t.replace(/\bEND\b\s*[\r\n]+\s*[A-Z]{8,}\b[\s\S]*$/, '\nEND\n');
    t = t.replace(/\n[A-Z]{12,}\s*$/, '\n');
    t = t.replace(/\u2913\s*Export PDF/gi, ' ');
    return t;
  }

  function normaliseBlob(text) {
    let t = String(text || '');
    const newlineCount = (t.match(/\n/g) || []).length;
    if (newlineCount > 2 || t.length < 400) return t;
    t = t.replace(/\s+(RNS Number\s*:)/gi, '\n$1');
    t = t.replace(/\s+(NOT FOR RELEASE)/gi, '\n$1');
    t = t.replace(/\s+(NEITHER THIS ANNOUNCEMENT)/gi, '\n$1');
    t = t.replace(/\s+(THIS IS AN ANNOUNCEMENT)/gi, '\n$1');
    t = t.replace(/\s+(THIS ANNOUNCEMENT (?:IS|CONTAINS))/gi, '\n$1');
    t = t.replace(/\s+(FOR IMMEDIATE RELEASE)/gi, '\n$1');
    t = t.replace(/\s+(THERE CAN BE NO CERTAINTY)/gi, '\n$1');
    t = t.replace(/\s+(Enquiries:)/gi, '\n$1');
    t = t.replace(/\s+(Dealing disclosure requirements)/gi, '\n$1');
    t = t.replace(/\s+(Important Information)/gi, '\n$1');
    t = t.replace(/\s+(END)\b/g, '\n$1');
    t = t.replace(new RegExp('([.;])\\s+(\\d{1,2}(?:st|nd|rd|th)?\\s+(?:' + MONTHS + ')\\s+\\d{4})\\b', 'g'), '$1\n$2');
    return t;
  }

  // ── glue-repair (DEAL only) ───────────────────────────────────────────────
  const GLUE_KEYWORDS = 'share|shareholder|shareholders|receive|each|every|for|of|value|valued|valuation|values|cash|consideration|entire|issued|capital';

  function repairGlue(text) {
    let t = String(text || '');
    t = t.replace(/([A-Za-z0-9])\(/g, '$1 (');
    const kwLowerBefore = new RegExp('\\b(' + GLUE_KEYWORDS + ')([A-Z])', 'gi');
    t = t.replace(kwLowerBefore, (m, kw, up) => kw + ' ' + up);
    const kwAfterCap = new RegExp('([a-z])(Share|Shareholder|Shareholders|Value|Consideration|Cash|Capital)\\b', 'g');
    t = t.replace(kwAfterCap, (m, ch, kw) => ch + ' ' + kw);
    const digKw = new RegExp('(' + GLUE_KEYWORDS + ')(\\d)', 'gi');
    t = t.replace(digKw, (m, kw, d) => kw + ' ' + d);
    const kwDig = new RegExp('(\\d)(' + GLUE_KEYWORDS + ')\\b', 'gi');
    t = t.replace(kwDig, (m, d, kw) => d + ' ' + kw);
    t = t.replace(/[ \t]{2,}/g, ' ');
    return t;
  }

  // ── glue-repair (BOARD) — targeted, name-safe ─────────────────────────────
  const BOARD_GLUE_LOWER_KW = 'announces|announced|advises|advise|informed|informs|inform|appointed|appoint|appoints|following|that|joined|join|joins|succeed|succeeds|succeeded|retire|retires|step|steps|will|has|have|is|are|was|were|as|from|the|and|currently';
  // Un-gluing a keyword off the end of a run of letters needs two narrow
  // rules. A rule broad enough to catch everything eats ordinary words and
  // surnames, and a mangled name or role kills the extraction downstream.
  //
  //   lowercase run ("advisesthat"): both halves must be keywords. A prefix
  //     that is merely letters turns "basis" into "bas is" (which then hides
  //     "on an interim basis") and "areas" into "are as". Requiring a prefix
  //     of four or more letters also protects "areas" (prefix "are").
  //   capitalised word ("Groupannounces", "Tavenerhas"): the prefix can be any
  //     capitalised word, but only keywords of six letters or more (plus
  //     "has") can coincide with the end of a surname. Without that limit:
  //     Harris -> "Harr is", Thomas -> "Thom as", Holland -> "Holl and",
  //     Blythe -> "Bly the", Goodwill -> "Good will".
  const GLUE_KW_PREFIX = BOARD_GLUE_LOWER_KW.split('|')
    .filter((w) => w.length >= 4).join('|');
  const GLUE_KW_CAP_SUFFIX = BOARD_GLUE_LOWER_KW.split('|')
    .filter((w) => w.length >= 6 || w === 'has').join('|');
  const HON_GLUE_RE = /\b(Mr|Mrs|Ms|Miss|Dr|Sir|Dame|Prof|Professor|Lord|Lady)\.?([A-Z][a-z])/g;

  function repairBoardGlue(text) {
    let t = String(text || '');
    t = t.replace(/\)([A-Za-z])/g, ') $1');
    t = t.replace(/([a-z]{2,})([.,;:])([A-Z])/g, '$1$2 $3');
    // honorific glued to a forename: "MrMark Tavener" -> "Mr Mark Tavener"
    t = t.replace(HON_GLUE_RE, '$1 $2');
    const kwAfterLower = new RegExp('\\b((?:' + GLUE_KW_PREFIX + '))((?:' + BOARD_GLUE_LOWER_KW + '))\\b', 'g');
    const kwAfterCap = new RegExp('\\b([A-Z][a-z]{2,})((?:' + GLUE_KW_CAP_SUFFIX + '))\\b', 'g');
    for (let i = 0; i < 2; i++) {
      t = t.replace(kwAfterLower, (m, pre, kw) => pre + ' ' + kw);
      t = t.replace(kwAfterCap, (m, pre, kw) => pre + ' ' + kw);
    }
    const kwBeforeCap = new RegExp('\\b(' + '(?:' + BOARD_GLUE_LOWER_KW + ')' + ')([A-Z][a-z])', 'g');
    t = t.replace(kwBeforeCap, (m, kw, up) => kw + ' ' + up);
    const nameGluedVerb = new RegExp('([A-Z][a-z]{2,})(joined|join|joins|informed|informs|steps|stepped|retires|retired|succeeds|succeeded)\\b', 'g');
    t = t.replace(nameGluedVerb, (m, name, verb) => name + ' ' + verb);
    t = t.replace(/[ \t]{2,}/g, ' ');
    return t;
  }

  // ── inline defined-term strip (BOARD) — removes ("CEO"), ('CFO') etc. ─────
  // Removes short quoted acronym/definitions that poison NAME->ROLE proximity.
  // Only strips PARENTHESISED short quoted terms; leaves prose intact.
  const RX_INLINE_DEFTERM = /\s*\(\s*(?:the\s+)?["'\u201C\u2018][^"'\u201D\u2019()]{1,30}["'\u201D\u2019]\s*\)/g;
  function stripInlineDefTerms(s) {
    return oneLine(String(s || '').replace(RX_INLINE_DEFTERM, ' '));
  }

  function splitOneLine(line) {
    let t = ' ' + String(line || '').replace(/\s+/g, ' ')
      .replace(/\s*[\u00B7\u2022\u2023\u25AA\u25E6]\s*/g, ' . ')
      + ' ';
    const guards = [
      /\bp\.m\./gi, /\ba\.m\./gi, /\bL\.P\./g, /\bInc\./g, /\bNo\./g, /\bp\.l\.c\./gi,
      /\bU\.S\./g, /\bU\.K\./g, /\bN\.A\./g, /\bS\.A\./g, /\bN\.V\./g, /\bA\.G\./g,
      /\bS\.à\s?r\.l\./gi, /\bS\.p\.A\./g, /\bA\/S\b/g,
      /\bRule\s+\d+\.\d+[a-z]?/gi, /\bAppendix\s+[IVX\d]+/gi, /\bSection\s+\d+/gi,
      /\bUS\$/g, /\b\d+\.\d+/g, /\bapprox\./gi, /\bLtd\./g, /\bCo\./g,
      /\b[A-Z]\.\s/g,
      /\bJan\.|Feb\.|Mar\.|Apr\.|Jun\.|Jul\.|Aug\.|Sep\.|Sept\.|Oct\.|Nov\.|Dec\./g
    ];
    const stash = [];
    guards.forEach((re) => {
      t = t.replace(re, (m) => { stash.push(m); return '\u0000' + (stash.length - 1) + '\u0001'; });
    });
    const parts = t.split(/(?<=[.;!?])\s+(?=[A-Z0-9\u00A3$\u20AC"'(])/);
    const restore = (s) => s.replace(/\u0000(\d+)\u0001/g, (m, i) => stash[+i] || '');
    return parts.map(restore).map((s) => s.trim()).filter(Boolean);
  }

  function splitSentences(text) {
    const lines = String(text || '').split('\n');
    let frags = [];
    for (const ln of lines) {
      const trimmed = ln.trim();
      if (!trimmed) continue;
      frags.push(...splitOneLine(trimmed));
    }
    const stitched = [];
    for (let i = 0; i < frags.length; i++) {
      const cur = frags[i];
      if (/:\s*$/.test(cur) && i + 1 < frags.length) {
        const joined = oneLine(cur.replace(/\s*:\s*$/, ' ') + frags[i + 1]);
        stitched.push(joined);
        i++;
      } else {
        stitched.push(cur);
      }
    }
    return stitched;
  }

  function cutAtFullStop(sentence) {
    let s = oneLine(sentence);
    const stash = [];
    const guards = [
      /\bp\.m\./gi, /\ba\.m\./gi, /\bL\.P\./g, /\bInc\./g, /\bNo\./g, /\bp\.l\.c\./gi,
      /\bU\.S\./g, /\bU\.K\./g, /\bN\.A\./g, /\bS\.A\./g, /\bN\.V\./g, /\bA\.G\./g,
      /\bS\.à\s?r\.l\./gi, /\bS\.p\.A\./g,
      /\bRule\s+\d+\.\d+[a-z]?/gi, /\bUS\$/g, /\b\d+\.\d+/g, /\bapprox\./gi, /\bLtd\./g, /\bCo\./g,
      /\b[A-Z]\.\s/g,
      /\bJan\.|Feb\.|Mar\.|Apr\.|Jun\.|Jul\.|Aug\.|Sep\.|Sept\.|Oct\.|Nov\.|Dec\./g
    ];
    guards.forEach((re) => {
      s = s.replace(re, (m) => { stash.push(m); return '\u0000' + (stash.length - 1) + '\u0001'; });
    });
    const m = s.match(/^[^.!?]*[.!?]/);
    if (m) s = m[0];
    s = s.replace(/\u0000(\d+)\u0001/g, (mm, i) => stash[+i] || '');
    return oneLine(s).replace(/\.\s*$/, '');
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RNS GATE (soft) — LSE RNS ONLY
  // ════════════════════════════════════════════════════════════════════════
  function isRns(fullText) {
    const t = String(fullText || '');
    if (/\bRNS\s+Number\s*:/i.test(t)) return true;
    if (/This information is provided by RNS/i.test(t)) return true;
    if (/\bRNS\b.*London Stock Exchange/i.test(t)) return true;
    // Non-standard wire layouts still allowed if clear board/deal signals exist.
    if (/\bRegulatory News Service\b/i.test(t)) return true;
    if (/\bPR ?Newswire\b/i.test(t) && /\bappoint/i.test(t)) return true;
    return false;
  }

  function hasTakeoverContext(fullText) {
    const t = String(fullText || '');
    return /\bTakeover Code\b/i.test(t) ||
           /\bRule\s*8\.3\b/i.test(t) ||
           /Opening Position Disclosure/i.test(t) ||
           /Dealing Disclosure/i.test(t) ||
           /the Panel\b/i.test(t) ||
           /offer period/i.test(t);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SCOPE
  // ════════════════════════════════════════════════════════════════════════
  function getBodyStart(text) {
    const lines = text.split('\n');
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^RNS\s+Number\s*:/i.test(lines[i].trim())) { start = i + 1; break; }
    }
    let body = lines.slice(start);

    const BOILER = [
      /^NOT FOR RELEASE/i,
      /^THIS ANNOUNCEMENT AND THE INFORMATION/i,
      /^NEITHER THIS ANNOUNCEMENT/i,
      /^THIS IS AN ANNOUNCEMENT/i,
      /^THIS ANNOUNCEMENT (IS|CONTAINS)/i,
      /^FOR IMMEDIATE RELEASE/i,
      /^THERE CAN BE NO CERTAINTY/i,
      /^This announcement is a re-release/i,
      /^Issued\s*:/i,
      /^MiFID II/i
    ];
    let lastBoiler = -1;
    const scan = Math.min(body.length, 60);
    for (let i = 0; i < scan; i++) {
      const t = body[i].trim();
      if (!t) continue;
      if (BOILER.some((re) => re.test(t))) lastBoiler = i;
    }
    if (lastBoiler >= 0) {
      let p = lastBoiler + 1;
      while (p < body.length && !body[p].trim()) p++;
      if (p < body.length && DATE_LINE.test(body[p].trim())) p++;
      while (p < body.length && !body[p].trim()) p++;
      body = body.slice(p);
    }

    const joined = body.join('\n').trim();
    return joined || text;
  }

  function windowWords(text, limit) {
    const cap = limit || WORD_WINDOW_BOARD;
    const body = getBodyStart(text);
    const lines = body.split('\n');
    const out = [];
    let count = 0;
    for (const ln of lines) {
      if (count >= cap) break;
      const words = ln.split(/\s+/).filter(Boolean);
      if (count + words.length <= cap) {
        out.push(ln);
        count += words.length;
      } else {
        const take = cap - count;
        out.push(words.slice(0, take).join(' '));
        count = cap;
        break;
      }
    }
    return out.join('\n');
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RAW HEADLINE RECOVERY
  // ════════════════════════════════════════════════════════════════════════
  function recoverHeadline(fullText) {
    const lines = String(fullText || '').split('\n').map((l) => l.trim()).filter(Boolean);

    for (const l of lines.slice(0, 12)) {
      const m = l.match(/^REG\s*-\s*.+?\s*-\s*(.+?)(?:\s+LSE\s*-\s*Regulatory News Service.*)?$/i);
      if (m && m[1]) {
        let h = oneLine(m[1]).replace(/\s+RNS Number.*$/i, '');
        if (h.length >= 6) return h;
      }
    }
    for (const l of lines.slice(0, 10)) {
      if (/\b(offer|acquisition|possible offer|recommended|bid|scheme|appoint|appointed|appoints|succeed|step down|response to)\b/i.test(l) &&
          l.split(' ').length >= 2 && l.split(' ').length <= 18 &&
          !/^RNS|^Released|^NOT FOR|^THIS ANNOUNCEMENT|^Issued/i.test(l)) {
        return oneLine(l).replace(/\s+Released\s+\d.*$/i, '').replace(/\s+RNS Number.*$/i, '');
      }
    }
    let started = false;
    for (const l of lines.slice(0, 40)) {
      if (/^RNS\s+Number\s*:/i.test(l)) { started = true; continue; }
      if (!started) continue;
      if (DATE_LINE.test(l)) continue;
      if (/^\(/.test(l)) continue;
      if (/^(NOT FOR|THIS |NEITHER|FOR IMMEDIATE|THERE CAN|Issued)/i.test(l)) continue;
      if (/plc|inc|ltd|n\.v\.|s\.a\.|a\.g\.|l\.p\.|group|holdings/i.test(l) && l.split(' ').length <= 5) continue;
      if (l.split(' ').length >= 3 && /[a-z]/.test(l)) return oneLine(l);
    }
    return '';
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SOURCE — FILER ONLY, with fallback for non-standard layouts.
  // ════════════════════════════════════════════════════════════════════════
  const CO_SUFFIX = /(?:p\.?l\.?c|plc|inc|ltd|limited|corp|corporation|co|company|group|holdings|management|capital|partners|l\.?p|llc|llp|s\.?à\s?r\.?l|s\.?a\.?s|s\.?a|s\.?p\.?a|n\.?v|b\.?v|gmbh|a\.?g|ag|se|ab|oyj|oy|a\/s|asa)\.?$/i;
  const CO_SUFFIX_ANY = /\b(?:p\.?l\.?c|plc|inc|ltd|limited|corp|corporation|group|holdings|s\.?a|n\.?v|gmbh|a\.?g|se)\b\.?/i;

  function looksLikeCompany(s) {
    const t = oneLine(s);
    if (!t || t.length < 2 || t.length > 70) return false;
    if (!/[A-Za-z\u00C0-\u024F]/.test(t)) return false;
    if (/[.]$/.test(t) && !CO_SUFFIX.test(t)) return false;
    if (/\b(announces?|reports?|statement|regarding|update|appoint(?:s|ed|ment)?|succeed|step down)\b/i.test(t) &&
        !/(p\.?l\.?c|plc|inc|ltd|limited|l\.?p|s\.?à\s?r\.?l|s\.?a|n\.?v|b\.?v|gmbh|a\.?g|group|holdings|management|capital|partners|corp)/i.test(t)) return false;
    return true;
  }

  function deriveSourceFromText(bodyText) {
    const lines = String(bodyText || '').split('\n').map((l) => l.trim());

    // Primary: the company line right after "RNS Number :".
    for (let i = 0; i < lines.length; i++) {
      if (/^RNS\s+Number\s*:/i.test(lines[i])) {
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const cand = lines[j];
          if (!cand) continue;
          if (DATE_LINE.test(cand)) continue;
          if (/^Issued\s*:/i.test(cand)) continue;
          if (/^(LSE|REG)\b/i.test(cand)) continue;
          if (/^RNS\s+Number\s*:/i.test(cand)) continue;
          if (/^(NOT FOR|THIS |NEITHER|FOR IMMEDIATE|THERE CAN)/i.test(cand)) continue;
          if (looksLikeCompany(cand)) return cand;
        }
        let sameLine = lines[i]
          .replace(/^RNS\s+Number\s*:\s*/i, '')
          .replace(/^\S+\s*/, '')
          .replace(new RegExp('\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(' + MONTHS + ')\\s+\\d{4}\\b.*$', 'i'), '')
          .trim();
        if (sameLine && looksLikeCompany(sameLine)) return sameLine;
      }
    }

    // Fallback A: "REG - <Company> - <headline>" line.
    for (const l of lines.slice(0, 12)) {
      const m = l.match(/^REG\s*-\s*(.+?)\s*-\s*/i);
      if (m && m[1] && looksLikeCompany(oneLine(m[1]))) return oneLine(m[1]);
    }

    // Fallback B: first line that contains a company suffix (Fermi / PRNewswire).
    for (const l of lines.slice(0, 25)) {
      if (!l) continue;
      const m = l.match(new RegExp('^([A-Z][A-Za-z0-9&.,\\-\'\\s]{1,60}?(?:' + CO_SUFFIX_ANY.source + '))'));
      if (m && looksLikeCompany(oneLine(m[1]))) return oneLine(m[1]).replace(/[,]+$/, '');
    }

    return '';
  }

  // ════════════════════════════════════════════════════════════════════════
  //  DEFINED SHORT-NAME (ALIAS) RESOLUTION
  // ════════════════════════════════════════════════════════════════════════
  function definedAliasFor(fullText, longName) {
    if (!longName) return '';
    const t = String(fullText || '');
    const cl = oneLine(longName).replace(/[.,;:]+$/, '');
    const esc = cl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(esc + '[^\\n]{0,120}?\\(\\s*(?:collectively\\s+)?(?:referred to as\\s+)?(?:the\\s+)?[\\u201C\\u2018"\']([A-Za-z][A-Za-z0-9&.\\- ]{1,40}?)[\\u201D\\u2019"\']', 'i'),
      /\(\s*collectively\s+referred to as\s+[\u201C\u2018"']([A-Za-z][A-Za-z0-9&.\- ]{1,40}?)[\u201D\u2019"']/i
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m && m[1]) {
        const alias = oneLine(m[1]).replace(/[.,;:]+$/, '');
        if (alias.length >= 2 && alias.length <= 40) return alias;
      }
    }
    return '';
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CLASSIFY
  // ════════════════════════════════════════════════════════════════════════
  function isActiveRule28(head) {
    if (/does not intend to make (?:a|an) offer/i.test(head)) return true;
    if (/no intention (?:of|to)\s+mak(?:e|ing)\s+(?:a|an) offer/i.test(head)) return true;
    if (/will not be making an offer/i.test(head)) return true;
    if (/statement regarding (?:a )?(?:non-|no )offer/i.test(head)) return true;

    const rule28Hits = head.match(/[^.]*\bRule\s*2\.8\b[^.]*\./gi) || [];
    for (const sent of rule28Hits) {
      const boilerplate =
        /will be treated as a statement to which/i.test(sent) ||
        /in which case the announcement/i.test(sent) ||
        /to which\s+Rule\s*2\.8\s+of the Code applies/i.test(sent);
      if (!boilerplate) return true;
    }
    return false;
  }

  function isResponseToOffer(head) {
    return /Response to possible offer/i.test(head) ||
           /notes the recent announcement by/i.test(head) ||
           (/\bthe Board of\b/i.test(head) && /possible (?:cash )?offer/i.test(head) &&
            /(is reviewing|is considering|received a[n]? .*proposal)/i.test(head));
  }

  function classify(fullText) {
    const head = fullText.slice(0, 9000);
    const has = (re) => re.test(head);

    if (isActiveRule28(head)) return 'RULE_28';
    if (isResponseToOffer(head)) return 'RESPONSE';

    const firm = [
      /firm intention to make an offer/i,
      /\bRule\s*2\.7\b/i,
      /recommended cash (acquisition|offer)/i,
      /recommended (?:all-share|share|final) (?:cash )?(?:acquisition|offer)/i
    ];
    if (firm.some(has)) return 'FIRM_OFFER';

    const possible = [
      /\bRule\s*2\.4\b/i,
      /possible\s+(?:all-share\s+|cash\s+|final\s+)?offer/i,
      /possible\s+(?:cash\s+)?acquisition/i,
      /(?:final|indicative)\s+(?:and\s+)?(?:conditional\s+)?proposal/i,
      /statement regarding a possible offer/i
    ];
    if (possible.some(has)) return 'POSSIBLE_OFFER';

    if (hasTakeoverContext(fullText)) {
      const liveOffer = [
        /firm intention to make an offer/i,
        /\bRule\s*2\.7\b/i,
        /\bfirm offer\b/i
      ];
      if (liveOffer.some(has)) return 'FIRM_OFFER';
    }

    const RQ = '(?:interim\\s+|acting\\s+)?';
    const ROLE_WORDS = '(?:chief executive(?: officer)?(?: designate)?|ceo(?:[\\s-]?designate)?|chief financial officer|cfo|finance director|executive chairman|chairman|chairperson|chairwoman|chair|senior independent director|non-executive director|executive director|company secretary|director)';
    const boardSignals = [
      /board (change|appointment|changes|composition)/i,
      /director(?:ate)? changes?/i,
      /leadership (?:transition|update|change)/i,
      /(?:chief executive|chief financial|ceo|cfo|chair)\b.*\b(?:succession|appointment|change)/i,
      new RegExp('(?:' + ROLE_WORDS + ')\\s+(?:designate|succession)', 'i'),
      new RegExp('appointment of\\s+.*' + RQ + ROLE_WORDS, 'i'),
      new RegExp('(?:has|have|is|are|will|was|were)\\s+(?:been\\s+)?appointed\\s+(?:as\\s+|to the board\\s+|an?\\s+|the\\s+)?' + RQ + ROLE_WORDS, 'i'),
      new RegExp('appointed\\s+[A-Z][a-z]+\\s+[A-Z][a-z]+', 'i'),
      new RegExp('\\bappointed\\s+' + RQ + ROLE_WORDS, 'i'),
      new RegExp('\\bappoints?\\s+.*' + ROLE_WORDS, 'i'),
      new RegExp('\\bappoints?\\s+' + RQ + ROLE_WORDS, 'i'),
      new RegExp('will take on the role of\\s+' + RQ + ROLE_WORDS, 'i'),
      new RegExp('(?:step up to|assume|take up)\\s+(?:the role of\\s+)?' + RQ + ROLE_WORDS, 'i'),
      new RegExp('(?:will\\s+)?succeeds?\\s+.*' + ROLE_WORDS, 'i'),
      /(?:will\s+)?step(?:s|ped|ping)?\s+down\s+(?:as|from the board|from (?:his|her) position)/i,
      new RegExp('(?:will\\s+)?retir(?:e|es|ing|ement)\\b.*(?:board|director|' + ROLE_WORDS + ')', 'i'),
      /\bsucceeds?\b.*(?:as|the)/i
    ];
    if (boardSignals.some(has)) return 'BOARD_CHANGE';

    return 'NONE';
  }

  function isIncreasedOffer(fullText) {
    const head = String(fullText || '').slice(0, 4000);
    return /\bincreased\b[\s\S]{0,40}?\boffer\b/i.test(head) ||
           /\b(?:revised|improved)\b[\s\S]{0,20}?\boffer\b/i.test(head);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SHARED HELPERS (deal)  — unchanged from v6.0
  // ════════════════════════════════════════════════════════════════════════
  const QUOTE_CLASS = '[\\u0022\\u0027\\u201C\\u201D\\u2018\\u2019]';
  const NON_QUOTE   = '[^\\u0022\\u0027\\u201C\\u201D\\u2018\\u2019]';
  const RX_DEFINED_QUOTED = new RegExp(
    '\\s*\\(\\s*(?:the|each)?\\s*' + QUOTE_CLASS + NON_QUOTE + '*' + QUOTE_CLASS + '\\s*\\)\\s*', 'gi');
  const RX_DEFINED_PLAIN = /\s*\(\s*(?:the\s+)?[A-Z][A-Za-z ]{2,40}?\s*\)\s*/g;
  const stripDefined = (s) => oneLine(String(s || '')
    .replace(RX_DEFINED_QUOTED, ' ')
    .replace(RX_DEFINED_PLAIN, ' '));

  function tidyTarget(t) {
    return oneLine(String(t || ''))
      .replace(/\b(ordinary|new|existing|issued|the|entire)\b/gi, '')
      .replace(/[,:;\-\u2013\u2014]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function dealTypeWord(text) {
    const t = String(text || '');
    if (/possible\s+(?:all-share\s+|cash\s+)?(?:offer|acquisition)/i.test(t)) return 'POSSIBLE OFFER';
    if (/increased\b[\s\S]{0,40}?offer/i.test(t)) return 'INCREASED OFFER';
    if (/recommended cash acquisition/i.test(t)) return 'RECOMMENDED CASH ACQUISITION';
    if (/recommended cash offer/i.test(t)) return 'RECOMMENDED CASH OFFER';
    if (/recommended (?:all-share|share) offer/i.test(t)) return 'RECOMMENDED ALL-SHARE OFFER';
    if (/voluntary public takeover offer/i.test(t)) return 'CASH OFFER';
    if (/all-share offer/i.test(t)) return 'ALL-SHARE OFFER';
    if (/cash acquisition/i.test(t)) return 'CASH ACQUISITION';
    if (/cash offer/i.test(t)) return 'CASH OFFER';
    if (/acquisition/i.test(t)) return 'ACQUISITION';
    if (/\boffer\b/i.test(t)) return 'OFFER';
    return 'OFFER';
  }

  const MONEY_GBP = /\u00A3\s?\d[\d,]*(?:\.\d+)?\s*(?:billion|million|bn|m)\b/i;
  const MONEY_ANY = /(?:\u00A3|US\$|\$|\u20AC)\s?\d[\d,]*(?:\.\d+)?\s*(?:billion|million|bn|m)\b/i;

  const TOTAL_BLOCK = /\benterprise value\b|\bfair value\b|\bcarrying value\b|\bnet assets?\b|\bgross assets?\b|\bgoodwill\b|\bEBITDA\b|\bpro forma\b|\bbook value\b|\brevenues?\b|\bturnover\b|\btotal liabilities\b|\bidentifiable\b|\bput options?\b|\bprior trades\b|\bimpairment|\bprofit before tax\b|\bnet debt\b|\bnet present value\b|\bmarket cap(?:italisation)?\b|per share\b|per\s+.*\bshare\b/i;

  const TOTAL_TIERS = [
    /\bimplies?\s+a\s+total\s+value\s+for\s+the\s+entire\b[^.]*?share\s+capital\b[^.]*?\bat\b/i,
    /\bvalues?\s+the\s+entire\s+(?:issued\s+)?(?:and\s+to\s+be\s+issued\s+)?(?:ordinary\s+)?share\s+capital\b[^.]*?\bat\b/i,
    /\btotal\s+value\s+for\s+the\s+(?:entire\s+)?(?:issued\s+)?(?:and\s+(?:expected\s+to\s+be|to\s+be)\s+issued,?\s+)?(?:ordinary\s+)?share\s+capital\b[^.]*?\bat\b/i,
    /\bvalues?\b[^.]*?\bshare\s+capital\b[^.]*?\bat\b/i,
    /\bimplies?\s+(?:a|an)\s+(?:equity\s+)?valu(?:e|ation)\b[^.]*?(?:issued|share\s+capital)[^.]*?\b(?:of|at)\b/i,
    /\b(?:aggregate|total)\s+consideration\b[^.]*?\b(?:of|in the amount of)\b/i
  ];

  function moneyAfterAt(s) {
    const idx = s.search(/\bat\b/i);
    if (idx >= 0) {
      const tail = s.slice(idx);
      const g = tail.match(MONEY_GBP); if (g) return oneLine(g[0]);
      const a = tail.match(MONEY_ANY); if (a) return oneLine(a[0]);
    }
    const g2 = s.match(MONEY_GBP); if (g2) return oneLine(g2[0]);
    const a2 = s.match(MONEY_ANY); return a2 ? oneLine(a2[0]) : '';
  }

  function totalTargetFrom(s) {
    let tm = s.match(/\bshare\s+capital\s+of\s+([A-Z][A-Za-z0-9&.\-]*(?:\s+[A-Z][A-Za-z0-9&.\-]*){0,2})/);
    if (!tm) tm = s.match(/\bfor\s+the\s+entire[^.]*?\bof\s+([A-Z][A-Za-z0-9&.\-]*(?:\s+[A-Z][A-Za-z0-9&.\-]*){0,2})/);
    if (!tm) tm = s.match(/\bof\s+([A-Z][A-Za-z0-9&.\-]*(?:\s+[A-Z][A-Za-z0-9&.\-]*)?)(?:'s)?\s+(?:entire|issued|ordinary|share capital)/);
    return tm ? tidyTarget(tm[1] || '') : '';
  }

  function totalValueFromBody(sentences) {
    for (const tier of TOTAL_TIERS) {
      for (const raw of sentences) {
        const s = stripDefined(raw);
        if (TOTAL_BLOCK.test(s)) continue;
        if (!tier.test(s)) continue;
        if (!MONEY_ANY.test(s)) continue;
        const money = moneyAfterAt(s);
        if (!money) continue;
        return { money, target: totalTargetFrom(s), raw: s };
      }
    }
    return null;
  }

  function dealHeadlineFields(headline, fullText) {
    const h = oneLine(headline);
    const ctx = (fullText || '').slice(0, 4500);
    if (!h && !ctx) return null;

    let target = '', bidder = '';

    let bm = ctx.match(/\boffer\s+by\s+([A-Za-z0-9&.\-' ]+?)\s+for\s+(?:the\s+)?(?:entire\s+)?(?:issued\s+)?(?:and to be issued\s+)?(?:ordinary\s+)?share\s+capital\s+of\s+([A-Za-z0-9&.\-' ]+?)(?:\s*[\(,.]|\s+to be|\n|$)/i);
    if (bm) { bidder = tidyTarget(bm[1]); target = tidyTarget(bm[2]); }

    if (!target || !bidder) {
      const stack = ctx.match(/\bOFFER\b[\s\S]{0,40}?\bby\b\s+([A-Z][A-Za-z0-9&.\-' ]+?(?:PLC|LIMITED|LTD|GROUP|HOLDINGS|INC|L\.P\.)?)[\s\S]{0,40}?\bfor\b\s+([A-Z][A-Za-z0-9&.\-' ]+?(?:PLC|LIMITED|LTD|GROUP|HOLDINGS|INC)?)\b/i);
      if (stack) {
        if (!bidder) bidder = tidyTarget(stack[1]);
        if (!target) target = tidyTarget(stack[2]);
      }
    }

    if (!target || !bidder) {
      const am = ctx.match(/\b(?:ACQUISITION|OFFER)\s+of\s+([A-Za-z0-9&.\-' ]+?)\s+by\s+([A-Za-z0-9&.\-' ]+?)(?:\s*\(|\s+to be implemented|\n|$)/i);
      if (am) { if (!target) target = tidyTarget(am[1]); if (!bidder) bidder = tidyTarget(am[2]); }
    }

    if (!target || !bidder) {
      const acq = ctx.match(/offer\s+to\s+acquire\b[^.]*?\bof\s+([A-Z][A-Za-z0-9&.\-']+)[^.]*?\bnot already owned by\s+([A-Z][A-Za-z0-9&.\-' ]+?)(?:\s*[\(,.]|\n|$)/i);
      if (acq) { if (!target) target = tidyTarget(acq[1]); if (!bidder) bidder = tidyTarget(acq[2]); }
    }

    if (!target) {
      let tm = ctx.match(/\b(?:final|possible|recommended|cash)?\s*offer\s+for\s+([A-Z][A-Za-z0-9&.\-' ]+?)(?:\s*\(|\s+plc|\n|,|\.|$)/i);
      if (!tm) tm = ctx.match(/to acquire[^.]*?\bof\s+([A-Z][A-Za-z0-9&.\-' ]+?)(?:\s*\(|\s+the\b|\n|,|\.|$)/i);
      if (tm) target = tidyTarget(tm[1]);
    }

    if (!target || !bidder) {
      let m = h.match(/\b(?:acquisition|offer)\s+(?:of|for)\s+([A-Za-z0-9&.\-' ]+?)\s+by\s+([A-Za-z0-9&.\-' ]+?)(?:$|[,(])/i);
      if (m) { if (!target) target = tidyTarget(m[1]); if (!bidder) bidder = tidyTarget(m[2]); }
    }
    if (!target) { const m = h.match(/\b(?:acquisition|offer)\s+(?:of|for)\s+([A-Za-z0-9&.\-' ]+?)(?:$|[,(:])/i); if (m) target = tidyTarget(m[1]); }
    if (!bidder) { const m = h.match(/\bby\s+([A-Za-z0-9&.\-' ]+?)(?:$|[,(])/i); if (m) bidder = tidyTarget(m[1]); }
    if (!target && !bidder) return null;

    target = target.replace(/\s*\(.*$/, '').replace(/\bplc\b\.?/i, '').replace(/\bgroup\b/i, '').trim();
    bidder = bidder.replace(/\s*\(.*$/, '').replace(/\bplc\b\.?/i, '').replace(/\bgroup\b/i, '').trim();

    const bidderAlias = definedAliasFor(fullText || '', bidder);
    if (bidderAlias) bidder = bidderAlias;
    const targetAlias = definedAliasFor(fullText || '', target);
    if (targetAlias) target = targetAlias;

    const type = dealTypeWord(h + ' ' + ctx);
    const structure = /scheme of arrangement/i.test(ctx) ? 'SCHEME'
                    : /contractual offer|part 28|takeover offer|voluntary public takeover/i.test(ctx) ? 'OFFER'
                    : '';
    return { target, bidder, type, structure };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RULE 2.8
  // ════════════════════════════════════════════════════════════════════════
  function extractRule28(headline, fullText) {
    const ctx = (fullText || '').slice(0, 4000);
    const out = [];
    const status = { rule28: null };

    const dh = dealHeadlineFields(headline, fullText) || {};
    const noIntend = /does not intend to make (?:a|an) offer|will not be making an offer|no intention (?:of|to)\s+mak/i.test(ctx);

    let body = '';
    if (noIntend && dh.bidder) {
      body = dh.bidder.toUpperCase() + ' DOES NOT INTEND TO MAKE OFFER'
           + (dh.target ? ' FOR ' + dh.target.toUpperCase() : '');
    } else if (noIntend && dh.target) {
      body = 'DOES NOT INTEND TO MAKE OFFER FOR ' + dh.target.toUpperCase();
    } else if (noIntend) {
      body = 'DOES NOT INTEND TO MAKE OFFER';
    }

    if (body) {
      out.push({ body, slot: 'rule28', preformatted: true });
      status.rule28 = { state: 'emitted' };
    } else {
      status.rule28 = { state: 'skipped', reason: 'No active walk-away statement found.' };
    }
    return { out, status };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE
  // ════════════════════════════════════════════════════════════════════════
  const BACKGROUND_MARKERS = /\b(previous|previously|earlier|prior|follows|following|third|second|first|initial)\b|\bwere\s+rejected\b|\brejected\s+on\s+\d|\bhad\s+(?:been\s+)?rejected\b|\bwhich\s+(?:the\s+)?Board[^.]*rejected\b|£\s?\d[\d,.]*\s*(?:,|and)\s*£/i;

  function extractResponse(sentences, headline, fullText) {
    const out = [];
    const status = { response: null };
    const dh = dealHeadlineFields(headline, fullText) || {};
    const bidder = (dh.bidder || '').toUpperCase();

    let decision = '';

    for (const raw of sentences) {
      const s = oneLine(raw);
      if (s.length < 15) continue;

      if (/\b(?:is|are)\s+(?:currently\s+)?(?:reviewing|considering|evaluating)\b/i.test(s) &&
          /\b(?:the\s+)?(?:final\s+)?(?:proposal|offer)\b/i.test(s)) {
        decision = 'REVIEWING';
        break;
      }

      if (/\b(?:rejects?|is rejecting|has rejected|Board[^.]*reject(?:s|ed)?)\b/i.test(s) &&
          /\b(?:the\s+|this\s+)(?:final\s+)?(?:proposal|offer)\b/i.test(s) &&
          !BACKGROUND_MARKERS.test(s)) {
        decision = 'REJECTS';
      }
    }

    let body = '';
    if (decision === 'REVIEWING') {
      body = 'BOARD REVIEWING POSSIBLE OFFER' + (bidder ? ' FROM ' + bidder : '');
    } else if (decision === 'REJECTS') {
      body = 'BOARD REJECTS POSSIBLE OFFER' + (bidder ? ' FROM ' + bidder : '');
    }

    if (body) {
      out.push({ body, slot: 'response', preformatted: true });
      status.response = { state: 'emitted' };
    } else {
      status.response = { state: 'skipped', reason: 'No present-tense reviewing/rejection of the current proposal found (background ignored).' };
    }
    return { out, status };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  BOARD — v6.1
  // ════════════════════════════════════════════════════════════════════════
  const HON = '(?:Mr|Mrs|Ms|Miss|Dr|Sir|Dame|Prof|Professor|Lord|Lady)\\.?';
  // "(Stephen)" is a parenthesised western nickname sitting inside a name:
  // "Mr Tat Cheung (Stephen) Wong". It is a name token so the run is not cut
  // short, and validName drops it again. "(CFO)" cannot match — the token
  // needs a lower-case letter after the capital.
  const NICK_TOKEN = '\\((?:[A-Z][a-z]+)\\)';
  const NAME_TOKEN = "(?:[A-Z][a-z\\u00C0-\\u024F][a-zA-Z\\u2018\\u2019'\\u00C0-\\u024F\\-]*|" + NICK_TOKEN + "|[A-Z]\\.|II|III|IV|Jr\\.?|Sr\\.?)";
  const NAME = '(?:' + HON + '\\s+)?' + NAME_TOKEN + '(?:\\s+' + NAME_TOKEN + '){1,4}';

  const STOP_WORDS = new Set([
    'the','a','an','and','or','of','as','to','from','in','on','at','by','for','with',
    'that','this','which','who','whom','whose','when','where','while','he','she','they',
    'his','her','their','him','them','it','its','we','our','us','i','you','your',
    'board','company','committee','nomination','remuneration','bidco','topco','midco',
    'prior','following','other','serving','joined','join','before','after','having','previously',
    'currently','recently','also','more','operational','role','step','steps','stepped','stepping',
    'down','up','new','permanent','interim','acting','chief','executive','financial','officer',
    'director','chairman','chair','chairperson','chairwoman','secretary','finance','senior','independent',
    'non','will','shall','would','should','may','might','can','could','has','have','had','is','are',
    'was','were','been','be','being','announces','announced','advises','advise','informed','informs',
    'inform','appointed','appoint','appoints','appointment','succeed','succeeds','succeeded','retire',
    'retires','retiring','retirement','ceo','cfo','plc','ltd','limited','inc','llc','llp','designate',
    'reg','lse','rns','end','ends','pursuant','effective','said','says','say','pleased','delighted',
    'today','announcement','statement','update','change','changes','succession','transition','leadership',
    'ceo-designate','managing','assume','assumes','group'
  ]);

  const HON_RE = new RegExp('^(?:' + HON + ')\\s+', 'i');
  const SUFFIX_RE = /^(?:II|III|IV|Jr\.?|Sr\.?)$/i;

  // Stop words that are also real personal names. In the source text a verb or
  // function word is lower case and a forename is capitalised, so case tells
  // the two apart — "Will Truman" is a CEO, "will" is an auxiliary. The
  // pattern lists run case-insensitively and lose that distinction, but the
  // captured substring keeps the original case, so validName can still use it.
  const NAMEABLE_STOPS = new Set(['will', 'may', 'more', 'can', 'art', 'grace', 'june']);
  const HON_TOKEN_RE = new RegExp('^(?:' + HON + ')$', 'i');
  const NICK_RE = /^\((?:[A-Z][a-z]+)\)$/;

  function isStopToken(tok) {
    const low = tok.replace(/[.'‘’\-]/g, '').toLowerCase();
    if (!STOP_WORDS.has(low)) return false;
    // A capitalised nameable stop word is a forename, not glue.
    return !(NAMEABLE_STOPS.has(low) && /^[A-Z]/.test(tok));
  }

  // A token that can never be part of a name: a role/verb/function word, an
  // honorific, or anything not capitalised (initials, generational suffixes
  // and parenthesised nicknames excepted).
  function isNameEdgeJunk(tok) {
    if (NICK_RE.test(tok)) return false;
    if (HON_TOKEN_RE.test(tok)) return true;
    if (isStopToken(tok)) return true;
    if (/^[A-Z]\.$/.test(tok) || SUFFIX_RE.test(tok)) return false;
    return !/^[A-Z]/.test(tok);
  }

  function validName(raw) {
    if (!raw) return '';
    let s = oneLine(String(raw)).replace(/[.,;:]+$/, '').trim();
    s = s.replace(HON_RE, '').trim();
    if (!s) return '';
    let tokens = s.split(/\s+/).filter(Boolean);
    // The pattern lists run case-insensitively, so NAME_TOKEN's "[A-Z]" also
    // matches lower case and a greedy NAME swallows the surrounding glue:
    // "Michael Holland will", "plc announces that Sarah Thomas",
    // "and Patricia Travis will", "that Mr Mark Tavener". Trim that glue off
    // both ends before validating; interior junk still rejects the whole match.
    while (tokens.length && isNameEdgeJunk(tokens[0])) tokens.shift();
    while (tokens.length && isNameEdgeJunk(tokens[tokens.length - 1])) tokens.pop();
    // "Mr Tat Cheung (Stephen) Wong" -> "Tat Cheung Wong"
    tokens = tokens.filter((tok) => !NICK_RE.test(tok));
    if (tokens.length < 2) return '';
    let realWordTokens = 0;
    for (const tok of tokens) {
      if (isStopToken(tok)) return '';
      if (/^[A-Z]\.$/.test(tok)) continue;
      if (SUFFIX_RE.test(tok)) continue;
      if (!/^[A-Z][a-zA-Z\u00C0-\u024F'\u2018\u2019\-]*$/.test(tok)) return '';
      if (tok.length > 4 && tok === tok.toUpperCase()) return '';
      realWordTokens++;
    }
    if (realWordTokens < 2) return '';
    return tokens.join(' ');
  }

  const QUAL = '((?:[Ii]nterim|[Aa]cting)\\s+)?';
  const ROLE = '(Chief Executive Officer Designate|Chief Executive Designate|CEO Designate|CEO-Designate|Chief Financial Officer Designate|CFO Designate|CFO-Designate|Chief Executive Officer|Chief Executive|CEO|Chief Financial Officer|Chief Finance Officer|CFO|Group Finance Director|Finance Director|Executive Chairman|Independent Non-Executive Chairman|Independent Non-Executive Chair|Non-Executive Chairman|Non-Executive Chair|Chairman|Chairperson|Chairwoman|Chair|Senior Independent Director|Independent Non-Executive Director|Non-Executive Director|Executive Director|Company Secretary|Director)';

  // Determiner run between "as"/"appointed" and the role itself:
  //   "as CFO", "as the new CFO", "as the company's new CFO",
  //   "as its permanent Group CEO", "as our incoming Chief Financial Officer"
  const DET = "(?:(?:an?|the|its|our|their)\\s+)?" +
              "(?:[A-Za-z][A-Za-z\\-]*['\\u2019]s\\s+)?" +
              "(?:(?:new|permanent|incoming|independent|substantive)\\s+)?" +
              "(?:Group\\s+)?";

  // Appositive lead-ins: "NAME, currently ROLE," / "NAME, the current ROLE,"
  const APPOS = "(?:currently\\s+|the current\\s+|current\\s+|the Company['\\u2019]s\\s+|our\\s+|its\\s+)?";

  // \u2500\u2500 ROLE SCOPE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // What follows a role can narrow it to something that is not the filer:
  //   "CEO of Rank Interactive", "Chief Executive Officer - Canada"   (divisional)
  //   "Chairman of the Audit and Risk Committee"                      (committee)
  // Those are not group-level board changes and are not snapped. These are:
  //   "CEO of Domino's", "Chief Executive Officer of Santander UK plc" (the filer)
  //   "Chief Financial Officer of the Company", "Chairman of the Board"
  //
  // The old test was a regex that treated ANY capitalised word after "of" as a
  // division, which threw away the filer's own name. It also ran under /i,
  // where "of" matches the "Of" inside "Officer" and every plain
  // "Chief Executive Officer" was read as divisional.

  // Words that never distinguish one entity from another.
  const GENERIC_ENTITY_WORD = new Set([
    'the', 'a', 'an', 'and', 'of', 'for', 'plc', 'ltd', 'limited', 'inc', 'corp',
    'corporation', 'co', 'company', 'companies', 'group', 'holding', 'holdings',
    'llc', 'llp', 'lp', 'sa', 'sas', 'nv', 'bv', 'gmbh', 'ag', 'se', 'ab', 'asa',
    'oyj', 'oy', 'board', 'business', 'businesses', 'organisation', 'organization'
  ]);

  const entityWord = (tok) => String(tok)
    .replace(/[\u2018\u2019']s\b/i, '')
    .replace(/[^A-Za-z0-9&]/g, '')
    .toLowerCase();

  // Distinctive words identifying the filer: its name, plus the short names it
  // defines for itself, which by RNS convention sit in parentheses beside the
  // long name \u2014 ("Domino's" or "DPG"), ("Seascape Energy", the "Company").
  // Only parenthesised terms count, so a quoted divisional title elsewhere in
  // the release ('Chief Executive Officer - Canada') is not mistaken for one.
  function filerIdentity(fullText, source) {
    const tokens = new Set();
    const add = (s) => oneLine(s).split(/[\s\/]+/).forEach((tok) => {
      const w = entityWord(tok);
      if (w && w.length > 1 && !GENERIC_ENTITY_WORD.has(w)) tokens.add(w);
    });
    add(source || '');
    const head = String(fullText || '').slice(0, 3000);
    for (const paren of head.match(/\([^)]{0,200}\)/g) || []) {
      const quoted = paren.match(/["\u201c\u2018']\s*(?:the\s+)?([A-Za-z][A-Za-z0-9&.'\u2019\- ]{0,30}?)\s*["\u201d\u2019']/g) || [];
      for (const q of quoted) add(q.replace(/["\u201c\u2018\u201d\u2019']/g, ' '));
    }
    return tokens;
  }

  const COMMITTEE_RE = /^\s*(?:of|for)\s+(?:the\s+)?(?:[A-Z][A-Za-z&]*\s+|and\s+)*Committee\b/;

  // The entity named immediately after a role, as a list of distinctive words.
  // Returns [] when nothing nameable follows (ordinary prose, or a date).
  function entityAfterRole(tail) {
    const m = tail.match(/^\s*(?:\bof\b|\bfor\b|[-\u2013\u2014,])\s*(.*)$/);
    if (!m) return null;
    const out = [];
    for (const raw of m[1].split(/\s+/)) {
      const bare = raw.replace(/^["'\u201c\u2018(]+/, '');
      const w = entityWord(bare);
      if (!w) break;
      const generic = GENERIC_ENTITY_WORD.has(w);
      // Lower-case prose ("having served as", "who will join") is not a name.
      if (!generic && !/^[A-Z0-9]/.test(bare)) break;
      if (!generic) out.push(w);
      if (/[.,;:)'\u2019]$/.test(raw)) break;
      if (out.length >= 6) break;
    }
    return out;
  }

  function roleScopeIsForeign(sentence, afterRoleIndex, filerTokens) {
    const tail = String(sentence).slice(afterRoleIndex, afterRoleIndex + 140);
    if (COMMITTEE_RE.test(tail)) return true;
    const ent = entityAfterRole(tail);
    if (!ent || !ent.length) return false;   // nothing named -> group level
    return !ent.every((w) => filerTokens.has(w));
  }

  const BAD_STARTS = /^(the|board|company|committee|nomination|group|bidco|topco|prior|following|other|serving|joined|before|having|previously|that|when|more|as|and)\b/i;

  function normQual(q) {
    if (!q) return '';
    if (/interim/i.test(q)) return 'INTERIM ';
    if (/acting/i.test(q)) return 'ACTING ';
    return '';
  }

  function normRole(r) {
    if (!r) return '';
    const t = oneLine(r);
    if (/chief executive officer designate|chief executive designate|ceo[\s-]?designate/i.test(t)) return 'CEO DESIGNATE';
    if (/chief financial officer designate|cfo[\s-]?designate/i.test(t)) return 'CFO DESIGNATE';
    if (/chief executive officer|chief executive|^ceo$/i.test(t)) return 'CEO';
    if (/chief financial officer|chief finance officer|^cfo$/i.test(t)) return 'CFO';
    if (/group finance director|finance director/i.test(t)) return 'FINANCE DIRECTOR';
    if (/non-executive chairman/i.test(t)) return 'NON-EXECUTIVE CHAIRMAN';
    if (/non-executive chair$/i.test(t)) return 'NON-EXECUTIVE CHAIR';
    if (/executive chairman/i.test(t)) return 'EXECUTIVE CHAIRMAN';
    if (/chairman|chairperson|chairwoman|^chair$/i.test(t)) return 'CHAIR';
    if (/senior independent director/i.test(t)) return 'SENIOR INDEPENDENT DIRECTOR';
    if (/independent non-executive director/i.test(t)) return 'NON-EXECUTIVE DIRECTOR';
    if (/non-executive director/i.test(t)) return 'NON-EXECUTIVE DIRECTOR';
    if (/executive director/i.test(t)) return 'EXECUTIVE DIRECTOR';
    if (/company secretary/i.test(t)) return 'COMPANY SECRETARY';
    if (/director/i.test(t)) return 'DIRECTOR';
    return t.toUpperCase();
  }

  // Effective dates are deliberately NOT emitted. A sentence routinely holds
  // more than one date and no reliable way to tell which one governs which
  // event: "will step down as CFO ... at the AGM on 11 June 2026" put the AGM
  // date on the departure, and "X steps down on 30 June and Y takes up the
  // role" put one date on both snaps. Tense ("WILL STEP DOWN" vs "STEPS DOWN")
  // carries the timing instead.

  const BACKGROUND_ONLY = /\bprior to being appointed\b|\bbefore joining\b|\bhaving served as\b|\bwhere (?:he|she) (?:held|was|served)\b|\b(?:he|she) joined\b.*\bfrom\b/i;
  const ACTIVE_APP_VERB = /\bappointment of\b|\bappointed\b|\bappoints?\b|\bwill take on the role\b|\bwill join\b.*\bas\b|\bstep up to\b|\bassume\b|\btake up\b|\bwill succeed\b|\bwill be succeeded\b/i;
  const ACTIVE_LEAVE_VERB = /\bstep(?:s|ped|ping)?\s+down\b|\bwill step down\b|\bretir(?:e|es|ing|ement)\b|\bwill retire\b|\bintention to retire\b|\bintends to retire\b|\bsucceeding\b|\bwill be succeeded by\b/i;

  function isPureBackground(s) {
    if (!BACKGROUND_ONLY.test(s)) return false;
    if (ACTIVE_APP_VERB.test(s) || ACTIVE_LEAVE_VERB.test(s)) {
      if (/\bprior to being appointed\b/i.test(s) && !/\bappointment of\b|\bappoints?\b|\bwill (?:be appointed|take on|join)\b/i.test(s)) {
        return true;
      }
      return false;
    }
    return true;
  }

  function isPermanentNow(s) {
    if (/\bas\s+permanent\b/i.test(s)) return true;
    if (/\bon a permanent basis\b/i.test(s)) return true;
    if (/\bwith immediate effect\b/i.test(s) && !/\binterim|acting\b/i.test(s.replace(/currently\s+interim/i, ''))) return true;
    return false;
  }

  // "appointed as Chief Finance Officer on an interim basis" — the qualifier
  // trails the role instead of preceding it, so QUAL cannot capture it.
  const TRAILING_INTERIM = /\bon an interim basis\b|\bin an interim capacity\b|\bon an acting basis\b/i;

  // ── Appointment patterns (matchAll-capable) ──────────────────────────
  const RX_APP_LIST = [
    { re: new RegExp('appointment of\\s+(' + NAME + ')(?:,[^,]{0,80},)?\\s+as\\s+' + DET + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    { re: new RegExp('\\bappointed\\s+(' + NAME + ')\\s+(?:to the Board\\s+)?as\\s+' + DET + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    { re: new RegExp('(' + NAME + ')\\s+(?:has|have|is|are|will be|will|was|were)\\s+(?:been\\s+)?appointed\\s+(?:to the Board\\s+)?(?:as\\s+)?' + DET + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    { re: new RegExp('(' + NAME + ')(?:,[^,]{0,80},)?\\s+will take on the (?:newly created )?role of\\s+' + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    // step up to / assume / take up the role of  (Chair changes) — APPOINTMENT
    { re: new RegExp('(' + NAME + ')(?:,[^,]{0,80},)?\\s+(?:will\\s+)?(?:step up to|assume(?: the role of)?|take up(?: the role of)?)\\s+(?:the\\s+)?' + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    // X will succeed Y as ROLE  -> X appointed (departure handled separately)
    { re: new RegExp('(' + NAME + ')\\s+will succeed\\s+' + NAME + '\\s+as\\s+(?:the\\s+)?' + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    { re: new RegExp('(' + NAME + ')(?:,[^,]{0,80},)?\\s+(?:will be|is to be|is)\\s+appointed\\s+(?:\\w+\\s+)?' + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    { re: new RegExp('\\bappoints?\\s+(' + NAME + ')\\s+(?:as\\s+)?' + DET + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    // bare participle, no auxiliary: "with Mr Joe Rinarelli appointed as the
    // Company's new Chief Financial Officer"
    { re: new RegExp('(' + NAME + ')\\s+appointed\\s+(?:as\\s+)?' + DET + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    // "appointed X to the role of ROLE"
    { re: new RegExp('\\bappoint(?:s|ed)?\\s+(' + NAME + ')\\s+to\\s+(?:the\\s+)?(?:new\\s+|newly created\\s+)?(?:role|position)\\s+of\\s+' + DET + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    // "X will join the Board / the Company / us as ROLE"
    { re: new RegExp('(' + NAME + ')(?:,[^,]{0,80},)?\\s+will join\\s+[^,.;]{0,60}?\\bas\\s+' + DET + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    // role first, then the person: "appoint Deputy CFO, Daniel Peacock, as
    // interim Chief Financial Officer"
    { re: new RegExp('\\bappoint(?:s|ed)?\\s+[^,.;]{0,60},\\s+(' + NAME + '),\\s+as\\s+' + DET + QUAL + ROLE, 'gi'), n:1, q:2, r:3 },
    // appositive: NAME, [currently/the current/the Company's] ROLE, <appoint verb>
    { re: new RegExp('(' + NAME + '),\\s+' + APPOS + QUAL + ROLE + ',\\s+(?:will be|is to be|has been)\\s+appointed\\s+(?:as\\s+)?' + DET + QUAL + ROLE, 'gi'), n:1, q:4, r:5 },
    { re: new RegExp('(?:current\\s+)?' + ROLE + '[^,]{0,5},?\\s+(' + NAME + '),?\\s+(?:will be|is to be|has been|is)\\s+appointed\\s+(?:the\\s+)?' + QUAL + ROLE, 'gi'), n:2, q:3, r:4 }
  ];

  // Appointments that state no role at all — "the appointment of Andrew Smith
  // to the board". The role comes from the release title instead.
  const RX_APP_ROLELESS = [
    new RegExp('appointment of\\s+(' + NAME + ')\\s+to\\s+the\\s+board\\b', 'gi'),
    new RegExp('\\bappoint(?:s|ed)?\\s+(' + NAME + ')\\s+to\\s+the\\s+board\\b', 'gi'),
    new RegExp('(' + NAME + ')\\s+(?:has|have|is|are|will be|will|was|were)\\s+(?:been\\s+)?appointed\\s+to\\s+the\\s+board\\b', 'gi')
  ];

  // The role named in the release title, used only to fill a roleless
  // appointment: "Appointment of Chief Financial Officer" -> CFO.
  const RX_HEADLINE_ROLE = new RegExp('(?:appointment|appoints?|new)\\b[^.]{0,40}?' + QUAL + ROLE, 'i');

  function headlineRole(headline) {
    const h = oneLine(headline || '');
    if (!h) return '';
    const m = h.match(RX_HEADLINE_ROLE);
    if (!m) return '';
    const role = normRole(m[2]);
    if (!role) return '';
    return (normQual(m[1]) + role).trim();
  }

  // ── Departure patterns (matchAll-capable) ────────────────────────────
  const RX_DEP_LIST = [
    { re: new RegExp('(' + NAME + ')(?:,[^,]{0,60},)?\\s+(will|has decided to|intends to|is to|is|to)?\\s*step(?:s|ped|ping)?\\s+down\\s+as\\s+(?:the\\s+)?' + QUAL + ROLE, 'gi'), n:1, tense:2, q:3, r:4, kind:'stepdown' },
    { re: new RegExp('(' + NAME + ')(?:,[^,]{0,60},)?\\s+(will|has|intends to|is to|is|to)?\\s*(?:informed the Board of (?:his|her) intention to\\s+)?step(?:s|ped|ping)?\\s+down\\s+from\\s+(?:his|her|the)\\s+(?:current\\s+)?(?:position|role)\\s+as\\s+(?:Group\\s+)?' + QUAL + ROLE, 'gi'), n:1, tense:2, q:3, r:4, kind:'stepdown' },
    { re: new RegExp('(' + NAME + ')(?:,[^,]{0,60},)?\\s+(will|has decided to|intends to|is to|is|to)?\\s*step(?:s|ped|ping)?\\s+down\\s+from\\s+the\\s+Board', 'gi'), n:1, tense:2, q:null, r:null, kind:'board' },
    { re: new RegExp('(' + NAME + ')(?:,[^,]{0,60},)?\\s+(will|intends to|is to|is|to|has informed the Board of (?:his|her) intention to)?\\s*retir(?:e|es|ing)\\s+(?:as\\s+(?:the\\s+)?' + QUAL + ROLE + '|from\\s+the\\s+(?:Group|Board))', 'gi'), n:1, tense:2, q:3, r:4, kind:'retire' },
    // succeeding Y  -> Y departs (role inherited later from the appointment)
    { re: new RegExp('succeeding\\s+(' + NAME + ')', 'gi'), n:1, tense:null, q:null, r:null, kind:'succeeded' },
    // X will be succeeded by Z  -> X departs
    { re: new RegExp('(' + NAME + ')\\s+will be succeeded by\\s+' + NAME, 'gi'), n:1, tense:null, q:null, r:null, kind:'succeeded' },
    // Y as ROLE, succeeding Z  handled by succeeding pattern; role inherit below.
    // "X will succeed Y as ROLE" -> Y departs AS ROLE (role captured here)
    { re: new RegExp(NAME + '\\s+will succeed\\s+(' + NAME + ')\\s+as\\s+(?:the\\s+)?' + QUAL + ROLE, 'gi'), n:1, tense:null, q:2, r:3, kind:'succeeded_role' },
    // "the retirement of Jon Bridel from the Board"
    { re: new RegExp('\\bretirement of\\s+(' + NAME + ')\\s+from\\s+(?:the\\s+)?(?:Board|Group|Company)\\b', 'gi'), n:1, tense:null, q:null, r:null, kind:'retire' },
    // role stated before the person, and a bare "has" as the tense:
    // "its Executive Chairman, James Menzies, has stepped down from the board"
    { re: new RegExp('(?:current\\s+)?' + QUAL + ROLE + ',\\s+(' + NAME + '),\\s+(will|has|have|had|is|is to|intends to)?\\s*(?:been\\s+)?step(?:s|ped|ping)?\\s+down\\b', 'gi'), n:3, tense:4, q:1, r:2, kind:'stepdown' },
    // "Anne Costain, Chief Financial Officer, is leaving the organisation"
    { re: new RegExp('(' + NAME + '),\\s+' + APPOS + QUAL + ROLE + ',\\s+(will be|will|is|has|had)?\\s*(?:leav(?:es|ing|e)|depart(?:s|ing|ed)?)\\b', 'gi'), n:1, tense:4, q:2, r:3, kind:'stepdown' },
    // "X will leave the Group" / "X is leaving the Company" — the named entity
    // keeps this from firing on prose like "Mark leaves Glanbia on a firm footing".
    { re: new RegExp('(' + NAME + ')\\s+(will|is|has)?\\s*(?:leav(?:es|ing|e))\\s+(?:the\\s+)?(?:Group|Company|Board|business|organisation|organization)\\b', 'gi'), n:1, tense:2, q:null, r:null, kind:'board' },
    // "X has informed the Board that ... and step down from the Board" — the
    // name sits a long way from the verb, so the idiom is matched explicitly
    // rather than by relaxing the adjacency of the pattern above.
    { re: new RegExp('(' + NAME + ')\\s+(?:has|have|had)\\s+informed the Board[^.;]{0,160}?\\bstep(?:s|ped|ping)?\\s+down\\s+from\\s+the\\s+Board\\b', 'gi'), n:1, tense:null, q:null, r:null, kind:'board', future:true }
  ];

  function tenseVerb(tenseRaw, base, sentence, forceFuture) {
    const tr = String(tenseRaw || '').toLowerCase();
    const future = !!forceFuture ||
                   /\bwill\b|\bintends? to\b|\bis to\b|\bto\b|\bhas decided to\b|\bintention to\b/.test(tr) ||
                   /\bwill\b\s+(?:step|retire)|\bintention to\b|\bintends to\b|\bis to\b/i.test(sentence);
    if (base === 'STEP DOWN') return future ? 'WILL STEP DOWN' : 'STEPS DOWN';
    if (base === 'RETIRE')    return future ? 'WILL RETIRE'    : 'RETIRES';
    return future ? ('WILL ' + base) : base;
  }

  // A departure that names no role sometimes states it later in the same
  // sentence: "Mark Garvey will retire from the Group following thirteen years
  // as Chief Financial Officer". Only the text after the match is considered,
  // and only when introduced by "as", so a second person's role in the same
  // sentence is not picked up by mistake.
  const RX_ROLE_AFTER = new RegExp('^[^.;]{0,90}?\\bas\\s+(?:the\\s+)?(?:Group\\s+)?' + QUAL + ROLE);

  function roleStatedAfter(sentence, fromIndex) {
    const m = String(sentence).slice(fromIndex).match(RX_ROLE_AFTER);
    if (!m) return '';
    const role = normRole(m[2]);
    if (!role) return '';
    return (normQual(m[1]) + role).trim();
  }

  // Run a global regex, returning all matches with their capture arrays.
  function allMatches(re, s) {
    const res = [];
    re.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = re.exec(s)) !== null) {
      res.push(m);
      if (m.index === re.lastIndex) re.lastIndex++;
      if (++guard > 50) break;
    }
    return res;
  }

  function appointmentsIn(s, filerTokens, fallbackRole) {
    const found = [];
    if (isPureBackground(s)) return found;
    const permanent = isPermanentNow(s);
    const trailingInterim = !permanent && TRAILING_INTERIM.test(s);

    for (const pat of RX_APP_LIST) {
      const matches = allMatches(pat.re, s);
      for (const m of matches) {
        const name = validName(m[pat.n]);
        if (!name) continue;
        const roleRaw = pat.r ? m[pat.r] : '';
        // ROLE is the last thing every appointment pattern captures, so the
        // match ends exactly where the role ends. (indexOf(roleRaw) would find
        // the wrong copy when the role text also appears earlier in the match:
        // "appoint Deputy Chief Financial Officer, Daniel Peacock, as interim
        // Chief Financial Officer".)
        const roleEnd = m.index + m[0].length;
        if (roleScopeIsForeign(s, roleEnd, filerTokens)) continue;
        let q = pat.q ? m[pat.q] : '';
        if (permanent) q = '';
        if (!q && trailingInterim) q = 'interim';
        const role = normRole(roleRaw);
        if (!role) continue;
        const rl = (normQual(q) + role).trim();
        if (found.some(f => f.name.toLowerCase() === name.toLowerCase())) continue;
        found.push({ name, role: rl });
      }
    }

    // Only if the sentence named no role at all: "the appointment of Andrew
    // Smith to the board", with the role carried by the release title.
    if (!found.length && fallbackRole) {
      for (const re of RX_APP_ROLELESS) {
        for (const m of allMatches(re, s)) {
          const name = validName(m[1]);
          if (!name) continue;
          if (found.some(f => f.name.toLowerCase() === name.toLowerCase())) continue;
          found.push({ name, role: fallbackRole });
        }
      }
    }
    return found;
  }

  function departuresIn(s) {
    const found = [];
    if (/\bprior to being appointed\b|\bbefore joining\b/i.test(s) && !ACTIVE_LEAVE_VERB.test(s)) return found;

    for (const pat of RX_DEP_LIST) {
      const matches = allMatches(pat.re, s);
      for (const m of matches) {
        const name = validName(m[pat.n]);
        if (!name) continue;

        let role, tenseWord, inheritRole = false;
        if (pat.kind === 'board') {
          role = 'BOARD';
          tenseWord = tenseVerb(pat.tense ? m[pat.tense] : '', 'STEP DOWN', s, pat.future);
        } else if (pat.kind === 'retire') {
          const rl = pat.r && m[pat.r] ? (normQual(m[pat.q]) + normRole(m[pat.r])).trim() : 'BOARD';
          role = rl || 'BOARD';
          tenseWord = tenseVerb(pat.tense ? m[pat.tense] : '', 'RETIRE', s, pat.future);
        } else if (pat.kind === 'succeeded') {
          role = 'BOARD';
          inheritRole = true; // may be replaced by appointment role later
          tenseWord = 'WILL STEP DOWN';
        } else if (pat.kind === 'succeeded_role') {
          const rl = pat.r && m[pat.r] ? (normQual(m[pat.q]) + normRole(m[pat.r])).trim() : 'BOARD';
          role = rl || 'BOARD';
          tenseWord = 'WILL STEP DOWN';
        } else {
          const rl = pat.r && m[pat.r] ? (normQual(m[pat.q]) + normRole(m[pat.r])).trim() : 'BOARD';
          role = rl || 'BOARD';
          tenseWord = tenseVerb(pat.tense ? m[pat.tense] : '', 'STEP DOWN', s, pat.future);
        }

        // No role captured — it may be stated later in the same sentence.
        if (role === 'BOARD' && !inheritRole) {
          role = roleStatedAfter(s, m.index + m[0].length) || 'BOARD';
        }

        if (found.some(f => f.name.toLowerCase() === name.toLowerCase())) continue;
        found.push({ name, role, tenseWord, inheritRole });
      }
    }
    return found;
  }

  const APPOINT_ANY = /\b(appointed|appoints?|appointment of|will take on the role|will be appointed|will join\b[^.;]*\bas|step up to|assume|take up|will succeed)\b/i;
  const LEAVE_ANY   = /\b(step down|steps down|stepped down|stepping down|will retire|is retiring|intends to retire|intention to retire|retire as|retire from|retirement of|succeeding|will be succeeded|is leaving|will leave|leaving the (?:group|company|board|business|organisation|organization))\b/i;

  function extractBoard(sentences, opts) {
    const o = opts || {};
    const filerTokens = o.filerTokens || new Set();
    const titleRole = headlineRole(o.headline);
    const appointments = [];
    const departures = [];
    const seenA = new Set();
    const seenD = new Set();

    for (const raw of sentences) {
      // Strip inline defined terms ("CEO") that poison NAME->ROLE proximity.
      const s = stripInlineDefTerms(oneLine(raw));
      if (s.length < 12) continue;

      const hasAppoint = APPOINT_ANY.test(s);
      const hasLeave = LEAVE_ANY.test(s);
      if (!hasAppoint && !hasLeave) continue;

      if (hasAppoint) {
        for (const a of appointmentsIn(s, filerTokens, titleRole)) {
          const k = a.name.toLowerCase();
          if (!seenA.has(k)) { seenA.add(k); appointments.push(a); }
        }
      }
      if (hasLeave) {
        for (const d of departuresIn(s)) {
          const k = d.name.toLowerCase();
          if (!seenD.has(k)) { seenD.add(k); departures.push(d); }
        }
      }
    }

    // ── ROLE INHERITANCE (#3) ──
    // A "succeeding X" / generic-BOARD departure inherits the role of an
    // appointment (the incoming person's role is what the outgoing held).
    if (appointments.length) {
      const primaryRole = appointments[0].role.replace(/^INTERIM |^ACTING /, '');
      for (const d of departures) {
        if (d.inheritRole && d.role === 'BOARD') d.role = primaryRole;
      }
    }

    // ── NO CONTRADICTORY SNAPS (#9) ──
    // If a person is both appointed and "leaving" the SAME role, drop the
    // departure (they're being promoted/appointed, not leaving that role).
    const appByName = new Map(appointments.map(a => [a.name.toLowerCase(), a]));
    const cleanDeps = departures.filter(d => {
      const a = appByName.get(d.name.toLowerCase());
      if (!a) return true;
      const ar = a.role.replace(/^INTERIM |^ACTING /, '');
      const dr = d.role.replace(/^INTERIM |^ACTING /, '');
      // same role => contradictory => drop departure
      if (ar === dr || dr === 'BOARD') return false;
      return true;
    });

    const out = [];
    const status = {};

    const apps = appointments.slice(0, 3);
    apps.forEach((a, i) => {
      out.push({ body: a.name.toUpperCase() + ' APPOINTED ' + a.role, slot: 'appointed' + (i ? i : ''), preformatted: true });
    });
    status.appointed = apps.length
      ? { state: 'emitted', count: apps.length }
      : { state: 'skipped', reason: 'No clean full-name + valid non-divisional role appointment found.' };

    const deps = cleanDeps.slice(0, 3);
    deps.forEach((d, i) => {
      const tail = (d.role && d.role !== 'BOARD') ? (' AS ' + d.role) : ' FROM BOARD';
      out.push({ body: d.name.toUpperCase() + ' ' + d.tenseWord + tail, slot: 'leaving' + (i ? i : ''), preformatted: true });
    });
    status.leaving = deps.length
      ? { state: 'emitted', count: deps.length }
      : { state: 'skipped', reason: 'No clean full-name departure found.' };

    return { out, status };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  DEAL ASSEMBLY
  // ════════════════════════════════════════════════════════════════════════
  function extractDeal(sentences, headline, fullText, isPossible) {
    const status = { total: null, headline: null };
    const out = [];

    const dh = dealHeadlineFields(headline, fullText || '');
    const increased = isIncreasedOffer(fullText || headline || '');
    const dtypeGlobal = (dh && dh.type) || dealTypeWord(fullText || headline || '');
    const contextTarget = (dh && dh.target) || '';

    const tv = totalValueFromBody(sentences);
    if (tv && tv.money) {
      const tgt = (tv.target || contextTarget || '').toString();
      const body = tgt ? (dtypeGlobal + ' OF ' + tgt.toUpperCase() + ' \u2014 ' + tv.money)
                       : (dtypeGlobal + ' \u2014 ' + tv.money);
      out.push({ body, slot: 'total', preformatted: true });
      status.total = { state: 'emitted' };
    } else {
      status.total = { state: 'skipped', reason: 'No stated whole-company equity value (per-share suppressed by rule).' };
    }

    if (dh && (dh.target || dh.bidder)) {
      let body;
      if (dh.target && dh.bidder) {
        if (increased) {
          body = dh.target.toUpperCase() + ' \u2014 INCREASED OFFER BY ' + dh.bidder.toUpperCase();
        } else if (isPossible) {
          body = 'POSSIBLE OFFER BY ' + dh.bidder.toUpperCase() + ' FOR ' + dh.target.toUpperCase();
        } else {
          const verb = /acquisition/i.test(dh.type) ? 'TO BE ACQUIRED BY' : 'OFFER BY';
          body = dh.target.toUpperCase() + ' ' + verb + ' ' + dh.bidder.toUpperCase();
        }
      } else if (dh.target) {
        body = isPossible
          ? 'POSSIBLE OFFER FOR ' + dh.target.toUpperCase()
          : dh.target.toUpperCase() + ' \u2014 ' + (increased ? 'INCREASED OFFER' : dh.type);
      } else {
        body = (increased ? 'INCREASED OFFER' : dh.type) + ' BY ' + dh.bidder.toUpperCase();
      }
      if (dh.structure) body += ' (' + dh.structure + ')';
      out.push({ body, slot: 'headline', preformatted: true });
      status.headline = { state: 'emitted' };
    } else {
      status.headline = { state: 'skipped', reason: 'Could not parse target/bidder.' };
    }

    return { out, status };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TRANSFORM / FINALISE
  // ════════════════════════════════════════════════════════════════════════
  function transformBody(body, preformatted) {
    let s = preformatted ? oneLine(body) : cutAtFullStop(body);
    if (!preformatted) {
      s = s.replace(/^(the|an)\s+/i, '');
      s = s.replace(/ (the|an) /gi, ' ');
    }
    s = s.replace(/\bapproximately\b/gi, 'about');
    s = s.replace(/\bbillion\b/gi, 'BLN');
    s = s.replace(/\bmillion\b/gi, 'MLN');
    s = s.replace(/\bbn\b/gi, 'BLN');
    s = s.replace(/\bm\b/gi, 'MLN');
    s = s.replace(/\s{2,}/g, ' ').replace(/\s+([,;:])/g, '$1').trim();
    s = s.replace(/\.\s*$/, '').trim();
    return s;
  }

  function finalise(item, source) {
    let bodyT = transformBody(item.body, item.preformatted);
    if (!bodyT) return '';
    const prefix = source ? oneLine(source) + ': ' : '';
    let snap = (prefix + bodyT).toUpperCase();
    if (snap.length > HARD_CAP) snap = snap.slice(0, HARD_CAP).trimEnd();
    snap = snap.replace(/\.\s*$/, '');
    return snap;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PUBLIC
  // ════════════════════════════════════════════════════════════════════════
  function safe(fn, fallback, label) {
    try { return fn(); }
    catch (e) {
      console.warn('SnapEngine stage failed [' + (label || '?') + ']:', e && e.message ? e.message : e);
      return fallback;
    }
  }

  function snap(input) {
    input = input || {};
    const bodyText = input.bodyText;
    const headline = input.headline;
    // A caller can force the snap prefix (the "WELLS FARGO:" at the front of
    // every snap off this release). When blank, fall back to auto-detection.
    const sourceOverride = String(input.sourceOverride || '').trim();

    let full = safe(() => clean(normaliseBlob(stripTerminalJunk(String(bodyText || '')))),
      clean(String(bodyText || '')), 'preprocess');
    if (!full) full = clean(String(bodyText || ''));

    if (!isRns(full)) {
      console.log('SnapEngine: not an LSE RNS release (no RNS marker) — no auto-snap.');
      return { source: '', tags: [], snaps: [], status: { gate: { state: 'skipped', reason: 'Not an LSE RNS release.' } } };
    }

    const source = sourceOverride || safe(() => deriveSourceFromText(full), '', 'source');
    const type = safe(() => classify(full), 'NONE', 'classify');
    const usableHeadline = oneLine(headline) || safe(() => recoverHeadline(full), '', 'headline');

    let extracted = { out: [], status: {} };
    let category = null;
    let maxSnaps = 2;

    if (type === 'FIRM_OFFER' || type === 'POSSIBLE_OFFER') {
      const isPossible = (type === 'POSSIBLE_OFFER');
      extracted = safe(() => {
        const dealBody = repairGlue(windowWords(full, WORD_WINDOW_DEAL));
        const sentences = splitSentences(dealBody);
        return extractDeal(sentences, usableHeadline, repairGlue(full), isPossible);
      }, { out: [], status: { total: { state: 'skipped', reason: 'Deal extraction threw.' } } }, 'extractDeal');
      category = 'DEAL';
      maxSnaps = 2;
    } else if (type === 'RESPONSE') {
      extracted = safe(() => {
        const respBody = windowWords(full, WORD_WINDOW_DEAL);
        const sentences = splitSentences(respBody);
        return extractResponse(sentences, usableHeadline, full);
      }, { out: [], status: { response: { state: 'skipped', reason: 'Response extraction threw.' } } }, 'extractResponse');
      category = 'RESPONSE';
      maxSnaps = 1;
    } else if (type === 'RULE_28') {
      extracted = safe(() => extractRule28(usableHeadline, full),
        { out: [], status: { rule28: { state: 'skipped', reason: 'Rule 2.8 extraction threw.' } } }, 'extractRule28');
      category = 'RULE_28';
      maxSnaps = 1;
    } else if (type === 'BOARD_CHANGE') {
      extracted = safe(() => {
        const repaired = repairBoardGlue(full);
        const boardBody = windowWords(repaired, WORD_WINDOW_BOARD);
        const sentences = splitSentences(boardBody);
        return extractBoard(sentences, {
          filerTokens: filerIdentity(full, source),
          headline: usableHeadline
        });
      }, { out: [], status: { appointed: { state: 'skipped', reason: 'Board extraction threw.' } } }, 'extractBoard');
      category = 'BOARD';
      maxSnaps = 6;
    }

    const snaps = [];
    const seen = new Set();
    for (const item of (extracted.out || [])) {
      const line = safe(() => finalise(item, source), '', 'finalise');
      if (!line) continue;
      const key = line.replace(/\s+/g, ' ').slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      snaps.push({ text: line, category, slot: item.slot });
      if (snaps.length >= maxSnaps) break;
    }

    if (type !== 'NONE') {
      try {
        const lines = Object.entries(extracted.status || {}).map(([slot, st]) =>
          st.state === 'emitted'
            ? '  \u2713 ' + slot + ': emitted' + (st.count ? ' (x' + st.count + ')' : '')
            : '  \u2717 ' + slot + ': SKIPPED \u2014 ' + st.reason);
        console.log('Snap status [' + type + '] source="' + source + '":\n' + lines.join('\n'));
      } catch (e) { /* logging must never break output */ }
    }

    const tag = (type === 'FIRM_OFFER' || type === 'POSSIBLE_OFFER') ? 'DEAL' : type;
    return { source, tags: type === 'NONE' ? [] : [tag], snaps, status: extracted.status || {} };
  }

  return {
    snap, deriveSourceFromText, classify, splitSentences,
    windowWords, transformBody, repairGlue, repairBoardGlue, recoverHeadline,
    totalValueFromBody, dealHeadlineFields, extractBoard, extractRule28,
    extractResponse, definedAliasFor, isActiveRule28, isResponseToOffer,
    dealTypeWord, stripTerminalJunk, normaliseBlob, isRns, isIncreasedOffer,
    hasTakeoverContext, looksLikeCompany, validName, roleScopeIsForeign,
    filerIdentity, stripInlineDefTerms
  };
})();

if (typeof window !== 'undefined') window.SnapEngine = SnapEngine;
