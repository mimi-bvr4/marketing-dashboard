// ORDER #1239: the Drive client, the schema and the crawl job. Every fixture is
// invented; nothing here reaches Drive or a database.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const A = require('../lib/photo-archive');
const D = require('../lib/drive-client');
const S = require('../lib/photo-schema');
const J = require('../jobs/photo_crawl');

const F = A.FOLDER_MIME;
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { client_email: 'test@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

// A fetch that answers the token endpoint and records every other URL.
function fakeFetch(answer = () => ({ files: [] })) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    if (String(url) === D.TOKEN_URL) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    const body = answer(String(url));
    return { ok: true, json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.alloc(0)) };
  };
  return { fetchImpl, calls };
}

// A pool that records every statement and answers from `answers(sql, params)`.
function mockPool(answers = () => []) {
  const queries = [];
  return { queries, query: async (sql, params) => { queries.push({ sql, params }); return { rows: answers(sql, params) || [] }; } };
}

// ------------------------------------------------------------ the Drive client

test('LAW: the JWT asks for drive.readonly and nothing else (Amendment A)', async () => {
  const f = fakeFetch();
  const c = D.createDriveClient({ key: KEY, fetchImpl: f.fetchImpl });
  await c.listPage({ q: 'x' });
  const assertion = new URLSearchParams(f.calls[0].body).get('assertion');
  assert.strictEqual(D.decodeClaims(assertion).scope, 'https://www.googleapis.com/auth/drive.readonly');
});

test('LAW: only GETs ever reach Drive', async () => {
  const f = fakeFetch((u) => (u.includes('startPageToken') ? { startPageToken: '1' } : { files: [], newStartPageToken: '2' }));
  const c = D.createDriveClient({ key: KEY, fetchImpl: f.fetchImpl });
  await c.listPage({ q: 'x' });
  await c.getFile('id');
  await c.startPageToken('d');
  await c.changesPage('1', 'd');
  for (const call of f.calls.filter((x) => x.url !== D.TOKEN_URL)) assert.strictEqual(call.method, 'GET', call.url);
});

test('LAW: the real client through listAll reads the SECOND page with both shared-drive flags (Amendment B)', async () => {
  const f = fakeFetch((u) => (new URL(u).searchParams.get('pageToken') === 'p2'
    ? { files: [{ id: 'SWF' }] } : { files: [{ id: 'TBT' }], nextPageToken: 'p2' }));
  const c = D.createDriveClient({ key: KEY, fetchImpl: f.fetchImpl });
  const files = await A.listAll(c.listPage, { q: "'root' in parents" });
  assert.deepStrictEqual(files.map((x) => x.id), ['TBT', 'SWF']);
  const lists = f.calls.filter((x) => x.url.includes('/files?')).map((x) => new URL(x.url).searchParams);
  assert.strictEqual(lists.length, 2);
  for (const p of lists) {
    assert.strictEqual(p.get('supportsAllDrives'), 'true');
    assert.strictEqual(p.get('includeItemsFromAllDrives'), 'true');
  }
});

test('LAW: a thumbnail is fetched at =s400 and never with alt=media', async () => {
  const f = fakeFetch(() => Buffer.from('jpeg bytes'));
  const c = D.createDriveClient({ key: KEY, fetchImpl: f.fetchImpl });
  await c.thumbnail({ id: 'p1', thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/abc=s220' });
  const urls = f.calls.filter((x) => x.url !== D.TOKEN_URL).map((x) => x.url);
  assert.deepStrictEqual(urls, ['https://lh3.googleusercontent.com/drive-storage/abc=s400']);
  assert.ok(!urls.some((u) => /alt=media/.test(u)));
  assert.throws(() => D.thumbUrl('https://www.googleapis.com/drive/v3/files/p1?alt=media'), /refused/);
});

test('jpegSize reads width and height from the SOF marker', () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0x2c, 0x01, 0x90, 3, 0, 0]);
  assert.deepStrictEqual(D.jpegSize(buf), { h: 300, w: 400 });
});

// ------------------------------------------------------------ the schema

// A pool that behaves like Postgres on a second run: a plain CREATE of an
// existing table/index throws, a plain INSERT of an existing key throws.
function strictPool() {
  const made = new Set();
  const keys = new Set();
  return {
    async query(sql, params) {
      const create = sql.match(/CREATE (?:TABLE|INDEX)( IF NOT EXISTS)? (\w+)/);
      if (create) {
        if (made.has(create[2]) && !create[1]) throw new Error(`relation "${create[2]}" already exists`);
        made.add(create[2]);
      }
      const ins = sql.match(/INSERT INTO (\w+)/);
      if (ins) {
        const k = `${ins[1]}:${params[0]}`;
        if (keys.has(k) && !/ON CONFLICT/.test(sql)) throw new Error(`duplicate key ${k}`);
        keys.add(k);
      }
      return { rows: [] };
    },
  };
}

test('the schema SQL runs twice without error (idempotent, db.js style)', async () => {
  const pool = strictPool();
  await S.ensurePhotoTables(pool);
  await S.ensurePhotoTables(pool);
  for (const t of ['photos', 'photo_paths', 'photo_tags', 'photo_vocab', 'photo_synonyms', 'photo_crawl_runs']) {
    assert.ok(S.SCHEMA_SQL.some((q) => q.includes(`CREATE TABLE IF NOT EXISTS ${t} `)), t);
  }
  assert.ok(S.SCHEMA_SQL[0].includes('thumb BYTEA') && S.SCHEMA_SQL[0].includes('removed_at TIMESTAMPTZ'));
});

test('the vocabulary seeds from photo-vocabulary.js, synonyms included', () => {
  const { tags, syns } = S.vocabSeed();
  assert.ok(tags.some(([t]) => t === 'string lights'));
  assert.ok(syns.some(([w, t]) => w === 'media wall' && t === 'step-and-repeat'));
  assert.ok(syns.some(([w, t]) => w === 'lectern' && t === 'podium'));
});

// ------------------------------------------------------------ the job

function fakeClient({ changes = [], newStart = 'tok-2' } = {}) {
  const kids = {
    [A.ROOT_FOLDER_ID]: [{ id: 'ven', name: 'Venues', mimeType: F }, { id: 'staff', name: 'Staff Photos', mimeType: F }],
    ven: [{ id: 'tbt', name: 'TBT', mimeType: F }, { id: 'swf', name: 'SWF', mimeType: F }],
    tbt: [{ id: 'p1', name: 'IMG_1.jpg', mimeType: 'image/jpeg', md5Checksum: 'x1', parents: ['tbt'], thumbnailLink: 'https://lh3/x=s220' },
      { id: 'v1', name: 'clip.mp4', mimeType: 'video/mp4', parents: ['tbt'] }],
    swf: [],
  };
  const changeTokens = [];
  return {
    changeTokens,
    serviceAccount: 'mock',
    listPage: async (p) => ({ files: kids[p.q.match(/'([^']+)'/)[1]] || [] }),
    getFile: async () => ({ id: A.ROOT_FOLDER_ID, driveId: 'drv' }),
    startPageToken: async () => 'tok-1',
    changesPage: async (tok) => { changeTokens.push(tok); return { changes, newStartPageToken: newStart }; },
    thumbnail: async () => ({ bytes: Buffer.from('jpg'), w: 400, h: 300 }),
  };
}

test('--dry-run makes ZERO database writes (no pool is even asked for)', async () => {
  const pool = mockPool();
  let asked = 0;
  const lines = [];
  const s = await J.main({ argv: ['--dry-run'], client: fakeClient(), pool, makePool: () => { asked += 1; return pool; }, log: (l) => lines.push(l) });
  assert.strictEqual(pool.queries.length, 0);
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(s.totals, { files: 2, images: 1, videos: 1, other: 0 });
  assert.deepStrictEqual(s.venues, { TBT: 2, SWF: 0 }, 'an empty venue is named with 0');
  assert.ok(lines.some((l) => /SKIPPED, never opened: Staff Photos/.test(l)));
});

test('no flag at all is the dry run', () => {
  assert.strictEqual(J.parseArgs([]).mode, 'dry-run');
  assert.throws(() => J.parseArgs(['--apply', '--changes']), /pick one/);
});

test('--apply stores the start-page token, and --changes reuses it and stores the next one', async () => {
  const pool = mockPool();
  await J.main({ argv: ['--apply'], client: fakeClient(), pool, log: () => {} });
  const runInsert = pool.queries.filter((q) => /INSERT INTO photo_crawl_runs/.test(q.sql));
  assert.strictEqual(runInsert.length, 1);
  assert.strictEqual(runInsert[0].params[8], 'tok-1');

  const client = fakeClient();
  const pool2 = mockPool((sql) => (/SELECT start_page_token/.test(sql) ? [{ start_page_token: 'tok-1' }] : []));
  await J.main({ argv: ['--changes'], client, pool: pool2, log: () => {} });
  assert.deepStrictEqual(client.changeTokens, ['tok-1']);
  const stored = pool2.queries.filter((q) => /INSERT INTO photo_crawl_runs/.test(q.sql));
  assert.strictEqual(stored[0].params[8], 'tok-2');
});

test('--changes with no stored token refuses rather than guessing a start point', async () => {
  await assert.rejects(J.main({ argv: ['--changes'], client: fakeClient(), pool: mockPool(), log: () => {} }), /run --apply once first/);
});

test('KNOWN-BAD: a trashed file gets removed_at on the next --changes run', async () => {
  const client = fakeClient({ changes: [{ fileId: 'p1', file: { id: 'p1', trashed: true, mimeType: 'image/jpeg', parents: ['tbt'] } }] });
  const pool = mockPool((sql, params) => {
    if (/SELECT start_page_token/.test(sql)) return [{ start_page_token: 'tok-1' }];
    if (/SELECT folder_path FROM photos/.test(sql) && params[0] === 'p1') return [{ folder_path: 'Venues / TBT' }];
    return [];
  });
  const r = await J.main({ argv: ['--changes'], client, pool, log: () => {} });
  const upd = pool.queries.filter((q) => /UPDATE photos SET removed_at = now\(\)/.test(q.sql));
  assert.deepStrictEqual(upd.map((q) => q.params[0]), ['p1']);
  assert.strictEqual(r.counts.removed, 1);
});

test('--apply never marks files removed when a folder failed to list', async () => {
  const client = fakeClient();
  const base = client.listPage;
  client.listPage = async (p) => { if (p.q.includes("'swf'")) throw new Error('403'); return base(p); };
  const pool = mockPool((sql) => (/SELECT drive_id, folder_path FROM photos/.test(sql)
    ? [{ drive_id: 'gone', folder_path: 'Venues / SWF' }] : []));
  await J.main({ argv: ['--apply', '--no-thumbs'], client, pool, log: () => {} });
  assert.ok(!pool.queries.some((q) => /SET removed_at/.test(q.sql)));
});

test('a row carries the path fields, the date facets and the Venues rights default', () => {
  const r = J.rowFor({ id: 'p', name: 'a.jpg', mimeType: 'image/jpeg', createdTime: '2024-10-02T01:00:00Z',
    imageMediaMetadata: { width: 400, height: 300, time: '2023:06:10 18:22:01' },
    path: ['Venues', 'TBT', 'Patio', 'Wedding Reception', 'Cocktail', '100-200'] });
  assert.strictEqual(r.venue, 'TBT');
  assert.strictEqual(r.space, 'Patio');
  assert.strictEqual(r.guest_band, '100-200');
  assert.strictEqual(r.season, 'summer');
  assert.strictEqual(r.orientation, 'landscape');
  assert.strictEqual(r.rights_state, 'cleared');
});
