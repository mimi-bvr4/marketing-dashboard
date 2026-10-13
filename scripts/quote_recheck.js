#!/usr/bin/env node
// ORDER #1703: re-check a listings draft against the pages themselves.
//
//   node scripts/quote_recheck.js fetch <draft.md> <snapshot-dir>
//     Fetches every https URL in the draft's table rows once, politely (one at a
//     time, 2 s apart), and writes <dir>/index.json plus one .txt per page that
//     answered 200. Read-only: GET only, no login, no cookies.
//
//   node scripts/quote_recheck.js check <claims.json> <snapshot-dir>
//     claims.json: [{ row, claim, url, quote }]. Checks each quote is literally
//     in that URL's snapshot text (whitespace-normalized) and prints JSON
//     { passed, failed }. A page with no snapshot fails as "not read".
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { snapshotter, checkClaims } = require('../lib/quote-gate');

const fileFor = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + '.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function draftUrls(md) {
  const out = [];
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/https?:\/\/[^\s|)]+/g)) if (!out.includes(m[0])) out.push(m[0].replace(/^http:/, 'https:'));
  }
  return out;
}

async function fetchAll(draft, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const snap = snapshotter();
  const index = {};
  for (const url of draftUrls(fs.readFileSync(draft, 'utf8'))) {
    const s = await snap(url);
    index[url] = s.ok ? { ok: true, status: 200, file: fileFor(url), chars: s.text.length } : { ok: false, status: s.status || 0, why: s.why };
    if (s.ok) fs.writeFileSync(path.join(dir, fileFor(url)), s.text);
    process.stdout.write(`${s.ok ? 'READ' : 'NOT READ'} ${url}${s.ok ? '' : ` (${s.why})`}\n`);
    await sleep(2000);
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
}

async function check(claimsFile, dir) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const snap = async (url) => {
    const e = index[url];
    if (!e) return { ok: false, why: 'URL not fetched this run' };
    if (!e.ok) return { ok: false, why: e.why };
    return { ok: true, text: fs.readFileSync(path.join(dir, e.file), 'utf8') };
  };
  const claims = JSON.parse(fs.readFileSync(claimsFile, 'utf8'));
  const r = await checkClaims(claims, snap);
  const rowOf = (c) => (claims.find((x) => x.claim === c.claim && x.url === c.url) || {}).row;
  process.stdout.write(JSON.stringify({ passed: r.passed.map((p) => ({ row: rowOf(p), ...p })), failed: r.failed.map((f) => ({ row: rowOf(f), ...f })) }, null, 2) + '\n');
}

if (require.main === module) {
  const [mode, a, b] = process.argv.slice(2);
  const run = mode === 'fetch' ? fetchAll : mode === 'check' ? check : null;
  if (!run || !a || !b) { process.stderr.write('usage: quote_recheck.js fetch <draft.md> <dir> | check <claims.json> <dir>\n'); process.exit(2); }
  run(a, b).catch((e) => { process.stderr.write(e.stack + '\n'); process.exit(1); });
}

module.exports = { draftUrls };
