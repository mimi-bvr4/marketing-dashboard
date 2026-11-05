#!/usr/bin/env node
// ORDER #2962: the weekly reviewer facts, rendered to a file for Mimi and NB.
//
//   node jobs/reviewer_watch.js --out <file.md> [--week YYYY-MM-DD]
//
// READ ONLY (lib/reviewer-watch.js readRows). It writes ONE file, the DRAFT
// scorecard, and sends nothing: no email, no text, no message to any staff
// member. Delivery to NB waits for Mimi's channel ruling (order #2962 Output).
// Not scheduled by this order; a launchd load is its own ruled step.
'use strict';

const fs = require('fs');
const W = require('../lib/reviewer-watch');

async function main(argv = process.argv.slice(2)) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const out = arg('--out');
  if (!out) { console.error('usage: reviewer_watch.js --out <file.md> [--week YYYY-MM-DD]'); return 2; }
  const { pool } = require('../db');
  if (!pool) { console.error('no DATABASE_URL: nothing read, nothing written'); return 2; }
  const now = new Date();
  const wk = arg('--week');
  const weekStart = wk ? W.mondayOf(wk) : W.weekFor(now);
  const rows = await W.readRows(pool, W.ctMidnight(W.addDays(weekStart, -7)));
  const cards = W.DEPARTMENTS.map((dept) => W.scorecard({ dept, rows, now, weekStart }));
  const md = W.renderMarkdown(cards, { base: 'https://marketing.infinityhospitalitygroup.com' });
  const bad = W.labelWords(md);
  if (bad.length) { console.error(`refused: judgment words in the output: ${bad.join(', ')}`); return 3; }
  fs.writeFileSync(out, md, { flag: 'wx' });
  console.log(`wrote ${out}: week of ${weekStart}, ${cards.length} department(s)`);
  await pool.end();
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
module.exports = { main };
