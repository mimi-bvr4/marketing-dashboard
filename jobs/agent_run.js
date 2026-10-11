#!/usr/bin/env node
// ORDER #1015: run marketing agents.
//
//   node jobs/agent_run.js <agent> [--ask "text"] [--dry]
//   node jobs/agent_run.js --due [--date YYYY-MM-DD]   every agent whose cadence falls today (Nashville date)
//   node jobs/agent_run.js --list
//
// --dry prints the cards and writes nothing. Otherwise cards go to the Review
// tab through MARKETING_DATABASE_URL (jobs/agents_daily.sh supplies it with
// `railway run`, the photo jobs' pattern). Never publishes anything.
'use strict';

const { runAgent, loadAgent, listAgents } = require('../lib/agent-runner');
const { createPgStore, createMemoryStore, ensureAgentTables } = require('../lib/agent-store');
const { textClientFromEnv } = require('../lib/agent-llm');
const { lint } = require('../lib/ai-tells');

// Which agents are due on a Nashville calendar day. Bloggy Bob runs on request only.
function dueAgents(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sunday
  const due = ['gbp'];
  if (dow === 1) due.push('site-health', 'paid-ads');
  if (d === 3) due.push('monthly-report');
  if (d === 15) due.push('citations');
  if (dow === 1 && d <= 7 && [1, 4, 7, 10].includes(m)) due.push('listings');
  return due;
}

function nashvilleYmd(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function parseArgs(argv) {
  const a = { agents: [], dry: false, ask: null, due: false, list: false, date: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry') a.dry = true;
    else if (x === '--due') a.due = true;
    else if (x === '--list') a.list = true;
    else if (x === '--ask') a.ask = argv[++i];
    else if (x === '--date') a.date = argv[++i];
    else a.agents.push(x);
  }
  return a;
}

async function main({ argv = process.argv.slice(2), log = console.log, pool, llm, env = process.env, fetchImpl } = {}) {
  const args = parseArgs(argv);
  if (args.list) { listAgents().forEach((s) => { const d = loadAgent(s); log(`${s.padEnd(15)} ${d.name}: ${d.cadence}`); }); return 0; }
  const slugs = args.due ? dueAgents(args.date || nashvilleYmd()) : args.agents;
  if (!slugs.length) { log('usage: agent_run.js <agent> [--ask text] [--dry] | --due | --list'); return 2; }
  let store;
  if (args.dry) store = createMemoryStore({ lint });
  else {
    let db = pool;
    if (!db) {
      if (!env.MARKETING_DATABASE_URL) { log('NOT RUN: MARKETING_DATABASE_URL is not set (use --dry to preview)'); return 3; }
      const { Pool } = require('pg');
      db = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    }
    await ensureAgentTables(db);
    store = createPgStore(db, { lint });
  }
  let model = llm;
  if (model === undefined) {
    const k = textClientFromEnv();
    model = k.client;
    log(model ? `model ${model.model}; key from ${k.source}` : 'NO MODEL KEY: agents will record measured sources only');
  }
  let failed = 0;
  const ymd = args.date || nashvilleYmd();
  if (args.due && !args.dry && new Date(ymd + 'T12:00:00Z').getUTCDay() === 1) {
    const { writeDigest } = require('../lib/agent-digest');
    const d = await writeDigest({ store });
    log(`digest: card #${d.id}`);
  }
  for (const slug of slugs) {
    const r = await runAgent({ slug, store, llm: model, ask: args.ask, env, fetchImpl: fetchImpl || globalThis.fetch, log, dryRun: args.dry,
      scheduled: args.due });
    if (r.skipped) { log(`${slug}: skipped (${r.skipped})`); continue; }
    log(`${slug}: ${r.ok ? 'done' : 'FAILED ' + r.error}, ${r.cards.length} card(s)${r.unavailable.length ? `, ${r.unavailable.length} source(s) unavailable` : ''}`);
    if (args.dry) for (const c of r.cards) log(`\n----- ${c.title} -----\n${c.body}\n`);
    if (!r.ok) failed++;
  }
  if (pool === undefined && store.end) await store.end();
  return failed ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error('agent_run:', e.message); process.exit(1); });
}

module.exports = { main, dueAgents, parseArgs, nashvilleYmd };
