#!/usr/bin/env node
// ORDER #3794: the Google Ads monitor (read-only). Google Ads access:
// Standard (writes disabled in code), ORDER #3819.
// ORDER #3821 (Mimi, 11.25.2026): not hourly. "Checks Google Ads daily at
// 6:15 AM, quick health check at 1:15 PM."
//
//   node jobs/ads_monitor.js --accounts   every account the Brain can see: customer id and name only
//   node jobs/ads_monitor.js --daily      the 6:15 AM full pull: every account, today plus the
//                                         trailing 13 weeks; every flag; writes the snapshot the
//                                         Auditor and the Monday report (#3804) read
//   node jobs/ads_monitor.js --midday     the 1:15 PM health check, alerts only: a disapproved ad,
//                                         a campaign that stopped serving, a final URL that does
//                                         not load, spend well ahead of normal with 0 conversions.
//                                         Reads the last 7 days only; no card unless one fires;
//                                         never rewrites the snapshot.
//   neither flag: --daily before noon CT, --midday from noon on (launchd passes none)
//   --dry                                 read and flag, write nothing
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

// #3821: which run this is. An explicit flag wins; otherwise the CT hour picks.
function modeFor(argv = [], now = new Date()) {
  if (argv.includes('--midday')) return 'midday';
  if (argv.includes('--daily')) return 'daily';
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hourCycle: 'h23' }).format(now));
  return h >= 12 ? 'midday' : 'daily';
}
const MIDDAY_READS = Object.freeze(['campaignDaily', 'campaignStatus', 'adsStatus', 'keywordWeekly']);

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
  const midday = modeFor(argv, now) === 'midday';
  const win = midday ? R.middayWindowFor(now) : R.windowFor(now);
  const accounts = [];
  for (const a of await R.listAccounts(c)) accounts.push(await R.readAccount(c, a, win, midday ? { only: MIDDAY_READS } : {}));
  const flags = midday ? M.middayFlags(accounts, prior, { now, env }) : M.flagsFor(accounts, prior, { now, env });
  const u = await M.checkUrls(M.finalUrls(accounts), prior, { now, ...(checkUrl ? { check: checkUrl } : {}) });
  flags.push(...u.flags);
  const fresh = M.newFlags(flags, prior);
  const card = M.cardFor(fresh, { now, midday });
  log(`${midday ? 'midday check' : 'daily pull'}: read ${accounts.length} account(s), ${win.from} to ${win.to}; ${flags.length} flag(s), ${fresh.length} new`);
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
  // The snapshot is the daily pull's alone: the midday read is 7 days, not 13 weeks.
  if (!midday) writeJson(path.join(dir, 'snapshot.json'), R.snapshot(accounts, { now }));
  writeJson(path.join(dir, 'state.json'), {
    at: now.toISOString(),
    flagged: [...new Set([...((prior && prior.flagged) || []), ...fresh.map((f) => f.key)])].slice(-2000),
    campaigns: M.campaignState(accounts),
    // the daily pull sees every final URL and resets the list; midday adds to it
    urls: midday ? { ...((prior && prior.urls) || {}), ...u.urls } : u.urls,
  });
  return 0;
}

if (require.main === module) main().then((code) => process.exit(code), (e) => { console.error(String(e.message || e)); process.exit(1); });
module.exports = { main, stateDir, modeFor, MIDDAY_READS };
