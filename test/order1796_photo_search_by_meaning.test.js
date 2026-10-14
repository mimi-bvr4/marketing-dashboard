'use strict';
// ORDER #1796 (plan C, ruled 10.14.2026): search by meaning for every photo
// (local model, on the Box) and big-model tags ONLY on photos someone picked.
//
// DONE MEANS, as tests: a typed phrase ranks a known photo first in a fixture
// set; a picked photo gets tags; nothing tags without a pick. The route tests
// drive the real page gate and routes/photos.js over a real socket (#1241's
// harness). Vectors are hand-made, so no model is needed; the one real-model
// test runs only where the model is already on disk (PHOTO_MODEL_CACHE).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const { spawnSync } = require('child_process');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const M = require('../lib/photo-meaning');
const K = require('../lib/photo-picks');
const A = require('../lib/photo-archive');
const T = require('../lib/photo-tagger');
const J = require('../jobs/photo_tag');
const E = require('../jobs/photo_embed');
const { pageGate } = require('../middleware/page-gate');
const { createPhotosRouter } = require('../routes/photos');
const { vocabSeed, SCHEMA_SQL } = require('../lib/photo-schema');

// ------------------------------------------------------------- vectors by hand

const DIM = M.DIMS;
// A unit vector mostly along axis `i`, a little along `j`.
function axis(i, j = null, w = 0.3) {
  const v = new Float32Array(DIM);
  v[i] = 1;
  if (j !== null) v[j] = w;
  return M.normalize(v);
}
// What the fake text model "understands".
const MEANINGS = { 'dessert table': axis(0), 'ceremony aisle': axis(1), 'stage with lights': axis(2) };
const fakeEmbedText = async (q) => {
  const v = MEANINGS[q];
  if (!v) throw new Error(`fake model does not know "${q}"`);
  return Array.from(v);
};

const P = (id, extra = {}) => ({
  drive_id: id, name: `${id}.jpg`, kind: 'image', folder_path: 'Venues / TBT / Patio', brand: 'IH', venue: 'TBT',
  space: 'Patio', event_type: null, event_class: 'wedding', setup: null, guest_band: null, deal_id: null,
  manual_internal: false, rights_reason: null, taken_date: '2025-06-10', month: 'June', season: 'summer', year: 2025,
  orientation: 'landscape', width: 4000, height: 3000, has_thumb: true, ...extra,
});

function fixture() {
  const photos = [
    P('cake0000001'),                                   // the known photo: a dessert table, NO tags
    P('aisle000001'),
    P('stage000001', { venue: 'TBB', event_class: 'corporate' }),
    P('nearcake001'),                                   // a bit like a dessert table, less so
    P('tagonly0001', { has_thumb: false }),             // tagged "dessert table" by a person, no vector yet
    P('cakeswf0001', { venue: 'SWF' }),                 // a dessert table at another venue
    P('staffcake01', { folder_path: 'Staff Photos / 2025' }),
  ];
  const vecs = {
    cake0000001: axis(0, 5, 0.05), aisle000001: axis(1), stage000001: axis(2), nearcake001: axis(5, 0, 0.6),
    cakeswf0001: axis(0, 6, 0.2), staffcake01: axis(0),
  };
  const { tags: v, syns } = vocabSeed();
  return {
    photos,
    tags: [{ drive_id: 'tagonly0001', tag: 'dessert table', source: 'human_add', who: 'person:k1' },
      { drive_id: 'aisle000001', tag: 'aisle', source: 'ai', confidence: 0.9 }],
    vocabRows: v.map(([tag, grp]) => ({ tag, grp })), synonymRows: syns.map(([word, tag]) => ({ word, tag })),
    picks: [],
    vectors: Object.entries(vecs).map(([drive_id, f], n) => ({ drive_id, vec: M.encodeVector(f),
      at: `2026-10-14 02:${String(n).padStart(2, '0')}:00.123456+00` })),
  };
}

function memoryStore(data = fixture()) {
  const writes = [];
  return {
    data, writes,
    async loadIndex() {
      const { vectors, ...rest } = data;
      return JSON.parse(JSON.stringify(rest));
    },
    async loadVectors(model, cursor, limit) {
      const after = (r) => !cursor || r.at > cursor.at || (r.at === cursor.at && r.drive_id > cursor.drive_id);
      return data.vectors.filter(after).slice(0, limit);
    },
    async getThumb(id) { return Buffer.from(`JPEG:${id}`); },
    async editTag() { throw new Error('not in this test'); },
    async setInternal() { throw new Error('not in this test'); },
    async pick(id, why, who) {
      writes.push({ pick: id, why, who });
      const old = data.picks.find((k) => k.drive_id === id);
      if (old) Object.assign(old, { why, tagged_at: null }); else data.picks.push({ drive_id: id, why, tagged_at: null });
    },
    async savePickTags(id, ai, modelId) {
      writes.push({ tags: id, ai: ai.map((t) => t.tag), modelId });
      data.tags = data.tags.filter((t) => !(t.drive_id === id && t.source === 'ai'));
      ai.forEach((t) => data.tags.push({ drive_id: id, tag: t.tag, source: 'ai', confidence: t.confidence }));
      Object.assign(data.picks.find((k) => k.drive_id === id), { tagged_at: 'now', tagged_model: modelId });
    },
  };
}

const PEOPLE = {
  'katherine@x': { active: true, person_id: 'k1', rung: 2, surface_access: { 'marketing.dashboard': true, 'marketing.photos': true } },
  'sales@x': { active: true, person_id: 's1', rung: 2, surface_access: { 'marketing.dashboard': false, 'marketing.photos': true } },
};
const identity = { lookup: async (email) => PEOPLE[email] || { active: false, surface_access: {} } };

function app(store, opts = {}) {
  const a = express();
  a.use(express.json());
  a.use(pageGate);
  a.use(createPhotosRouter({ store, identity, sheet: async () => [], cacheMs: 0, log: () => {}, ...opts }));
  return a;
}
function serve(a, t) {
  return new Promise((resolve) => {
    const s = http.createServer(a).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); });
  });
}
function call(server, urlPath, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(body); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const as = (email) => ({ Cookie: `mkt_session=${jwt.sign({ role: 'sso', email, mkt_access: true }, process.env.JWT_SECRET)}` });
const MEANING = { model: M.MODEL_ID, embedText: fakeEmbedText };

// The tag model: answers like the API, and counts every call.
function opus(calls = []) {
  return {
    model: T.PICK_MODEL, calls,
    async describeWithModel(thumb) {
      calls.push(thumb.toString());
      return { text: JSON.stringify({ tags: [{ tag: 'desserts and cake', confidence: 0.95 }, { tag: 'candles', confidence: 0.8 }],
        free: [], event_type_guess: null }), model: 'claude-opus-5-5-20261001' };
    },
  };
}

// ------------------------------------------------------------- vectors

test('a vector survives the int8 round trip: same ranking, cosine within 0.01', () => {
  const a = axis(0, 1, 0.5);
  const b = axis(0, 2, 0.4);
  const exact = a.reduce((s, x, i) => s + x * b[i], 0);
  const stored = M.decodeVector(M.encodeVector(b));
  assert.strictEqual(M.encodeVector(b).length, DIM, 'one byte per value');
  assert.ok(Math.abs(M.cosine(a, stored) - exact) < 0.01);
});

// ------------------------------------------------------------- DONE MEANS 1

test('DONE MEANS: a typed phrase ranks the known photo first, though it carries no tag', () => {
  const f = fixture();
  const vocab = A.buildVocabulary();
  const vectors = new Map(f.vectors.map((r) => [r.drive_id, M.decodeVector(r.vec)]));
  const photos = f.photos.filter((p) => !/^staff/i.test(p.folder_path)).map((p) => ({ ...p, tags: [] }));
  photos.find((p) => p.drive_id === 'tagonly0001').tags = ['dessert table'];
  const { results } = M.meaningSearch(vocab, photos, { q: 'dessert table', qvec: axis(0), vectors });
  const ids = results.map((p) => p.drive_id);
  assert.strictEqual(ids[0], 'cake0000001');
  assert.ok(ids.indexOf('nearcake001') > ids.indexOf('cakeswf0001'), 'closer meanings first');
  assert.strictEqual(ids[ids.length - 1], 'tagonly0001', 'a tag match with no vector is still found, after the ranked ones');
});

test('filters still apply to a meaning search, and facets count what it found', () => {
  const f = fixture();
  const vectors = new Map(f.vectors.map((r) => [r.drive_id, M.decodeVector(r.vec)]));
  const photos = f.photos.map((p) => ({ ...p, tags: [] }));
  const { results, facets } = M.meaningSearch(A.buildVocabulary(), photos,
    { q: 'dessert table', qvec: axis(0), vectors, filters: { venue: ['SWF'] } });
  assert.deepStrictEqual(results.map((p) => p.drive_id), ['cakeswf0001']);
  assert.ok(facets.venue.TBT > 0, 'the venue facet still offers the other venues');
});

test('the page: "dessert table" by meaning puts the known photo first, says so, and counts searchable photos', async (t) => {
  const s = await serve(app(memoryStore(), { meaning: MEANING }), t);
  const r = await call(s, '/api/photos?q=dessert%20table', { headers: as('sales@x') });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.mode, 'meaning');
  assert.strictEqual(r.json.results[0].id, 'cake0000001');
  assert.ok(!r.json.results.some((p) => p.id === 'staffcake01'), 'Staff Photos never appears');
  assert.deepStrictEqual(r.json.progress, { tagged: 1, total: 6, searchable: 5 }, 'N searchable, M tagged');
  const venue = await call(s, '/api/photos?q=dessert%20table&venue=TBB', { headers: as('sales@x') });
  assert.deepStrictEqual(venue.json.results.map((p) => p.id), ['stage000001'], 'a filter narrows a meaning search');
});

test('without the model, or when it fails, the search is the tag search it always was', async (t) => {
  const off = await serve(app(memoryStore()), t);
  const a = await call(off, '/api/photos?q=dessert%20table', { headers: as('sales@x') });
  assert.strictEqual(a.json.mode, 'tags');
  assert.deepStrictEqual(a.json.results.map((p) => p.id), ['tagonly0001']);
  assert.strictEqual(a.json.progress.searchable, null);
  const broken = await serve(app(memoryStore(), { meaning: { model: M.MODEL_ID, embedText: async () => { throw new Error('model down'); } } }), t);
  const b = await call(broken, '/api/photos?q=dessert%20table', { headers: as('sales@x') });
  assert.strictEqual(b.status, 200);
  assert.strictEqual(b.json.mode, 'tags');
  assert.deepStrictEqual(b.json.results.map((p) => p.id), ['tagonly0001']);
});

test('vectors load in slices, newer rows only, with an exact cursor', async (t) => {
  const store = memoryStore();
  const seen = [];
  const inner = store.loadVectors;
  store.loadVectors = async (...args) => { seen.push(args[1]); return inner(...args); };
  const s = await serve(app(store, { meaning: MEANING, vectorSlice: 2, vectorsMs: 0 }), t);
  await call(s, '/api/photos?q=dessert%20table', { headers: as('sales@x') });
  assert.strictEqual(seen.length, 4, '6 rows in slices of 2, then an empty slice');
  assert.strictEqual(seen[0], null);
  store.data.vectors.push({ drive_id: 'late0000001', vec: M.encodeVector(axis(0)), at: '2026-10-15 02:00:00.000001+00' });
  await call(s, '/api/photos?q=dessert%20table', { headers: as('sales@x') });
  assert.strictEqual(seen[4].drive_id, store.data.vectors[5].drive_id, 'the next load starts after the last row held');
});

// ------------------------------------------------------------- DONE MEANS 2 and 3

test('DONE MEANS: a picked photo gets tags, named by the model id the API reported', async (t) => {
  const store = memoryStore();
  const calls = [];
  const s = await serve(app(store, { meaning: MEANING, tagModel: opus(calls) }), t);
  const r = await call(s, '/api/photos/cake0000001/tag', { headers: as('katherine@x'), method: 'POST' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.tags.sort(), ['candles', 'desserts and cake']);
  assert.strictEqual(r.json.model, 'claude-opus-5-5-20261001');
  assert.deepStrictEqual(store.writes[0], { pick: 'cake0000001', why: 'tag_this', who: 'person:k1' }, 'the pick is written first');
  assert.deepStrictEqual(store.writes[1].modelId, 'claude-opus-5-5-20261001');
  const view = await call(s, '/api/photos/cake0000001', { headers: as('katherine@x') });
  assert.deepStrictEqual(view.json.pick, { why: 'tag_this', tagged: true, model: 'claude-opus-5-5-20261001' });
  assert.deepStrictEqual(calls, ['JPEG:cake0000001'], 'one call, the thumbnail only');
});

test('DONE MEANS: nothing tags without a pick: searching and viewing never call the model; view-only cannot pick', async (t) => {
  const calls = [];
  const store = memoryStore();
  const s = await serve(app(store, { meaning: MEANING, tagModel: opus(calls) }), t);
  await call(s, '/api/photos?q=dessert%20table', { headers: as('katherine@x') });
  await call(s, '/api/photos', { headers: as('katherine@x') });
  await call(s, '/api/photos/cake0000001', { headers: as('katherine@x') });
  const refused = await call(s, '/api/photos/cake0000001/tag', { headers: as('sales@x'), method: 'POST' });
  assert.strictEqual(refused.status, 403);
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(store.writes, []);
});

test('with no model wired, or a failed call, the pick waits for the night run', async (t) => {
  const store = memoryStore();
  const s = await serve(app(store, { meaning: MEANING }), t);
  const r = await call(s, '/api/photos/aisle000001/tag', { headers: as('katherine@x'), method: 'POST' });
  assert.strictEqual(r.json.queued, true);
  assert.deepStrictEqual(store.data.picks, [{ drive_id: 'aisle000001', why: 'tag_this', tagged_at: null }]);
  const bad = { model: T.PICK_MODEL, async describeWithModel() { const e = new Error('cut off'); e.cutOff = true; throw e; } };
  const s2 = await serve(app(memoryStore(), { tagModel: bad }), t);
  const r2 = await call(s2, '/api/photos/aisle000001/tag', { headers: as('katherine@x'), method: 'POST' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.queued, true);
});

// ------------------------------------------------------------- the night tagger

function mockPool(answer) {
  const queries = [];
  return { queries, async query(sql, params) { queries.push({ sql, params }); return { rows: answer(sql, params) || [], rowCount: 1 }; } };
}
const quiet = () => {};

test('KNOWN-BAD on main: --apply asked for untagged photos with no pick; now it reads picks only, untagged since the pick', () => {
  assert.match(J.TODO_SQL, /JOIN photo_picks k ON k\.drive_id = p\.drive_id/);
  assert.match(J.TODO_SQL, /k\.tagged_at IS NULL/);
  assert.match(J.TODO_SQL, /staff photos/);
  assert.doesNotMatch(J.TODO_SQL, /NOT EXISTS \(SELECT 1 FROM photo_tags/, 'no mass backfill of untagged photos');
});

test('DONE MEANS: --apply with no picks sends nothing to the model', async () => {
  const calls = [];
  const pool = mockPool(() => []);
  await J.main({ argv: ['--apply', '--cap', '1000'], pool, model: opus(calls), log: quiet });
  assert.deepStrictEqual(calls, []);
  assert.ok(!pool.queries.some((q) => /INSERT INTO photo_tags/.test(q.sql)));
});

test('--apply tags a pick, writes the model id the API reported, and marks the pick done', async () => {
  const pool = mockPool((sql) => {
    if (/FROM photo_vocab/.test(sql)) return [{ tag: 'desserts and cake', grp: 'food' }, { tag: 'candles', grp: 'lighting' }];
    if (sql === J.TODO_SQL) return [{ drive_id: 'cake0000001' }];
    if (/SELECT thumb FROM photos/.test(sql)) return [{ thumb: Buffer.from('JPEG') }];
    return [];
  });
  await J.main({ argv: ['--apply'], pool, model: opus(), log: quiet });
  const ins = pool.queries.filter((q) => /INSERT INTO photo_tags/.test(q.sql));
  assert.deepStrictEqual(ins.map((q) => q.params[3]), ['claude-opus-5-5-20261001', 'claude-opus-5-5-20261001']);
  const done = pool.queries.find((q) => /UPDATE photo_picks SET tagged_at/.test(q.sql));
  assert.deepStrictEqual(done.params, ['cake0000001', 'claude-opus-5-5-20261001']);
});

test('the pick model is the Opus-class id; the live API client reports the answering model', async () => {
  assert.strictEqual(T.PICK_MODEL, 'claude-opus-5-5');
  const fetchImpl = async (url, init) => ({ ok: true, json: async () => ({ model: 'claude-opus-5-5-20261001', stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"tags":[]}' }], asked: JSON.parse(init.body).model }) });
  const c = T.createClaudeClient({ apiKey: 'k', fetchImpl, model: T.PICK_MODEL });
  assert.deepStrictEqual(await c.describeWithModel(Buffer.from('x'), 'p'), { text: '{"tags":[]}', model: 'claude-opus-5-5-20261001' });
  assert.strictEqual(await c.describe(Buffer.from('x'), 'p'), '{"tags":[]}', 'describe still answers text');
});

test('agent and pin cards that name an archive photo become picks; unknown ids and other links do not', async () => {
  assert.deepStrictEqual(K.photoRefs('see /photos/thumb/cake0000001 and https://drive.google.com/file/d/aisle000001/view and https://example.com/x.jpg').sort(),
    ['aisle000001', 'cake0000001']);
  const pool = mockPool((sql, params) => {
    if (sql === K.CARDS_SQL) return [
      { id: 7, agent: 'copywriter', body: 'Hero: https://marketing.x/photos/thumb/cake0000001', payload: '{}' },
      { id: 8, agent: 'pinterest-paul', body: '', payload: '{"pin":{"image_url":"https://drive.google.com/uc?export=download&id=stage000001"}}' },
      { id: 9, agent: 'copywriter', body: 'https://drive.google.com/file/d/notarchive01/view', payload: null },
    ];
    if (sql === K.KNOWN_SQL) return params[0].filter((id) => id !== 'notarchive01').map((drive_id) => ({ drive_id }));
    return [];
  });
  await K.sweepCardPicks(pool, { log: quiet });
  const picks = pool.queries.filter((q) => /INSERT INTO photo_picks/.test(q.sql));
  assert.deepStrictEqual(picks.map((q) => q.params), [
    ['cake0000001', 'agent_card', 'agent:copywriter card 7'], ['stage000001', 'pin_card', 'agent:pinterest-paul card 8']]);
  assert.ok(picks.every((q) => /DO NOTHING/.test(q.sql)), 'an automatic pick never re-tags a tagged photo');
});

// ------------------------------------------------------------- the night embed step

function embedPool(ids) {
  const db = { photos: ids.map((id) => ({ id, thumb: Buffer.from(`JPEG:${id}`) })), vecs: new Map() };
  return {
    db,
    async query(sql, params) {
      if (sql === M.TODO_SQL) return { rows: db.photos.filter((p) => !db.vecs.has(p.id)).slice(0, params[1]).map((p) => ({ drive_id: p.id })) };
      if (/SELECT thumb FROM photos/.test(sql)) return { rows: [db.photos.find((p) => p.id === params[0])] };
      if (sql === M.SAVE_SQL) { db.vecs.set(params[0], params[2]); return { rows: [] }; }
      if (sql === M.COUNT_SQL) return { rows: [{ searchable: db.vecs.size, left: db.photos.length - db.vecs.size }] };
      return { rows: [] };
    },
  };
}

test('the night step embeds every photo with a thumbnail once, resumes where the budget stopped it, and skips a bad one', async () => {
  const pool = embedPool(['a', 'b', 'c', 'bad', 'd']);
  let clock = 0;
  const embedder = { model: M.MODEL_ID, calls: 0,
    async embedImage(bytes) { this.calls += 1; clock += 1000; if (String(bytes).endsWith('bad')) throw new Error('not an image'); return Array.from(axis(this.calls % 5)); } };
  const lines = [];
  const first = await M.embedPending({ pool, embedder, budgetMs: 2500, batch: 2, now: () => clock, log: (l) => lines.push(l) });
  assert.strictEqual(first.embedded, 3, 'stopped by the budget');
  const second = await M.embedPending({ pool, embedder, budgetMs: 60000, batch: 2, now: () => clock, log: (l) => lines.push(l) });
  assert.strictEqual(second.embedded, 1);
  assert.strictEqual(second.failed, 1);
  assert.strictEqual(pool.db.vecs.size, 4);
  assert.strictEqual(embedder.calls, 5, 'no photo embedded twice');
  assert.ok(pool.db.vecs.get('a').length === DIM);
  assert.match(lines[lines.length - 1], /^EMBED: 1 embedded, 1 failed, 4 searchable, 1 still to do/);
  assert.match(M.TODO_SQL, /staff photos/, 'Staff Photos is never read');
});

test('photo_embed.js with no model package refuses with exit code 4 and embeds nothing', async () => {
  await assert.rejects(E.main({ argv: [], pool: embedPool(['a']), makeEmbedder: () => null, log: quiet }),
    (e) => e.exitCode === 4 && /EMBED SKIPPED/.test(e.message));
});

test('the schema carries the vectors and the picks tables', () => {
  assert.ok(SCHEMA_SQL.some((s) => /CREATE TABLE IF NOT EXISTS photo_embeddings/.test(s) && /vec BYTEA NOT NULL/.test(s)));
  assert.ok(SCHEMA_SQL.some((s) => /CREATE TABLE IF NOT EXISTS photo_picks/.test(s) && /tagged_model TEXT/.test(s)));
});

test('photo_nightly.sh runs the embed step after the thumbnails, even with tagging off', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'o1796-'));
  fs.mkdirSync(path.join(home, 'repos', 'marketing-dashboard'), { recursive: true });
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(home, 'calls.txt');
  fs.writeFileSync(path.join(bin, 'railway'), `#!/bin/bash\necho "$*" >> "${calls}"\n`, { mode: 0o755 });
  const r = spawnSync('/bin/bash', [path.join(__dirname, '..', 'jobs', 'photo_nightly.sh')],
    { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, PHOTO_TAG_CAP: '0', PHOTO_EMBED_MIN: '45' }, encoding: 'utf8' });
  const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
  fs.rmSync(home, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(lines[1], /photo_crawl\.js --thumbs/);
  assert.match(lines[2], /photo_embed\.js --budget-min 45/);
  assert.strictEqual(lines.length, 3, 'tagging off: no tagger');
  assert.match(r.stdout, /embed exit 0/);
});

// ------------------------------------------------------------- the real model

const cache = process.env.PHOTO_MODEL_CACHE;
const haveModel = !!(cache && fs.existsSync(path.join(cache, 'Xenova', 'siglip-base-patch16-224', 'onnx', 'vision_model.onnx')));
test('REAL MODEL: the local SigLIP ranks the right picture first for typed words', { skip: haveModel ? false : 'model not on disk (set PHOTO_MODEL_CACHE)' }, async () => {
  const { loadTransformers, createLocalEmbedder } = require('../lib/photo-embed');
  const sharp = require('sharp');
  const e = createLocalEmbedder({ tf: loadTransformers(), cacheDir: cache });
  const picture = (background) => sharp({ create: { width: 400, height: 300, channels: 3, background } }).jpeg().toBuffer();
  const colours = { red: '#d01010', green: '#10a020', blue: '#1030d0' };
  const vectors = new Map();
  for (const [name, hex] of Object.entries(colours)) vectors.set(name, M.decodeVector(M.encodeVector(M.normalize(await e.embedImage(await picture(hex))))));
  for (const name of Object.keys(colours)) {
    const q = M.normalize(await e.embedText(`a plain ${name} square`));
    const best = [...vectors.entries()].sort((a, b) => M.cosine(q, b[1]) - M.cosine(q, a[1]))[0][0];
    assert.strictEqual(best, name, `"${name}" ranked ${best} first`);
  }
});
