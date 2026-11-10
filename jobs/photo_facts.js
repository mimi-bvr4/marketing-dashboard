#!/usr/bin/env node
// ORDER #3085 step 2: the camera-clock facts for photos indexed before the
// crawl kept the time of day. RUNS ON THE BOX, never on Railway. No model.
//
//   node jobs/photo_facts.js --count                 how many photos still need asking (read-only)
//   node jobs/photo_facts.js --apply [--budget-min 30] [--concurrency 8]
//        asks Drive (read-only, one GET per photo) for imageMediaMetadata.time
//        on every photo whose EXIF date was stored without its time, newest
//        first, and writes taken_time and day_part (lib/photo-facts.js).
//
// Why Drive and not the bytes: the stored thumbnail is Drive's =s400 copy and
// carries no EXIF, and no job on the Box downloads an original (#1008 LAW:
// originals stay in Drive). The #1239 crawl already asks Drive for
// imageMediaMetadata(time) and kept only the date; from #3085 the crawl keeps
// the time too, so this backfill only drains the rows loaded before it.
//
// Gated like every photo job (#1797): the bonus window and the usage state are
// asked before each batch. A Drive 403 stops the run and stamps nothing (#1788).
// Needs MARKETING_DATABASE_URL.
'use strict';

const F = require('../lib/photo-facts');
const { ensurePhotoTables } = require('../lib/photo-schema');

const QUEUE_WHERE = `removed_at IS NULL AND kind = 'image' AND taken_source = 'exif'
  AND taken_time IS NULL AND facts_at IS NULL AND folder_path NOT ILIKE 'staff photos%'`;
const QUEUE_SQL = `SELECT drive_id FROM photos WHERE ${QUEUE_WHERE}
  ORDER BY taken_date DESC NULLS LAST, drive_id LIMIT $1`;
const COUNT_SQL = `SELECT count(*)::int AS n FROM photos WHERE ${QUEUE_WHERE}`;
const SET_SQL = 'UPDATE photos SET taken_time = $2, day_part = $3, facts_at = now() WHERE drive_id = $1';
const PARTS_SQL = `SELECT coalesce(day_part, '(none)') AS day_part, count(*)::int AS n FROM photos
  WHERE removed_at IS NULL AND kind = 'image' GROUP BY 1 ORDER BY 2 DESC`;

function parseArgs(argv) {
  const modes = ['--count', '--apply'].filter((m) => argv.includes(m));
  if (modes.length !== 1) throw new Error('pick one of --count, --apply');
  const num = (flag, dflt) => {
    const i = argv.indexOf(flag);
    if (i < 0) return dflt;
    const n = Number(argv[i + 1]);
    if (!(n > 0)) throw new Error(`${flag} wants a number above 0`);
    return n;
  };
  return { mode: modes[0].slice(2), budgetMin: num('--budget-min', 30), concurrency: num('--concurrency', 8) };
}

async function backfillFacts({ client, pool, log = console.log, budgetMin = 30, concurrency = 8, batch = 200,
  now = Date.now, gate = () => null }) {
  await ensurePhotoTables(pool);
  const stopAt = now() + budgetMin * 60000;
  const c = { asked: 0, withTime: 0, noTime: 0, failed: 0 };
  const parts = { day: 0, dusk: 0, night: 0 };
  let stopped = null;
  let paused = null;
  const failedIds = new Set();
  while (!stopped && now() < stopAt) {
    paused = gate();
    if (paused) break;
    const ids = (await pool.query(QUEUE_SQL, [batch + failedIds.size])).rows.map((r) => r.drive_id)
      .filter((id) => !failedIds.has(id));
    if (!ids.length) break;
    for (let i = 0; i < ids.length && !stopped && now() < stopAt; i += concurrency) {
      await Promise.all(ids.slice(i, i + concurrency).map(async (id) => {
        if (stopped) return;
        try {
          const file = await client.getFile(id, 'id, imageMediaMetadata(time)');
          const time = file && file.imageMediaMetadata && file.imageMediaMetadata.time;
          const f = F.factsFor({ time });
          await pool.query(SET_SQL, [id, f.taken_time, f.day_part]);
          c.asked += 1;
          if (f.taken_time) { c.withTime += 1; if (f.day_part) parts[f.day_part] += 1; } else c.noTime += 1;
        } catch (e) {
          if (/Drive 403/.test(e.message)) { stopped = stopped || e.message; return; }
          // Deleted from Drive since the index: stamp it so the queue moves on.
          if (/Drive 404/.test(e.message)) { await pool.query(SET_SQL, [id, null, null]); c.noTime += 1; return; }
          c.failed += 1;
          failedIds.add(id);
        }
      }));
    }
  }
  const left = (await pool.query(COUNT_SQL)).rows[0].n;
  if (stopped) log(`FACTS STOPPED: Drive refused (${stopped}). Nothing more was stamped; the next run starts where this one stopped.`);
  if (paused) log(`FACTS PAUSED: ${paused}. The next window starts where this one stopped.`);
  log(`FACTS: asked ${c.asked}, with a clock ${c.withTime} (day ${parts.day}, dusk ${parts.dusk}, night ${parts.night}), `
    + `no clock ${c.noTime}, failed ${c.failed}, still to ask ${left}`);
  return { ...c, parts, left, stopped, paused };
}

async function main({ argv = process.argv.slice(2), client, pool, makePool, log = console.log, now = Date.now, gate } = {}) {
  const args = parseArgs(argv);
  const db = pool || (makePool && makePool());
  if (!db) throw new Error(`--${args.mode} needs MARKETING_DATABASE_URL`);
  if (args.mode === 'count') {
    const n = (await db.query(COUNT_SQL)).rows[0].n;
    const byPart = (await db.query(PARTS_SQL)).rows;
    log(`FACTS TO ASK: ${n}`);
    log(`DAY PARTS NOW: ${byPart.map((r) => `${r.day_part} ${r.n}`).join(', ')}`);
    return { left: n, byPart };
  }
  return backfillFacts({ client, pool: db, log, budgetMin: args.budgetMin, concurrency: args.concurrency, now, gate });
}

if (require.main === module) {
  const makePool = () => {
    if (!process.env.MARKETING_DATABASE_URL) return null;
    const { Pool } = require('pg');
    return new Pool({ connectionString: process.env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  };
  let pool = null;
  const argv = process.argv.slice(2);
  const client = argv.includes('--apply') ? require('../lib/drive-client').createDriveClient() : null;
  main({ argv, client, makePool: () => (pool = makePool()), gate: require('../lib/photo-window').photoGate() })
    .then((r) => { if (r && r.stopped) process.exitCode = 2; return pool ? pool.end() : null; })
    .catch((e) => { console.error(`photo_facts FAILED: ${e.message}`); process.exitCode = 1; if (pool) pool.end(); });
}

module.exports = { main, parseArgs, backfillFacts, QUEUE_SQL, COUNT_SQL, SET_SQL };
