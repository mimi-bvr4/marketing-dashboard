#!/usr/bin/env node
// ORDER #1239: the photo archive crawl. RUNS ON THE BOX, never on Railway.
//
//   node jobs/photo_crawl.js              same as --dry-run
//   node jobs/photo_crawl.js --dry-run    reads Drive, prints the counts, writes NOTHING
//   node jobs/photo_crawl.js --apply      full walk, upserts into the marketing DB
//   node jobs/photo_crawl.js --changes    the nightly mode: the Drive changes feed
//                                         from the stored start-page token
//   --no-thumbs                           (--apply / --changes) skip the =s400 fetch
//   --listing-out <file.json>             (--dry-run) save the media listing #1240's
//                                         sample is picked from; outside the synced tree
//   --resume                              (--apply, ORDER #1624) load one top folder at a
//                                         time, each recorded in photo_crawl_runs as it
//                                         finishes; a re-run skips the finished ones
//   --budget-min <n>                      (--resume) start no new top folder after n
//                                         minutes (default 20); the run ends PARTIAL
//   --concurrency <n>                     folders listed at once (default 1; --resume 8)
//
// --apply and --changes need MARKETING_DATABASE_URL in the environment. The
// dry run never opens a database connection at all.
//
// Drive is read-only forever: lib/drive-client.js asks for drive.readonly and
// only ever sends GETs. Staff Photos is never opened (photo-archive.crawlTree).
'use strict';

const A = require('../lib/photo-archive');
const { ensurePhotoTables } = require('../lib/photo-schema');
const { allChanges } = require('../lib/drive-client');
const { VENUES_DEFAULT } = require('../lib/photo-config');   // ORDER #1241: 'unknown' at launch

const kindOf = (mime) => (/^image\//.test(mime || '') ? 'image' : /^video\//.test(mime || '') ? 'video' : null);
const TOP_REPORTED = ['Venues', 'NLP', 'Culinary', 'Misc.'];

function parseArgs(argv) {
  const modes = ['--dry-run', '--apply', '--changes'].filter((m) => argv.includes(m));
  if (modes.length > 1) throw new Error(`pick one of ${modes.join(', ')}`);
  const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const mode = (modes[0] || '--dry-run').slice(2);
  const resume = argv.includes('--resume');
  if (resume && mode !== 'apply') throw new Error('--resume goes with --apply');
  const num = (flag, dflt) => {
    const v = val(flag);
    if (v == null) return dflt;
    const n = Number(v);
    if (!(n > 0)) throw new Error(`${flag} wants a number above 0, got ${v}`);
    return n;
  };
  return { mode, thumbs: !argv.includes('--no-thumbs'), listingOut: val('--listing-out'), resume,
    budgetMin: num('--budget-min', 20), concurrency: num('--concurrency', resume ? 8 : 1) };
}

// ------------------------------------------------------------- the report

// What the REPLY needs from a walk: totals by kind, every top folder and every
// Venues folder with its count (zero named), and the unparsed segments.
function summarize(run) {
  const totals = { files: run.files.length, images: 0, videos: 0, other: 0 };
  const top = {};
  const venues = {};
  for (const v of Object.keys(run.venueCounts)) venues[v] = 0;
  const unparsed = new Map();
  for (const f of run.files) {
    const kind = kindOf(f.mimeType);
    totals[kind ? `${kind}s` : 'other'] += 1;
    if (!kind) continue;
    const t = f.path[0] || '(root)';
    top[t] = (top[t] || 0) + 1;
    if (A.norm(f.path[0]) === 'venues' && f.path[1]) venues[f.path[1]] = (venues[f.path[1]] || 0) + 1;
    for (const u of A.parsePath(f.path).unparsed) {
      const key = `${u.depth}|${u.segment}`;
      const row = unparsed.get(key) || { depth: u.depth, segment: u.segment, why: u.why, files: 0, folders: new Set() };
      row.files += 1;
      row.folders.add(f.path.slice(0, u.depth + 1).join(' / '));
      unparsed.set(key, row);
    }
  }
  for (const t of TOP_REPORTED) if (!(t in top)) top[t] = 0;
  const failedUnder = (venue) => run.failed.filter((x) => x.path.startsWith(`Venues / ${venue}`)).length;
  return {
    totals, top, venues,
    venueFailures: Object.fromEntries(Object.keys(venues).map((v) => [v, failedUnder(v)])),
    unparsed: [...unparsed.values()]
      .map((r) => ({ depth: r.depth, segment: r.segment, why: r.why, files: r.files, folders: r.folders.size }))
      .sort((a, b) => b.files - a.files || a.segment.localeCompare(b.segment)),
    failed: run.failed, skipped: run.skipped,
  };
}

function printReport(s, log) {
  log(`TOTAL files seen: ${s.totals.files}  (images ${s.totals.images}, videos ${s.totals.videos}, other ${s.totals.other})`);
  log('TOP FOLDERS (images + videos):');
  for (const [t, n] of Object.entries(s.top)) log(`  ${t}: ${n}`);
  log(`SKIPPED, never opened: ${s.skipped.join(', ') || '(none)'}`);
  log('VENUES (images + videos; folders that failed to list beneath each):');
  for (const [v, n] of Object.entries(s.venues)) log(`  ${v}: ${n}  failed folders: ${s.venueFailures[v]}`);
  log(`FAILED folders: ${s.failed.length}`);
  for (const f of s.failed) log(`  ${f.path}: ${f.error}`);
  log(`UNPARSED segments: ${s.unparsed.length} distinct`);
  for (const u of s.unparsed) log(`  depth ${u.depth} | ${u.segment} | files ${u.files} | folders ${u.folders} | ${u.why}`);
}

// ------------------------------------------------------------- one row

function rowFor(file) {
  const p = A.parsePath(file.path);
  const img = file.imageMediaMetadata || {};
  const vid = file.videoMediaMetadata || {};
  const w = img.width || vid.width || null;
  const h = img.height || vid.height || null;
  const dealId = A.dealIdFrom([...file.path, file.name]);
  const rights = A.rightsFor({ topFolder: file.path[0], dealId, venuesDefault: VENUES_DEFAULT });
  return {
    drive_id: file.id, name: file.name, mime_type: file.mimeType, kind: kindOf(file.mimeType),
    size: file.size ? Number(file.size) : null, width: w, height: h, orientation: A.orientation(w, h),
    md5: file.md5Checksum || null, created_time: file.createdTime || null,
    ...A.dateFacets(img.time, file.createdTime),
    folder_path: file.path.join(' / '), brand: p.brand, venue: p.venue, space: p.space,
    event_type: p.event_type, event_class: p.event_class, setup: p.setup, guest_band: p.guest_band,
    deal_id: dealId, rights_state: rights.state, rights_reason: rights.reason, path_tags: p.path_tags,
  };
}

const COLS = ['drive_id', 'name', 'mime_type', 'kind', 'size', 'width', 'height', 'orientation', 'md5',
  'created_time', 'taken_date', 'taken_source', 'month', 'season', 'year', 'folder_path', 'brand', 'venue',
  'space', 'event_type', 'event_class', 'setup', 'guest_band', 'deal_id', 'rights_state', 'rights_reason'];

const UPSERT_SQL = `INSERT INTO photos (${COLS.join(', ')}, thumb, thumb_w, thumb_h, indexed_at, removed_at)
  VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}, $${COLS.length + 1}, $${COLS.length + 2}, $${COLS.length + 3}, now(), NULL)
  ON CONFLICT (drive_id) DO UPDATE SET
  ${COLS.slice(1).filter((c) => !c.startsWith('rights_')).map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
  rights_state = CASE WHEN photos.manual_internal THEN photos.rights_state ELSE EXCLUDED.rights_state END,
  rights_reason = CASE WHEN photos.manual_internal THEN photos.rights_reason ELSE EXCLUDED.rights_reason END,
  thumb = COALESCE(EXCLUDED.thumb, photos.thumb), thumb_w = COALESCE(EXCLUDED.thumb_w, photos.thumb_w),
  thumb_h = COALESCE(EXCLUDED.thumb_h, photos.thumb_h), indexed_at = now(), removed_at = NULL`;

// ORDER #1624: rows go in BATCH at a time, one statement each. One statement is
// all-or-nothing, so a run killed mid-load leaves whole batches, and every
// statement upserts on its key, so a re-run lands on the same rows.
const BATCH = 500;
const placeholders = (n, width, extra = '') => Array.from({ length: n }, (_, r) =>
  `(${Array.from({ length: width }, (__, c) => `$${r * width + c + 1}`).join(', ')}${extra})`).join(',\n  ');
const upsertSql = (n) => UPSERT_SQL.replace(/VALUES \([^\n]*\)\n/, () => `VALUES ${placeholders(n, COLS.length + 3, ', now(), NULL')}\n`);
const PATHS_SQL = (n) => `INSERT INTO photo_paths (drive_id, md5, path) VALUES ${placeholders(n, 3)}
  ON CONFLICT (drive_id, path) DO UPDATE SET md5 = EXCLUDED.md5, seen_at = now()`;
const FOLDERS_SQL = (n) => `INSERT INTO photo_folders (drive_id, path) VALUES ${placeholders(n, 2)}
  ON CONFLICT (drive_id) DO UPDATE SET path = EXCLUDED.path, seen_at = now()`;

// A file with two parents is listed twice. One statement may not upsert the
// same key twice, so the last listing of each key wins.
const lastBy = (items, key) => [...new Map(items.map((x) => [key(x), x])).values()];

async function upsertFiles(pool, client, files, { thumbs }) {
  const rows = [];
  for (const file of files) {
    const row = rowFor(file);
    if (!row.kind) continue;
    let t = null;
    if (thumbs) {
      try { t = await client.thumbnail(file); } catch (_) { t = null; }  // a missing thumbnail never blocks the row
    }
    rows.push({ row, t });
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const photos = lastBy(chunk, (x) => x.row.drive_id);
    await pool.query(upsertSql(photos.length), photos.flatMap(({ row, t }) =>
      [...COLS.map((c) => row[c]), t ? t.bytes : null, t ? t.w : null, t ? t.h : null]));
    const paths = lastBy(chunk, (x) => `${x.row.drive_id}\n${x.row.folder_path}`);
    await pool.query(PATHS_SQL(paths.length), paths.flatMap(({ row }) => [row.drive_id, row.md5, row.folder_path]));
  }
  // No photo_tags rows here. An unparsed path segment is often an event album
  // named for the couple (measured 10.04.2026: 820 such folders), and #1008
  // bans client names from tags. Tagging is #1240's, and it decides which
  // segments may become tags.
  return rows.length;
}

const upsertFile = async (pool, client, file, opts) => (await upsertFiles(pool, client, [file], opts)) > 0;

async function rememberFolders(pool, files) {
  const seen = new Map();
  for (const f of files) if (f.parents && f.parents[0]) seen.set(f.parents[0], f.path.join(' / '));
  const all = [...seen];
  for (let i = 0; i < all.length; i += BATCH) {
    const chunk = all.slice(i, i + BATCH);
    await pool.query(FOLDERS_SQL(chunk.length), chunk.flat());
  }
}

async function recordRun(pool, mode, counts, extra) {
  await pool.query(`INSERT INTO photo_crawl_runs (mode, finished_at, seen, new, moved, removed, failed, images, videos, start_page_token, detail)
    VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [mode, counts.seen, counts.new, counts.moved, counts.removed, counts.failed, counts.images, counts.videos,
    extra.startPageToken, JSON.stringify(extra.detail || {})]);
}

// ------------------------------------------------------------- the modes

async function dryRun({ client, log, listingOut, concurrency = 1 }) {
  const t0 = Date.now();
  const run = await A.crawlTree(client.listPage, A.ROOT_FOLDER_ID, { concurrency, retries: concurrency > 1 ? 3 : 0 });
  const s = summarize(run);
  printReport(s, log);
  log(`WALK took ${Math.round((Date.now() - t0) / 1000)} s at concurrency ${concurrency}`);
  // #1240's sample is picked from this. Paths carry client names: write it
  // outside the synced tree, and never commit it.
  if (listingOut) {
    const keep = run.files.filter((f) => kindOf(f.mimeType))
      .map((f) => ({ id: f.id, mimeType: f.mimeType, thumbnailLink: f.thumbnailLink, path: f.path }));
    require('fs').writeFileSync(listingOut, JSON.stringify(keep));
    log(`LISTING: ${keep.length} media files written to ${listingOut}`);
  }
  // Measured, not assumed: can this account read the changes feed the nightly mode needs?
  try {
    const root = await client.getFile(A.ROOT_FOLDER_ID, 'id, driveId');
    const tok = await client.startPageToken(root.driveId);
    log(`CHANGES FEED: readable (shared drive ${root.driveId ? 'id present' : 'id absent'}, start token ${tok ? 'issued' : 'NOT issued'})`);
  } catch (e) {
    log(`CHANGES FEED: NOT readable: ${e.message}`);
  }
  return s;
}

async function applyFull({ client, pool, log, thumbs }) {
  await ensurePhotoTables(pool);
  const root = await client.getFile(A.ROOT_FOLDER_ID, 'id, driveId');
  // BEFORE the walk: nothing changed during it is missed. Measured 10.04.2026:
  // Drive refuses this (403, "requires shared drive membership") while the
  // service account is only on the folder. The load still goes ahead; it stores
  // no token, and --changes then refuses until a later --apply stores one.
  let startPageToken = null;
  try { startPageToken = await client.startPageToken(root.driveId); } catch (e) {
    log(`CHANGES FEED NOT READABLE, no start token stored: ${e.message}`);
  }
  const run = await A.crawlTree(client.listPage);
  const s = summarize(run);
  printReport(s, log);
  const prev = (await pool.query('SELECT drive_id, folder_path FROM photos WHERE removed_at IS NULL')).rows
    .map((r) => ({ id: r.drive_id, path: r.folder_path.split(' / ') }));
  const media = run.files.filter((f) => kindOf(f.mimeType));
  const { counts, removed } = A.diffIndex(prev, media);
  await upsertFiles(pool, client, media, { thumbs });
  await rememberFolders(pool, media);
  // A folder that failed to list would look like every file in it was deleted.
  // So removals only happen on a walk with no failures.
  if (run.failed.length) { counts.removed = 0; log(`REMOVALS SKIPPED: ${run.failed.length} folder(s) failed to list`); }
  else for (const id of removed) await pool.query('UPDATE photos SET removed_at = now() WHERE drive_id = $1 AND removed_at IS NULL', [id]);
  counts.failed = run.failed.length;
  await recordRun(pool, 'apply', { ...counts, images: s.totals.images, videos: s.totals.videos },
    { startPageToken, detail: { top: s.top, venues: s.venues, unparsed: s.unparsed.length } });
  log(`APPLIED: seen ${counts.seen}, new ${counts.new}, moved ${counts.moved}, removed ${counts.removed}, failed ${counts.failed}`);
  return { summary: s, counts };
}

// ORDER #1624: the first load timed out at the approve runner's 30-minute cap
// with nothing to show for it. This walks and writes ONE TOP FOLDER at a time.
// photo_crawl_runs is the checkpoint, so it lives where the rows do:
//   'apply-start'   one per load: the folder list, and the changes-feed token
//                   taken BEFORE the first walk (kept in detail, not in the
//                   start_page_token column, so --changes cannot start from a
//                   half-done load)
//   'apply-folder'  one per finished top folder, with its counts
//   'apply'         when every folder is done: the sums, and the token moved
//                   into start_page_token, where --changes reads it
// A run killed mid-folder records nothing for that folder; the re-run walks it
// again and upserts the same keys. No new top folder starts after `budgetMin`.
async function applyResume({ client, pool, log, thumbs, budgetMin = 20, concurrency = 8, now = Date.now }) {
  const t0 = now();
  await ensurePhotoTables(pool);
  const runs = (await pool.query(`SELECT id, mode, detail FROM photo_crawl_runs
    WHERE mode IN ('apply', 'apply-start', 'apply-folder') ORDER BY id`)).rows;
  const lastFull = runs.reduce((m, r) => (r.mode === 'apply' ? r.id : m), 0);
  const open = runs.filter((r) => r.id > lastFull);
  let start = open.find((r) => r.mode === 'apply-start');
  const doneRows = open.filter((r) => r.mode === 'apply-folder' && (!start || r.id > start.id));

  const top = await A.listAll(client.listPage, { q: `'${A.ROOT_FOLDER_ID}' in parents and trashed = false` });
  const folders = top.filter((c) => c.mimeType === A.FOLDER_MIME && !A.EXCLUDED_TOP.includes(A.norm(c.name)));
  const loose = top.filter((c) => c.mimeType !== A.FOLDER_MIME && kindOf(c.mimeType)).map((c) => ({ ...c, path: [] }));

  if (!start) {
    const root = await client.getFile(A.ROOT_FOLDER_ID, 'id, driveId');
    let token = null;
    try { token = await client.startPageToken(root.driveId); } catch (e) {
      log(`CHANGES FEED NOT READABLE, no start token stored: ${e.message}`);
    }
    if (token) log('CHANGES FEED: start token issued, kept for the end of the load');
    await pool.query(`INSERT INTO photo_crawl_runs (mode, finished_at, detail) VALUES ('apply-start', now(), $1)`,
      [JSON.stringify({ start_token: token, folders: folders.map((f) => f.name) })]);
    start = { detail: { start_token: token } };
    log(`LOAD STARTED: ${folders.length} top folders`);
  } else {
    log(`LOAD RESUMED: ${doneRows.length} of ${folders.length} top folders already loaded`);
  }
  const detailOf = (r) => (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail || {});
  const done = new Set(doneRows.map((r) => detailOf(r).folder));
  const tally = doneRows.map((r) => ({ ...r }));

  if (loose.length) await upsertFiles(pool, client, loose, { thumbs });   // files sitting in the root itself

  let stopped = null;
  for (const f of folders) {
    if (done.has(f.name)) continue;
    const mins = (now() - t0) / 60000;
    if (mins >= budgetMin) { stopped = f.name; break; }
    const run = await A.crawlTree(client.listPage, f.id, { basePath: [f.name], concurrency, retries: 3 });
    const media = run.files.filter((x) => kindOf(x.mimeType));
    const prev = (await pool.query(`SELECT drive_id, folder_path FROM photos WHERE removed_at IS NULL
      AND (folder_path = $1 OR left(folder_path, length($2)) = $2)`, [f.name, `${f.name} / `])).rows
      .map((r) => ({ id: r.drive_id, path: r.folder_path.split(' / ') }));
    const { counts, removed } = A.diffIndex(prev, media);
    await upsertFiles(pool, client, media, { thumbs });
    await rememberFolders(pool, media);
    if (run.failed.length) { counts.removed = 0; log(`REMOVALS SKIPPED in ${f.name}: ${run.failed.length} folder(s) failed to list`); }
    else {
      for (let i = 0; i < removed.length; i += BATCH) {
        await pool.query('UPDATE photos SET removed_at = now() WHERE drive_id = ANY($1) AND removed_at IS NULL', [removed.slice(i, i + BATCH)]);
      }
    }
    counts.failed = run.failed.length;
    const images = media.filter((x) => kindOf(x.mimeType) === 'image').length;
    const row = { ...counts, images, videos: media.length - images };
    await recordRun(pool, 'apply-folder', row, { startPageToken: null, detail: { folder: f.name } });
    tally.push(row);
    done.add(f.name);
    log(`FOLDER ${done.size} of ${folders.length} loaded: ${f.name}: seen ${counts.seen}, new ${counts.new}, removed ${counts.removed}, failed ${counts.failed}`);
  }

  if (stopped) {
    log(`PARTIAL: ${done.size} of ${folders.length} top folders loaded (budget ${budgetMin} min reached before ${stopped}). Re-run --apply --resume to continue.`);
    return { complete: false, done: done.size, total: folders.length };
  }
  const sum = (k) => tally.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const totals = { seen: sum('seen') + loose.length, new: sum('new'), moved: sum('moved'), removed: sum('removed'),
    failed: sum('failed'), images: sum('images'), videos: sum('videos') };
  const token = detailOf(start).start_token || null;
  await recordRun(pool, 'apply', totals, { startPageToken: token, detail: { resumed: true, folders: folders.length } });
  log(`APPLIED: seen ${totals.seen}, new ${totals.new}, moved ${totals.moved}, removed ${totals.removed}, failed ${totals.failed}`);
  log(`LOAD COMPLETE: ${folders.length} of ${folders.length} top folders; changes-feed token ${token ? 'stored' : 'NOT stored'}`);
  return { complete: true, done: folders.length, total: folders.length, counts: totals };
}

async function applyChanges({ client, pool, log, thumbs }) {
  await ensurePhotoTables(pool);
  const last = (await pool.query(`SELECT start_page_token FROM photo_crawl_runs
    WHERE start_page_token IS NOT NULL ORDER BY id DESC LIMIT 1`)).rows[0];
  if (!last) throw new Error('no stored start-page token: run --apply once first');
  const root = await client.getFile(A.ROOT_FOLDER_ID, 'id, driveId');
  const { changes, newStartPageToken } = await allChanges(client, last.start_page_token, root.driveId);
  const folders = new Map((await pool.query('SELECT drive_id, path FROM photo_folders')).rows.map((r) => [r.drive_id, r.path]));
  const counts = { seen: changes.length, new: 0, moved: 0, removed: 0, failed: 0, images: 0, videos: 0 };
  for (const ch of changes) {
    const id = ch.fileId || (ch.file && ch.file.id);
    const indexed = (await pool.query('SELECT folder_path FROM photos WHERE drive_id = $1 AND removed_at IS NULL', [id])).rows[0];
    const action = A.changeAction(ch, !!indexed);
    if (action === 'remove') {
      await pool.query('UPDATE photos SET removed_at = now() WHERE drive_id = $1 AND removed_at IS NULL', [id]);
      counts.removed += 1;
      continue;
    }
    if (action === 'ignore') continue;
    const parent = ch.file.parents && ch.file.parents[0];
    if (!folders.has(parent) && !(parent === A.ROOT_FOLDER_ID)) {
      if (indexed) { await pool.query('UPDATE photos SET removed_at = now() WHERE drive_id = $1', [id]); counts.removed += 1; }
      continue;                                    // outside the archive, or moved out of it
    }
    const base = parent === A.ROOT_FOLDER_ID ? [] : folders.get(parent).split(' / ');
    if (action === 'rewalk') {
      if (base.length === 0 && A.norm(ch.file.name) === 'staff photos') continue;   // never opened
      try {
        const sub = await A.crawlTree(client.listPage, ch.file.id);
        const files = sub.files.filter((f) => kindOf(f.mimeType)).map((f) => ({ ...f, path: [...base, ch.file.name, ...f.path] }));
        counts.new += await upsertFiles(pool, client, files, { thumbs });
        await rememberFolders(pool, files);
        counts.failed += sub.failed.length;
      } catch (e) { counts.failed += 1; log(`REWALK FAILED for one folder: ${e.message}`); }
      continue;
    }
    const file = { ...ch.file, path: base };
    if (await upsertFile(pool, client, file, { thumbs })) {
      if (!indexed) counts.new += 1;
      else if (indexed.folder_path !== base.join(' / ')) counts.moved += 1;
      counts[`${kindOf(file.mimeType)}s`] += 1;
    }
  }
  await recordRun(pool, 'changes', counts, { startPageToken: newStartPageToken });
  log(`CHANGES: seen ${counts.seen}, new ${counts.new}, moved ${counts.moved}, removed ${counts.removed}, failed ${counts.failed}`);
  return { counts, newStartPageToken };
}

// `client` and `pool` are handed in so a test can run every mode with mocks.
// The dry run is never given a pool and never asks for one.
async function main({ argv = process.argv.slice(2), client, pool, makePool, log = console.log, now = Date.now } = {}) {
  const { mode, thumbs, listingOut, resume, budgetMin, concurrency } = parseArgs(argv);
  log(`photo_crawl ${mode}${resume ? ' --resume' : ''} as ${client.serviceAccount || '(mock)'}; scopes: ${A.DRIVE_SCOPES.join(' ')}`);
  if (mode === 'dry-run') return dryRun({ client, log, listingOut, concurrency });
  const db = pool || (makePool && makePool());
  if (!db) throw new Error(`--${mode} needs MARKETING_DATABASE_URL`);
  if (mode === 'apply' && resume) return applyResume({ client, pool: db, log, thumbs, budgetMin, concurrency, now });
  return mode === 'apply' ? applyFull({ client, pool: db, log, thumbs }) : applyChanges({ client, pool: db, log, thumbs });
}

if (require.main === module) {
  const { createDriveClient } = require('../lib/drive-client');
  const makePool = () => {
    if (!process.env.MARKETING_DATABASE_URL) return null;
    const { Pool } = require('pg');
    return new Pool({ connectionString: process.env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  };
  let pool = null;
  main({ client: createDriveClient(), makePool: () => (pool = makePool()) })
    .then(() => (pool ? pool.end() : null))
    .catch((e) => { console.error(`photo_crawl FAILED: ${e.message}`); process.exitCode = 1; if (pool) pool.end(); });
}

module.exports = { main, summarize, rowFor, parseArgs, UPSERT_SQL, kindOf, BATCH, upsertSql };
