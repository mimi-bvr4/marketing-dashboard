#!/usr/bin/env node
// ORDER #3794: the hourly Google Ads monitor (read-only). Google Ads access:
// Standard (writes disabled in code), ORDER #3819.
//
//   node jobs/ads_monitor.js --accounts   every account the Brain can see: customer id and name only
//   node jobs/ads_monitor.js [--dry]      one poll: read, flag, card what is new
//
// FEATURE FLAG: ADS_API_LIVE default OFF. Off, a poll reads nothing and writes
// nothing (exit 0, one line saying so). --accounts runs with the flag off: it is
// the setup proof, a list of ids and names, and it writes nothing.
//
// What a poll writes, and only this:
//   <state dir>/snapshot.json  counts, shares and week-over-week changes, no amount
//   <state dir>/state.json     flagged keys, last campaign statuses, URL results
//   one DRAFT card for the Paid Ads Auditor when a flag is new (it shows on
//   Katherine's Auditor card and on Review); nothing is sent to anyone.
// State dir: ADS_MONITOR_STATE_DIR, else ~/.config/brain/ads_monitor (beside the
// Brain's key, never in the synced tree). --dry writes nothing at all.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/google-ads-read');
const M = require('../lib/google-ads-monitor');

function stateDir(env = process.env) {
  return env.ADS_MONITOR_STATE_DIR || path.join(os.homedir(), '.config', 'brain', 'ads_monitor');
}
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(v, null, 1)}\n`);
  fs.renameSync(tmp, p);
}

// ORDER #3795: a Test-level Cloud project (CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION)
// prints its Waiting line and exits 1, reading and writing nothing more.
// ORDER #3819: access is Standard (writes disabled in code). If the startup check
// or any answer reports a mutate, the poll prints one ALARM line to stderr (the
// launchd error log), writes nothing, and exits 3, so it never looks like a pass.
async function main(opts = {}) {
  const log = opts.log || console.log;
  const alarm = opts.alarm || console.error;
  try { return await run({ ...opts, log }); } catch (e) {
    if (e && e.alarm === 'MUTATE') { alarm(e.message); return 3; }
    const w = R.waitingLine(e);
    if (!w) throw e;
    log(w);
    return 1;
  }
}

async function run({ argv = process.argv.slice(2), log = console.log, env = process.env, client, store, now = new Date(), checkUrl } = {}) {
  const dry = argv.includes('--dry');
  R.startupCheck(); // #3819: before anything, flag on or off
  if (argv.includes('--accounts')) {
    const c = client || R.createClient({ env });
    const list = await R.listAccounts(c);
    if (!list.length) { log('the Brain can see 0 Google Ads accounts'); return 1; }
    for (const a of list) log(`${a.id}  ${a.name}`);
    return 0;
  }
  if (!R.flagOn(env)) { log(`${R.FLAG} is off: nothing read, nothing written`); return 0; }

  const c = client || R.createClient({ env });
  const dir = stateDir(env);
  const prior = readJson(path.join(dir, 'state.json'), null);
  const win = R.windowFor(now);
  const accounts = [];
  for (const a of await R.listAccounts(c)) accounts.push(await R.readAccount(c, a, win));
  const flags = M.flagsFor(accounts, prior, { now, env });
  const u = await M.checkUrls(M.finalUrls(accounts), prior, { now, ...(checkUrl ? { check: checkUrl } : {}) });
  flags.push(...u.flags);
  const fresh = M.newFlags(flags, prior);
  const card = M.cardFor(fresh, { now });
  log(`read ${accounts.length} account(s), ${win.from} to ${win.to}; ${flags.length} flag(s), ${fresh.length} new`);
  if (dry) { if (card) log(`${card.title}\n${card.body}`); return 0; }

  if (card) {
    let s = store;
    if (!s) {
      if (!env.MARKETING_DATABASE_URL) { log('NOT CARDED: MARKETING_DATABASE_URL is not set; state kept so the flags card next run'); }
      else {
        const { Pool } = require('pg');
        const { createPgStore, ensureAgentTables } = require('../lib/agent-store');
        const pool = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
        await ensureAgentTables(pool);
        s = createPgStore(pool, {});
      }
    }
    if (s) { const row = await s.insert(card); log(`carded ${fresh.length} new flag(s) as card ${row && row.id}`); }
    else fresh.length = 0; // nothing carded: do not remember these keys
  }
  writeJson(path.join(dir, 'snapshot.json'), R.snapshot(accounts, { now }));
  writeJson(path.join(dir, 'state.json'), {
    at: now.toISOString(),
    flagged: [...new Set([...((prior && prior.flagged) || []), ...fresh.map((f) => f.key)])].slice(-2000),
    campaigns: M.campaignState(accounts),
    urls: u.urls,
  });
  return 0;
}

if (require.main === module) main().then((code) => process.exit(code), (e) => { console.error(String(e.message || e)); process.exit(1); });
module.exports = { main, stateDir };
