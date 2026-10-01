// Guards the pasted-text table reconstructor in terminal.js.
//
// A financial release is mostly tables, and pasting one destroys the markup.
// These are the shapes that actually appear in RNS and EDGAR releases, plus the
// three mistakes that matter: splitting a negative figure at its bracket,
// promoting prose to a table row, and parsing a period header as data (which
// puts years in figure columns and silently mislabels everything).
//
//   node test/table-test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'terminal.js'), 'utf8');
const start = src.indexOf('const NUM_TOK');
const end = src.indexOf('// \u2550\u2550\u2550 PASTED TEXT');
let code = src.slice(start, end);
code += '\nmodule.exports={rowsFromLine,parseTextRow,textTableHtml,isPeriodHeaderLine};';
const m = { exports: {} };
// esc() lives in terminal.js above the slice; stub it for the html builder.
new Function('module', 'exports', 'esc',
  code)(m, m.exports, (t) => String(t == null ? '' : t));
const { rowsFromLine, parseTextRow, isPeriodHeaderLine } = m.exports;

const parse = (line) =>
  isPeriodHeaderLine(line) ? [{ label: line, cells: [], isData: false, header: true }]
                           : rowsFromLine(line).map(parseTextRow);

const cases = [
  ['money row',            'Revenue $ 96,221 $ 46,743 $ 177,837 $ 90,805'],
  ['bare numbers',         'Research and development 7,054 4,291 13,375 8,280'],
  ['per share',            'Diluted $ 2.46 $ 1.08 $ 4.85 $ 1.84'],
  ['percents and pts',     'Gross margin 75.0 % 74.9 % 72.4 % 0.1 pts 2.6 pts'],
  ['negatives "(19,732 )"','Payments related to repurchases of common stock (19,732 ) (9,721 ) (39,044 ) (23,815 )'],
  ['two rows on one line', 'GAAP cost of revenue $ 24,079 $ 20,458 $ 12,890 GAAP gross profit $ 72,142 $ 61,157'],
  ['dashes',               'Proceeds related to employee stock plans - - 515 370'],
  ['section heading',      'Current assets:'],
  ['period caption',       'Three Months Ended Six Months Ended'],
  ['PROSE must not split', 'NVIDIA will pay its next quarterly cash dividend of $0.25 per share on October 1, 2026.'],
  ['PROSE with 2 figures', 'GAAP and non-GAAP operating expenses are expected to be approximately $9.2 billion and $9.0 billion, respectively.'],
  ['HEADER dates',         'July 26, 2026 July 27, 2025 July 26, 2026 July 27, 2025'],
  ['HEADER short dates',   'July 26, July 27, July 26, July 27,'],
  ['HEADER years only',    '2026 2025 2026 2025'],
  ['HEADER period',        'Three Months Ended Six Months Ended'],
  ['HEADER balance dates', 'July 26, 2026 January 25, 2026'],
  ['money row w/ month ok','Dividends declared in July 2026 $ 6,047 $ 244'],
];

let fails = 0;
for (const [name, line] of cases) {
  const rows = parse(line);
  const data = rows.filter(r => r.isData);
  console.log('\n' + name);
  rows.forEach(r => console.log('   ' + (r.isData ? 'DATA' : 'cap ') + '  label=' + JSON.stringify(r.label) + '  cells=' + JSON.stringify(r.cells)));
  if (/^PROSE/.test(name) && data.length) { console.log('   !! FAIL: prose was read as a data row'); fails++; }
  if (name.startsWith('negatives') && !(data.length === 1 && data[0].cells.length === 4)) { console.log('   !! FAIL: expected 1 row of 4 cells'); fails++; }
  if (name.startsWith('two rows') && data.length !== 2) { console.log('   !! FAIL: expected 2 rows'); fails++; }
  if (name.startsWith('percents') && !(data.length === 1 && data[0].cells.length === 5)) { console.log('   !! FAIL: expected 5 cells'); fails++; }
  if (/^HEADER/.test(name) && data.length) { console.log('   !! FAIL: a period header was parsed as data'); fails++; }
  if (name.startsWith('money row w/ month') && data.length !== 1) { console.log('   !! FAIL: a real money row was swallowed as a header'); fails++; }
}
console.log('\n' + (fails ? fails + ' FAILURES' : 'all assertions passed'));
process.exit(fails ? 1 : 0);
