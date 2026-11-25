#!/usr/bin/env node
// ORDER #3804: the Monday paid ads report (Google Ads + Meta), read-only.
//
//   node jobs/paid_ads_weekly.js [--dry]
//
// FEATURE FLAG: PAID_ADS_WEEKLY default OFF. Off, it reads nothing and writes
// nothing (exit 0, one line saying so). --dry builds the card and prints it,
// writing nothing; it still reads (Google from the #3794 snapshot on disk, Meta
// through lib/meta-read.js GETs), so it is the proof run.
//
// What it writes, and only this: ONE draft Paid Ads Auditor card per week
// (Katherine's card and Review; nothing is sent to anyone), and
// <ads monitor state dir>/weekly_state.json so the same week is not carded twice.
'use strict';

const fs = require('fs');
const path = require('path');
const W = require('../lib/paid-ads-weekly');
const meta = require('../lib/meta-read');
const { stateDir } = require('./ads_monitor');

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }

async function main({ argv = process.argv.slice(2), log = console.log, env = process.env, store, now = new Date(), readMeta, snapshot } = {}) {
  const dry = argv.includes('--dry');
  if (!W.flagOn(env) && !dry) { log(`${W.FLAG} is off: nothing read, nothing written`); return 0; }
  const dir = stateDir(env);
  const wk = W.reportWeek(now);
  const state = readJson(path.join(dir, 'weekly_state.json'), {});
  if (!dry && state.week === wk.week) { log(`week of ${wk.week} already carded (card ${state.card_id}); nothing written`); return 0; }

  const snap = snapshot !== undefined ? snapshot : readJson(path.join(dir, 'snapshot.json'), null);
  const m = readMeta ? await readMeta(wk) : await meta.readAdsWeek(wk, { env });
  const card = W.report({ snapshot: snap, meta: m, now, env });
  log(`week of ${wk.week}: ${card.payload.paid_ads_weekly.google_venues} Google venue(s), ${card.payload.paid_ads_weekly.meta_accounts} Meta account(s), ${card.payload.paid_ads_weekly.actions} drafted change(s), ${card.payload.paid_ads_weekly.waiting} waiting line(s)`);
  if (dry) { log(`${card.title}\n${card.body}`); return 0; }

  let s = store;
  if (!s) {
    if (!env.MARKETING_DATABASE_URL) { log('NOT CARDED: MARKETING_DATABASE_URL is not set; the week will card next run'); return 1; }
    const { Pool } = require('pg');
    const { createPgStore, ensureAgentTables } = require('../lib/agent-store');
    const pool = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await ensureAgentTables(pool);
    s = createPgStore(pool, {});
  }
  const row = await s.insert(card);
  log(`carded the week of ${wk.week} as card ${row && row.id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'weekly_state.json'), `${JSON.stringify({ week: wk.week, card_id: row && row.id, at: now.toISOString() })}\n`);
  return 0;
}

if (require.main === module) main().then((code) => process.exit(code), (e) => { console.error(String(e.message || e)); process.exit(1); });
module.exports = { main };
