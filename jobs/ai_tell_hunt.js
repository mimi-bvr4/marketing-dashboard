#!/usr/bin/env node
// ORDER #3010: the AI Tell Detective's Monday trend hunt, from the command line.
//
//   node jobs/ai_tell_hunt.js hunt --dry-run --out <folder>
//       Searches (Claude with web search, the agents' key), and writes
//       <folder>/cards.md (the proposed Review cards) and <folder>/proposals.json.
//       Writes NOTHING else: not the ban list, the lint, the card store or the
//       ledger. Only --dry-run exists in this slice; without it the job refuses.
//
//   node jobs/ai_tell_hunt.js decide <proposals.json> <n> approve|reject --who <name> [--note <text>]
//       Records a person's verdict on card n in the hunt ledger
//       (07_Marketing_and_Brand/AI_TELLS_HUNT_LEDGER.md). A reject is never
//       proposed again. An approve also writes <proposals.json dir>/ban_list_after.md,
//       the ban list with the tell added: copy it into the list and change
//       lib/ai-tells.js and LIST_UPDATED on a branch (then re-pin sales-brain).
//
//   node jobs/ai_tell_hunt.js hunt --post                    (ORDER #3015)
//       AI_TELL_HUNT on only. Pulls the Review tab's verdicts into the ledger,
//       hunts, posts each new proposed tell to the Review tab as a card
//       (agent 'ai-tell-hunt'), and records the run. No ban list, no lint.
//
//   node jobs/ai_tell_hunt.js pull-verdicts                  (ORDER #3015)
//       Copies each Approve tell / Reject tell pressed on the Review tab into
//       the ledger through decide(). Pulling twice writes one row per tell.
//
// FEATURE FLAG: AI_TELL_HUNT default OFF. The dry run and decide do not need it
// (they publish nothing); the scheduled Monday run will. Putting the hunt on the
// Producer's calendar is Mimi's paste.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../lib/ai-tell-hunt');

const ROOT = process.env.IHG_PROJECT_ROOT || path.join(os.homedir(), 'Full_IH_Project');
const BAN = path.join(ROOT, '07_Marketing_and_Brand', 'AI_TELLS_BAN_LIST.md');
const LEDGER = path.join(ROOT, '07_Marketing_and_Brand', 'AI_TELLS_HUNT_LEDGER.md');

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }

// ORDER #3015: the card store is the marketing Postgres, reached from the Box
// through MARKETING_DATABASE_URL (jobs/agents_daily.sh supplies it).
function pgStore() {
  if (!process.env.MARKETING_DATABASE_URL) { console.error('NOT RUN: MARKETING_DATABASE_URL is not set'); return null; }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const store = require('../lib/agent-store').createPgStore(pool, { lint: require('../lib/ai-tells').lint });
  return { store, end: () => pool.end() };
}

// ORDER #3015: hunt --post. Pulls verdicts, hunts, posts new proposed tells to
// the Review tab as cards, records the run. Behind AI_TELL_HUNT (default OFF).
async function huntPost() {
  if (!H.huntOn(process.env)) { console.error('NOT RUN: AI_TELL_HUNT is off.'); return 2; }
  let calls = 0;
  const ask = require('../lib/agent-sources').askers({ env: process.env, fetch: globalThis.fetch }, { claude_web_search: true }, () => { calls++; }).claude;
  if (!ask) { console.error('no Claude key on this machine for web search'); return 3; }
  const db = pgStore(); if (!db) return 3;
  try {
    const r = await require('../lib/ai-tell-review').postHunt({ ask, store: db.store, banText: fs.readFileSync(BAN, 'utf8'), ledgerFile: LEDGER, today: today(), env: process.env });
    console.log(`verdicts pulled: ${r.pulled.added.length}; ${r.hunt.summary}; posted to Review: ${r.posted.length}; already on the tab: ${r.already.length}; requests: ${calls}`);
    return r.hunt.ok ? 0 : 1;
  } finally { await db.end(); }
}

// ORDER #3015: pull-verdicts. Copies each Approve tell / Reject tell from the
// Review tab into the hunt ledger through decide(). Writes only the ledger.
async function pullVerdictsCmd() {
  const db = pgStore(); if (!db) return 3;
  try {
    const r = await require('../lib/ai-tell-review').pullVerdicts({ store: db.store, ledgerFile: LEDGER });
    console.log(`verdicts added to the ledger: ${r.added.length}; already there: ${r.skipped.length}`);
    for (const e of r.added) console.log(`  ${e.kind} ${e.key} by ${e.who}`);
    return 0;
  } finally { await db.end(); }
}

async function hunt() {
  if (process.argv.includes('--post')) return huntPost();
  if (!process.argv.includes('--dry-run')) { console.error('Add --dry-run (writes two files only), or --post (AI_TELL_HUNT on; posts to the Review tab).'); return 2; }
  const out = arg('--out');
  if (!out) { console.error('--out <folder> is required'); return 2; }
  let calls = 0;
  const ask = require('../lib/agent-sources').askers({ env: process.env, fetch: globalThis.fetch },{ claude_web_search: true }, () => { calls++; }).claude;
  if (!ask) { console.error('no Claude key on this machine for web search'); return 3; }
  const r = await H.huntDry({ ask, banText: fs.readFileSync(BAN, 'utf8'), ledger: H.readLedger(LEDGER), today: today() });
  fs.mkdirSync(out, { recursive: true });
  const md = [`# AI tell hunt, DRY RUN ${today()} (ORDER #3010)`, '', r.summary, `Requests: ${calls}.`, '',
    ...r.cards.flatMap((c, i) => [`## Card ${i + 1}: ${c.title}`, '', c.body, '']),
    r.skipped.length ? `## Skipped\n${r.skipped.map((s) => `- ${s.pattern}: ${s.why}`).join('\n')}\n` : '',
    r.dropped.length ? `## Dropped for missing proof\n${r.dropped.map((s) => `- ${s.pattern || '(no pattern)'}: ${s.why}`).join('\n')}\n` : '',
    r.failed.length ? `## Searches that failed\n${r.failed.map((f) => `- ${f.query}: ${f.error}`).join('\n')}\n` : ''].join('\n');
  fs.writeFileSync(path.join(out, 'cards.md'), md);
  fs.writeFileSync(path.join(out, 'proposals.json'), JSON.stringify({ since: r.since, cards: r.cards.map((c) => c.proposal), answers: r.answers }, null, 2));
  console.log(r.summary);
  return r.ok ? 0 : 1;
}

function decideCmd() {
  const [file, n, verdict] = process.argv.slice(3, 6);
  const who = arg('--who');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const p = data.cards[Number(n) - 1];
  if (!p) { console.error(`no card ${n} in ${file}`); return 2; }
  const ymd = today();
  const r = H.decide({ ledger: H.readLedger(LEDGER), proposal: p, verdict, who, ymd, note: arg('--note') || '' });
  if (r.error) { console.error(r.error); return 1; }
  H.appendLedger(LEDGER, r.entry);
  if (verdict === 'approve') {
    const after = path.join(path.dirname(file), 'ban_list_after.md');
    fs.writeFileSync(after, H.applyApproved(fs.readFileSync(BAN, 'utf8'), [{ proposal: p, who: r.entry.who, ymd }]));
    console.log(`approved and logged; the ban list with it added is ${after}. Change lib/ai-tells.js and LIST_UPDATED on a branch.`);
  } else console.log('rejected and logged; it will not be proposed again.');
  return 0;
}

if (require.main === module) {
  const cmd = process.argv[2];
  const run = cmd === 'hunt' ? hunt() : cmd === 'decide' ? Promise.resolve(decideCmd()) : cmd === 'pull-verdicts' ? pullVerdictsCmd()
    : Promise.resolve((console.error('usage: hunt --dry-run --out <folder> | hunt --post | pull-verdicts | decide <proposals.json> <n> approve|reject --who <name>'), 2));
  run.then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
