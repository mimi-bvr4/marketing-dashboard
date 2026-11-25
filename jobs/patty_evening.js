#!/usr/bin/env node
// ORDER #3798: PR Patty's one daily run, on the 3 HARO emails.
//
//   node jobs/patty_evening.js          fired every 15 minutes 16:00 to 18:15 CT
//   node jobs/patty_evening.js --dry    say what it would decide, run Patty dry, write nothing
//
// Each fire: if the switch is off, do nothing. If Patty already had her evening
// run today, do nothing. Otherwise count today's HARO editions in brain@: on the
// third, or at 6:15 PM CT with fewer, run Patty once and log it on the
// Producer's day log, so later fires see it. Read-only on Gmail. Never sends.
'use strict';

const E = require('../lib/patty-evening');

// How many HARO editions reached the inbox today. Read-only (gmail.readonly, GET).
async function countHaro({ ymd, env, fetchImpl, saKey, saToken }) {
  const sa = require('../lib/google-sa');
  const ma = require('../lib/mail-alerts');
  const key = saKey !== undefined ? saKey : sa.loadKey(env);
  if (!key) throw new Error('no Brain service-account key on this machine');
  const inbox = 'brain@infinityhospitality.net';
  const token = saToken ? await saToken(ma.SCOPE, inbox) : await sa.accessToken({ key, scopes: [ma.SCOPE], subject: inbox, fetchImpl });
  const client = ma.createClient({ token, fetchImpl });
  const ids = await client.find(E.haroQuery(ymd), 25);
  const subjects = [];
  for (const id of ids) subjects.push((await client.read(id)).subject);
  return E.countEditions(subjects);
}

async function main({ argv = process.argv.slice(2), env = process.env, log = console.log, now = () => new Date(),
  pool, store: given, llm, fetchImpl = globalThis.fetch, count = countHaro, runAgentImpl, saKey, saToken } = {}) {
  const dry = argv.includes('--dry');
  if (!E.eveningOn(env)) { log(`patty_evening: ${E.FLAG} is off; nothing run (Patty stays in the 06:00 run)`); return 0; }
  const at = now();
  const ymd = E.nashvilleYmd(at);
  const { createPgStore, createMemoryStore, ensureAgentTables } = require('../lib/agent-store');
  const { lint } = require('../lib/ai-tells');
  let store = given;
  if (!store) {
    if (dry) store = createMemoryStore({ lint });
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
  }
  const close = async () => { if (!given && pool === undefined && store.end) await store.end(); };
  const ranToday = E.ranTodayFrom(store.producerDay ? await store.producerDay(ymd) : []);
  let editions = 0;
  let countError = null;
  if (!ranToday) {
    try { editions = await count({ ymd, env, fetchImpl, saKey, saToken }); }
    catch (e) { countError = String(e.message || e).slice(0, 160); }
  }
  const d = E.decide({ now: at, editions, ranToday, countError });
  log(`patty_evening ${ymd} ${E.nashvilleHm(at)} CT: ${d.run ? 'RUN' : 'no run'} (${d.why})`);
  if (!d.run) { await close(); return 0; }
  let model = llm;
  if (model === undefined) {
    const k = require('../lib/agent-llm').textClientFromEnv();
    model = k.client;
    log(model ? `model ${model.model}; key from ${k.source}` : 'NO MODEL KEY: Patty will record measured sources only');
  }
  const run = runAgentImpl || require('../lib/agent-runner').runAgent;
  let r;
  try {
    r = await run({ slug: E.SLUG, store, llm: model, env, fetchImpl, log, dryRun: dry, scheduled: true, saKey, saToken });
  } catch (e) {
    r = { ok: false, error: String(e.message || e), cards: [], unavailable: [] };
  }
  const outcome = r.skipped ? `skipped (${r.skipped})` : r.blocked ? `waiting on ${r.blocked.join('; ')}`
    : r.ok ? `${r.cards.length} card(s)` : `FAILED ${r.error}`;
  log(`${E.SLUG}: ${outcome}`);
  if (dry) for (const c of [...(r.cards || []), ...(r.notices || [])]) log(`\n----- ${c.title} -----\n${c.body}\n`);
  // Once a day, ran or failed: the log row is what later fires check.
  if (!dry && store.producerLog) {
    const { weekStart } = require('../lib/producer');
    await store.producerLog({ ymd, week_start: weekStart(ymd), agent: E.SLUG, decision: 'ran',
      why: `${E.TAG}: ${d.why}; ${outcome}`, cards: (r.cards || []).length });
  }
  await close();
  return r.ok === false ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error('patty_evening:', e.message); process.exit(1); });
}

module.exports = { main, countHaro };
