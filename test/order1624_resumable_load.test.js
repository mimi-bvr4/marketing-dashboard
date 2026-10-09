// ORDER #1624: the first load timed out at the approve runner's 30-minute cap.
// --apply --resume loads one top folder at a time with a checkpoint, writes in
// batches, and a re-run continues instead of starting over. Every fixture is
// invented; nothing here reaches Drive or a database.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/photo-archive');
const J = require('../jobs/photo_crawl');

const F = A.FOLDER_MIME;
const WIDTH = 29;   // COLS (26) + thumb, thumb_w, thumb_h

// A Postgres stand-in that keeps what is written and refuses what Postgres
// refuses: a plain INSERT of an existing key, and one ON CONFLICT statement
// touching the same key twice. `killAfter` photo statements, it throws the way
// a killed process stops: mid-load, with the earlier statements kept.
function fakeDb({ killAfter = Infinity } = {}) {
  const db = { photos: new Map(), paths: new Set(), folders: new Map(), runs: [], photoStatements: 0, killAfter };
  const keysOnce = (keys) => {
    if (new Set(keys).size !== keys.length) throw new Error('ON CONFLICT DO UPDATE command cannot affect row a second time');
  };
  db.query = async (sql, params = []) => {
    // Postgres refuses a statement whose placeholders and parameters disagree.
    const top = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    if (top !== params.length) throw new Error(`bind message supplies ${params.length} parameters, but the statement requires ${top}`);
    if (/^INSERT INTO photos /.test(sql)) {
      if (db.photoStatements >= db.killAfter) throw new Error('killed');
      db.photoStatements += 1;
      const rows = [];
      for (let i = 0; i < params.length; i += WIDTH) rows.push(params.slice(i, i + WIDTH));
      keysOnce(rows.map((r) => r[0]));
      for (const r of rows) {
        if (db.photos.has(r[0]) && !/ON CONFLICT \(drive_id\)/.test(sql)) throw new Error(`duplicate key ${r[0]}`);
        db.photos.set(r[0], { drive_id: r[0], folder_path: r[15], removed_at: null });
      }
      return { rows: [] };
    }
    if (/^INSERT INTO photo_paths/.test(sql)) {
      const keys = [];
      for (let i = 0; i < params.length; i += 3) keys.push(`${params[i]}\n${params[i + 2]}`);
      keysOnce(keys);
      keys.forEach((k) => db.paths.add(k));
      return { rows: [] };
    }
    if (/^INSERT INTO photo_folders/.test(sql)) {
      for (let i = 0; i < params.length; i += 2) db.folders.set(params[i], params[i + 1]);
      return { rows: [] };
    }
    if (/^INSERT INTO photo_crawl_runs/.test(sql)) {
      const id = db.runs.length + 1;
      if (/'apply-start'/.test(sql)) db.runs.push({ id, mode: 'apply-start', detail: JSON.parse(params[0]), start_page_token: null });
      else db.runs.push({ id, mode: params[0], seen: params[1], new: params[2], moved: params[3], removed: params[4],
        failed: params[5], images: params[6], videos: params[7], start_page_token: params[8], detail: JSON.parse(params[9]) });
      return { rows: [] };
    }
    if (/SELECT id, mode, detail FROM photo_crawl_runs/.test(sql)) {
      return { rows: db.runs.filter((r) => ['apply', 'apply-start', 'apply-folder'].includes(r.mode)) };
    }
    if (/SELECT start_page_token FROM photo_crawl_runs/.test(sql)) {
      return { rows: db.runs.filter((r) => r.start_page_token).slice(-1) };
    }
    if (/SELECT drive_id, folder_path FROM photos/.test(sql)) {
      const live = [...db.photos.values()].filter((r) => !r.removed_at);
      return { rows: params.length ? live.filter((r) => r.folder_path === params[0] || r.folder_path.startsWith(params[1])) : live };
    }
    if (/^UPDATE photos SET removed_at/.test(sql)) {
      for (const id of [].concat(params[0])) if (db.photos.has(id)) db.photos.get(id).removed_at = 'now';
      return { rows: [] };
    }
    return { rows: [] };   // the schema and the vocabulary seed
  };
  return db;
}

// Root: Alpha (3 files), Bravo (1,200 files in two sub-folders, one file in
// both), Charlie (2 files), and Staff Photos, which is never opened.
function fakeDrive({ tokens = ['tok-1', 'tok-LATE'] } = {}) {
  const img = (id, parent) => ({ id, name: `${id}.jpg`, mimeType: 'image/jpeg', md5Checksum: id, parents: [parent] });
  const kids = {
    [A.ROOT_FOLDER_ID]: [{ id: 'alpha', name: 'Alpha', mimeType: F }, { id: 'bravo', name: 'Bravo', mimeType: F },
      { id: 'charlie', name: 'Charlie', mimeType: F }, { id: 'staff', name: 'Staff Photos', mimeType: F }],
    alpha: [img('a1', 'alpha'), img('a2', 'alpha'), { id: 'av', name: 'clip.mp4', mimeType: 'video/mp4', parents: ['alpha'] }],
    bravo: [{ id: 'b-one', name: 'One', mimeType: F }, { id: 'b-two', name: 'Two', mimeType: F }],
    'b-one': Array.from({ length: 700 }, (_, i) => img(`b${i}`, 'b-one')),
    'b-two': [...Array.from({ length: 500 }, (_, i) => img(`b${700 + i}`, 'b-two')), img('b0', 'b-two')],
    charlie: [img('c1', 'charlie'), img('c2', 'charlie')],
    staff: [img('secret', 'staff')],
  };
  const listed = [];
  const handed = [...tokens];
  return {
    listed,
    serviceAccount: 'mock',
    listPage: async (p) => { const id = p.q.match(/'([^']+)'/)[1]; listed.push(id); return { files: kids[id] || [] }; },
    getFile: async () => ({ id: A.ROOT_FOLDER_ID, driveId: 'drv' }),
    startPageToken: async () => handed.shift(),
    thumbnail: async () => null,
  };
}

const RESUME = ['--apply', '--resume', '--no-thumbs'];
const quiet = () => {};

test('KNOWN-BAD: kill the load mid-run, re-run it, and get the same rows as one clean run, no duplicates', async () => {
  const clean = fakeDb();
  const r1 = await J.main({ argv: RESUME, client: fakeDrive(), pool: clean, log: quiet });
  assert.strictEqual(r1.complete, true);
  assert.strictEqual(clean.photos.size, 3 + 1200 + 2, 'b0 sits in two folders and is one row');

  // Alpha finishes and is recorded; Bravo dies after its first batch.
  const killed = fakeDb({ killAfter: 2 });
  await assert.rejects(J.main({ argv: RESUME, client: fakeDrive(), pool: killed, log: quiet }), /killed/);
  assert.deepStrictEqual(killed.runs.filter((r) => r.mode === 'apply-folder').map((r) => r.detail.folder), ['Alpha']);
  assert.ok(killed.photos.size > 3 && killed.photos.size < clean.photos.size, 'the kill left a half-loaded Bravo');

  killed.killAfter = Infinity;
  const again = fakeDrive();
  const lines = [];
  const r2 = await J.main({ argv: RESUME, client: again, pool: killed, log: (l) => lines.push(l) });
  assert.strictEqual(r2.complete, true);
  assert.strictEqual(killed.photos.size, clean.photos.size);
  assert.deepStrictEqual([...killed.photos.keys()].sort(), [...clean.photos.keys()].sort());
  assert.strictEqual(killed.paths.size, clean.paths.size);
  assert.ok(!again.listed.includes('alpha'), 'the finished folder is not walked again');
  assert.ok(lines.some((l) => /LOAD RESUMED: 1 of 3 top folders already loaded/.test(l)));
  assert.strictEqual(killed.runs.filter((r) => r.mode === 'apply-start').length, 1, 'one load, one start');
  assert.strictEqual(killed.runs.filter((r) => r.mode === 'apply').length, 1);
});

test('the changes-feed token is the one taken BEFORE the first walk, and --changes cannot use it until the load is done', async () => {
  const db = fakeDb();
  let t = 0;
  const now = () => t;
  const drive = fakeDrive();
  drive.listPage = ((base) => async (p) => { t += 60000; return base(p); })(drive.listPage);   // every list call is a minute
  const r = await J.main({ argv: [...RESUME, '--budget-min', '2'], client: drive, pool: db, log: quiet, now });
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.done, 1);
  await assert.rejects(J.main({ argv: ['--changes'], client: fakeDrive(), pool: db, log: quiet }), /run --apply once first/);

  const later = fakeDrive({ tokens: ['tok-LATE'] });
  const r2 = await J.main({ argv: RESUME, client: later, pool: db, log: quiet });
  assert.strictEqual(r2.complete, true);
  const full = db.runs.filter((x) => x.mode === 'apply');
  assert.strictEqual(full.length, 1);
  assert.strictEqual(full[0].start_page_token, 'tok-1');
  assert.strictEqual(full[0].seen, 3 + 1201 + 2, 'the sum of every folder, both runs');
});

test('the budget stops the run BETWEEN folders and says PARTIAL; it never starts a folder after the budget', async () => {
  const db = fakeDb();
  let t = 0;
  const drive = fakeDrive();
  drive.listPage = ((base) => async (p) => { t += 60000; return base(p); })(drive.listPage);
  const lines = [];
  const r = await J.main({ argv: [...RESUME, '--budget-min', '2'], client: drive, pool: db, log: (l) => lines.push(l), now: () => t });
  assert.deepStrictEqual(r, { complete: false, done: 1, total: 3 });
  assert.ok(lines.some((l) => /^PARTIAL: 1 of 3 top folders loaded/.test(l)));
  assert.ok(!drive.listed.includes('bravo'));
});

test('a refused changes feed still loads everything and stores no token (the 10.04 and 10.09 403)', async () => {
  const db = fakeDb();
  const drive = fakeDrive();
  drive.startPageToken = async () => { throw new Error('Drive 403: The attempted action requires shared drive membership.'); };
  const lines = [];
  const r = await J.main({ argv: RESUME, client: drive, pool: db, log: (l) => lines.push(l) });
  assert.strictEqual(r.complete, true);
  assert.strictEqual(db.runs.find((x) => x.mode === 'apply').start_page_token, null);
  assert.ok(lines.some((l) => /CHANGES FEED NOT READABLE/.test(l)));
  assert.ok(lines.some((l) => /token NOT stored/.test(l)));
});

test('Staff Photos is never opened by the resumable load', async () => {
  const drive = fakeDrive();
  await J.main({ argv: RESUME, client: drive, pool: fakeDb(), log: quiet });
  assert.ok(!drive.listed.includes('staff'));
});

test('rows go in batches of BATCH: 1,201 Bravo listings are 3 photo statements, not 1,201', async () => {
  const db = fakeDb();
  await J.main({ argv: RESUME, client: fakeDrive(), pool: db, log: quiet });
  // Alpha 1 statement, Bravo ceil(1201 / 500) = 3, Charlie 1.
  assert.strictEqual(J.BATCH, 500);
  assert.strictEqual(db.photoStatements, 5);
});

test('the batch statement is the single-row upsert with more VALUES rows', () => {
  const sql = J.upsertSql(2);
  assert.ok(sql.includes(`($1, $2`) && sql.includes(`$${WIDTH + 1}, $${WIDTH + 2}`));
  assert.ok(sql.includes(`$${2 * WIDTH}, now(), NULL)`));
  assert.strictEqual(sql.split('ON CONFLICT (drive_id) DO UPDATE SET')[1], J.UPSERT_SQL.split('ON CONFLICT (drive_id) DO UPDATE SET')[1]);
});

test('a folder emptied in Drive is marked removed on its own run, and only inside that folder', async () => {
  const db = fakeDb();
  await J.main({ argv: RESUME, client: fakeDrive(), pool: db, log: quiet });
  db.photos.set('gone', { drive_id: 'gone', folder_path: 'Charlie', removed_at: null });
  db.photos.set('elsewhere', { drive_id: 'elsewhere', folder_path: 'Charlies Other', removed_at: null });
  await J.main({ argv: RESUME, client: fakeDrive(), pool: db, log: quiet });
  assert.strictEqual(db.photos.get('gone').removed_at, 'now');
  assert.strictEqual(db.photos.get('elsewhere').removed_at, null, 'a folder whose name only starts the same is not touched');
});

// ------------------------------------------------------------ the walk

test('the concurrent walk finds the same files as the one-at-a-time walk', async () => {
  const one = await A.crawlTree(fakeDrive().listPage);
  const eight = await A.crawlTree(fakeDrive().listPage, A.ROOT_FOLDER_ID, { concurrency: 8 });
  const ids = (r) => r.files.map((f) => `${f.id}@${f.path.join('/')}`).sort();
  assert.deepStrictEqual(ids(eight), ids(one));
  assert.deepStrictEqual(eight.skipped, ['Staff Photos']);
});

test('basePath walks one top folder with its full path', async () => {
  const r = await A.crawlTree(fakeDrive().listPage, 'bravo', { basePath: ['Bravo'] });
  assert.deepStrictEqual([...new Set(r.files.map((f) => f.path.join(' / ')))].sort(), ['Bravo / One', 'Bravo / Two']);
});

test('a rate-limit refusal is retried; a plain refusal is not', async () => {
  const drive = fakeDrive();
  let left = 2;
  const flaky = async (p) => { if (p.q.includes("'charlie'") && left > 0) { left -= 1; throw new Error('Drive 429: Rate Limit Exceeded'); } return drive.listPage(p); };
  const r = await A.crawlTree(flaky, A.ROOT_FOLDER_ID, { retries: 3, backoffMs: 1 });
  assert.strictEqual(r.failed.length, 0);
  assert.ok(r.files.some((f) => f.id === 'c1'));

  const refused = async (p) => { if (p.q.includes("'charlie'")) throw new Error('Drive 404: File not found'); return drive.listPage(p); };
  const r2 = await A.crawlTree(refused, A.ROOT_FOLDER_ID, { retries: 3, backoffMs: 1 });
  assert.deepStrictEqual(r2.failed.map((f) => f.path), ['Charlie']);
});

test('--resume goes with --apply only; budget defaults to 20 minutes and concurrency to 8', () => {
  assert.throws(() => J.parseArgs(['--resume']), /goes with --apply/);
  assert.throws(() => J.parseArgs(['--changes', '--resume']), /goes with --apply/);
  const a = J.parseArgs(['--apply', '--resume']);
  assert.strictEqual(a.budgetMin, 20);
  assert.strictEqual(a.concurrency, 8);
  assert.strictEqual(J.parseArgs(['--apply']).concurrency, 1, 'the old full --apply walk is unchanged');
  assert.throws(() => J.parseArgs(['--apply', '--resume', '--budget-min', 'x']), /above 0/);
});
