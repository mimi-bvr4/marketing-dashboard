#!/usr/bin/env node
// ORDER #1624: what the photo index holds, READ-ONLY. The load card prints it
// before it writes anything and again after, so the numbers the order asks
// for come from the database, never from a guess:
//   - rows in photos (live and removed), photo_paths, photo_folders
//   - HALF-WRITTEN rows: a photos row with no photo_paths row (a run killed
//     between the two statements of one batch; the re-run fills it in)
//   - the last photo_crawl_runs rows, and any left without a finished_at
//   - the load in progress: N of M top folders done, from the checkpoint
//
//   MARKETING_DATABASE_URL=... node jobs/photo_load_status.js
//
// One READ ONLY transaction; nothing here can write.
'use strict';

const SQL = {
  tables: `SELECT to_regclass('photos') IS NOT NULL AS photos, to_regclass('photo_crawl_runs') IS NOT NULL AS runs`,
  counts: `SELECT (SELECT count(*) FROM photos)::int AS photos,
    (SELECT count(*) FROM photos WHERE removed_at IS NULL)::int AS live,
    (SELECT count(*) FROM photos WHERE thumb IS NOT NULL)::int AS thumbs,
    (SELECT count(*) FROM photo_paths)::int AS paths,
    (SELECT count(*) FROM photo_folders)::int AS folders,
    (SELECT count(*) FROM photos p WHERE NOT EXISTS (SELECT 1 FROM photo_paths pp WHERE pp.drive_id = p.drive_id))::int AS half_written`,
  runs: `SELECT id, mode, started_at, finished_at, seen, new, failed, (start_page_token IS NOT NULL) AS token_stored, detail
    FROM photo_crawl_runs ORDER BY id DESC LIMIT 200`,
};

// Where the resumable load stands, from the rows newest-first.
function progress(runsNewestFirst) {
  const rows = [...runsNewestFirst].reverse();
  const lastFull = rows.reduce((m, r) => (r.mode === 'apply' ? r.id : m), 0);
  const start = rows.find((r) => r.mode === 'apply-start' && r.id > lastFull);
  if (!start) return lastFull ? { state: 'complete', run: lastFull } : { state: 'not started' };
  const detail = typeof start.detail === 'string' ? JSON.parse(start.detail) : start.detail || {};
  const folders = detail.folders || [];
  const done = rows.filter((r) => r.mode === 'apply-folder' && r.id > start.id).length;
  return { state: 'in progress', done, total: folders.length };
}

async function status(pool, log = console.log) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const t = (await c.query(SQL.tables)).rows[0];
    if (!t.photos || !t.runs) { log('PHOTO TABLES: not created yet (no load has reached the database)'); return { tables: false }; }
    const n = (await c.query(SQL.counts)).rows[0];
    const runs = (await c.query(SQL.runs)).rows;
    log(`ROWS: photos ${n.photos} (live ${n.live}, thumbnails ${n.thumbs}), photo_paths ${n.paths}, photo_folders ${n.folders}`);
    log(`HALF-WRITTEN (a photo with no path row): ${n.half_written}`);
    log(`CRAWL RUNS: ${runs.length ? `${runs.length} rows, newest first` : 'none'}`);
    const when = (v, none) => {
      if (!v) return none;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
    };
    for (const r of runs.slice(0, 5)) {
      log(`  #${r.id} ${r.mode} started ${when(r.started_at, '-')} `
        + `finished ${when(r.finished_at, 'NEVER')} seen ${r.seen ?? '-'} new ${r.new ?? '-'} `
        + `failed ${r.failed ?? '-'} token ${r.token_stored ? 'stored' : 'none'}`);
    }
    const open = runs.filter((r) => !r.finished_at).length;
    log(`RUN ROWS WITHOUT A FINISH: ${open}`);
    const p = progress(runs);
    log(p.state === 'in progress' ? `LOAD: in progress, ${p.done} of ${p.total} top folders done`
      : p.state === 'complete' ? `LOAD: complete (run #${p.run})` : 'LOAD: not started');
    return { tables: true, counts: n, open, progress: p };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

if (require.main === module) {
  const { Pool } = require('pg');
  if (!process.env.MARKETING_DATABASE_URL) { console.error('photo_load_status: MARKETING_DATABASE_URL is not set'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  status(pool)
    .catch((e) => { console.error(`photo_load_status FAILED: ${e.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
}

module.exports = { status, progress, SQL };
