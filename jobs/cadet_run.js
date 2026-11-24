#!/usr/bin/env node
// ORDER #1688: the Collateral Cadet's Box step, run every 15 minutes by
// agents_handoff.sh. Reads Katherine's Collateral Map (with each cell's link)
// into cadet_map, then runs the searches waiting in cadet_asks and stores each
// answer. Read-only everywhere it looks: Drive through the drive.readonly
// client, websites as public pages. Writes only the two cadet_* tables.
'use strict';

const { readMap, parseMap, summarize } = require('../lib/collateral-map');
const { search } = require('../lib/cadet-search');

// `canva` (#3622): the Canva reader (lib/canva.js), only while CADET_CANVA_READ is
// on. The waiting searches read first; what is left of its budget then reads the
// Canva materials checked longest ago, so all 114 are read within a few runs.
async function runOnce({ store, drive, fetch = globalThis.fetch, log = console.log, canva = null }) {
  let materials = [];
  try {
    const tabs = await readMap(drive);
    materials = parseMap(tabs).materials;
    const summary = summarize(materials);
    await store.saveMap({ materials, summary });
    log(`map: ${summary.total} titles, ${summary.linked} with a link (Drive ${summary.by.drive}, Canva ${summary.by.canva}, other ${summary.by.other})`);
  } catch (e) {
    const last = await store.map();
    materials = last ? last.materials : [];
    log(`map: NOT READ (${e.message}); using the last read (${materials.length} titles)`);
  }
  const asks = await store.takeAsks(3);
  for (const a of asks) {
    try {
      const r = await search({ phrase: a.phrase, materials, drive, fetch, canva });
      if (r.error) { await store.finishAsk(a.id, { error: r.error }); log(`search ${a.id}: refused, ${r.error}`); continue; }
      await store.finishAsk(a.id, { result: r });
      const t = r.tally;
      log(`search ${a.id} "${a.phrase}" (${a.asked_by}): materials found ${t.materials.found}, not found ${t.materials.not_found}, not checked ${t.materials.not_checked}; sites found ${t.sites.found}, not found ${t.sites.not_found}, not checked ${t.sites.not_checked}`);
    } catch (e) {
      await store.finishAsk(a.id, { error: e.message });
      log(`search ${a.id}: FAILED ${e.message}`);
    }
  }
  log(`cadet: ${asks.length} search(es) run`);
  if (canva) {
    try { const p = await canva.prime(materials); log(`canva: ${p.read} design(s) checked this run`); }
    catch (e) { log(`canva: read pass FAILED ${e.message}`); }
  }
  return asks.length;
}

async function main({ env = process.env, log = console.log } = {}) {
  if (!env.MARKETING_DATABASE_URL) { log('NOT RUN: MARKETING_DATABASE_URL is not set'); return 3; }
  const { Pool } = require('pg');
  const { createPgStore, ensureCadetTables } = require('../lib/cadet-store');
  const { createDriveClient } = require('../lib/drive-client');
  const pool = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await ensureCadetTables(pool);
    // #3622: a brain@ Canva sign-in parked on the dashboard is traded here (switch
    // or not, so the sign-in can come before the flip); the read needs the switch.
    const C = require('../lib/canva');
    // #3625: first, the Box hands the dashboard the (non-secret) client id from its Keychain.
    try { await C.ensureCanvaTables(pool); const cx = C.createPgConnects(pool); await C.publishClientId({ connects: cx, log }); await C.tradeCodes({ connects: cx, log }); }
    catch (e) { log(`canva connect: NOT RUN (${e.message})`); }
    const canva = C.readOn(env) ? C.createReader({ budget: 20, log }) : null;
    await runOnce({ store: createPgStore(pool), drive: createDriveClient(), log, canva });
    return 0;
  } finally { await pool.end(); }
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('cadet_run:', e.message); process.exit(1); });

module.exports = { runOnce, main };
