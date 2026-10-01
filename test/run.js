// Training Wire — BOARD regression runner.
//
//   node test/run.js            compare engine output against cases[].expect
//   node test/run.js --report   print what the engine actually produces
//   node test/run.js --neg      run the precision fixtures instead
//   node test/run.js --all      run both sets
//   node test/run.js <name>     run one case (substring match on its name)
//
// snap-engine.js is a browser IIFE assigned to a top-level const, so it is
// evaluated here rather than required.

const fs = require('fs');
const path = require('path');

// The front end lives in frontend/, which is what Azure Static Web Apps
// deploys (app_location in the workflow).
const ROOT = path.join(__dirname, '..', 'frontend');
const recall = require('./cases.js');
const precision = require('./negatives.js');
const cases = process.argv.includes('--all') ? recall.concat(precision)
  : process.argv.includes('--neg') ? precision
  : recall;

function loadEngine() {
  const src = fs.readFileSync(path.join(ROOT, 'snap-engine.js'), 'utf8');
  const log = console.log;
  console.log = () => {};          // engine logs a banner + per-release status
  const warn = console.warn;
  console.warn = () => {};
  try {
    return eval(src + '\n;SnapEngine');
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const REPORT = process.argv.includes('--report');
const filter = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0];

const engine = loadEngine();
const selected = filter ? cases.filter((c) => c.name.includes(filter)) : cases;

let pass = 0;
const failures = [];

for (const c of selected) {
  const log = console.log; console.log = () => {};
  const warn = console.warn; console.warn = () => {};
  let got;
  try {
    got = engine.snap({ bodyText: c.body, headline: c.headline || '' }).snaps.map((s) => s.text);
  } catch (e) {
    got = ['<<THREW: ' + (e && e.message) + '>>'];
  } finally {
    console.log = log;
    console.warn = warn;
  }

  if (REPORT) {
    console.log('\n' + c.name);
    if (!got.length) console.log('   (no snaps)');
    got.forEach((g) => console.log('   ' + g));
    continue;
  }

  const want = c.expect || [];
  // Order-independent: the desk cares which snaps exist, not the slot order.
  const norm = (a) => a.slice().sort();
  const ok = got.length === want.length &&
    JSON.stringify(norm(got)) === JSON.stringify(norm(want));
  if (ok) { pass++; continue; }

  const missing = want.filter((w) => !got.includes(w));
  const extra = got.filter((g) => !want.includes(g));
  failures.push({ name: c.name, missing, extra });
}

if (REPORT) process.exit(0);

for (const f of failures) {
  console.log('\nFAIL ' + f.name);
  f.missing.forEach((m) => console.log('   missing: ' + m));
  f.extra.forEach((e) => console.log('   extra:   ' + e));
}

console.log('\n' + pass + '/' + selected.length + ' passing, ' + failures.length + ' failing');
process.exit(failures.length ? 1 : 0);
