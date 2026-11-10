// ORDER #3085: photo archive tags. Day / night / dusk from the camera clock,
// the look-alike prompt lines, and near-identical shots sharing one answer.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/photo-facts');
const C = require('../lib/photo-clusters');
const T = require('../lib/photo-tagger');
const A = require('../lib/photo-archive');
const M = require('../lib/photo-meaning');
const { GROUPS, SYNONYMS } = require('../lib/photo-vocabulary');

// ------------------------------------------------------------- step 2: facts

const localHm = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23',
  hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const minutesOf = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

test('Nashville sunset lands where the almanac puts it (CDT in June, CST in December)', () => {
  // Published: 21 June 2024 about 20:07 CDT; 21 December 2024 about 16:37 CST.
  const june = minutesOf(localHm(F.sunsetUtcMs({ y: 2024, mo: 6, d: 21 })));
  const dec = minutesOf(localHm(F.sunsetUtcMs({ y: 2024, mo: 12, d: 21 })));
  assert.ok(Math.abs(june - (20 * 60 + 7)) <= 5, `June sunset ${june} min`);
  assert.ok(Math.abs(dec - (16 * 60 + 37)) <= 5, `December sunset ${dec} min`);
});

test('the EXIF wall clock is read as Nashville time, across daylight saving', () => {
  assert.strictEqual(new Date(F.chicagoToUtcMs({ y: 2024, mo: 6, d: 21, h: 18, mi: 0 })).toISOString(), '2024-06-21T23:00:00.000Z');
  assert.strictEqual(new Date(F.chicagoToUtcMs({ y: 2024, mo: 12, d: 21, h: 18, mi: 0 })).toISOString(), '2024-12-22T00:00:00.000Z');
});

test('day, dusk and night from the camera clock', () => {
  assert.strictEqual(F.dayPart('2024:06:21 14:00:00'), 'day');
  assert.strictEqual(F.dayPart('2024:06:21 19:45:00'), 'dusk', 'within 40 minutes before sunset');
  assert.strictEqual(F.dayPart('2024:06:21 20:40:00'), 'dusk', 'within 40 minutes after sunset');
  assert.strictEqual(F.dayPart('2024:06:21 22:30:00'), 'night');
  assert.strictEqual(F.dayPart('2024:12:21 18:30:00'), 'night', 'a December 6:30 PM reception is night');
  assert.strictEqual(F.dayPart('2024:12:21 16:20:00'), 'dusk');
  assert.strictEqual(F.dayPart('2024:12:21 05:00:00'), 'night');
  assert.strictEqual(F.dayPart('2024:12:21 10:00:00'), 'day');
});

test('no clock, no tag: never a guess', () => {
  for (const t of [null, undefined, '', '0000:00:00 00:00:00', 'garbage', '2024:13:01 10:00:00', '2024:06:21']) {
    assert.strictEqual(F.dayPart(t), null, String(t));
  }
  assert.deepStrictEqual(F.factsFor({}), { taken_time: null, day_part: null, orientation: null });
});

test('taken_time and orientation from what Drive already hands back', () => {
  assert.deepStrictEqual(F.factsFor({ time: '2023:06:10 18:22:01', width: 4000, height: 6000 }),
    { taken_time: '18:22:01', day_part: 'day', orientation: 'portrait' });
  assert.strictEqual(F.factsFor({ width: 10, height: 10 }).orientation, 'square');
});

test('the crawl stores the time of day and the day part with every row', () => {
  const { rowFor } = require('../jobs/photo_crawl');
  const row = rowFor({ id: 'x1', name: 'a.jpg', mimeType: 'image/jpeg', path: ['Venues', 'TBT'],
    imageMediaMetadata: { width: 400, height: 300, time: '2024:12:21 18:30:00' } });
  assert.strictEqual(row.taken_time, '18:30:00');
  assert.strictEqual(row.day_part, 'night');
});

test('typed facts are searchable: year, shape and day part hit with no tag row', () => {
  const vocab = A.buildVocabulary({ groups: GROUPS, synonyms: SYNONYMS });
  const p = { name: 'x.jpg', tags: [], year: 2024, orientation: 'portrait', day_part: 'night', season: 'winter' };
  assert.ok(A.matches(vocab, p, '2024'));
  assert.ok(A.matches(vocab, p, 'portrait'));
  assert.ok(A.matches(vocab, p, 'night'));
  assert.ok(!A.matches(vocab, { ...p, day_part: 'day' }, 'night'));
  assert.ok(A.FACETS.includes('day_part'));
});

test('the facts backfill asks Drive read-only, writes the clock, and stops on a 403', async () => {
  const { backfillFacts } = require('../jobs/photo_facts');
  const queue = ['a', 'b', 'c'];
  const writes = [];
  const pool = { async query(sql, params) {
    if (/^SELECT drive_id FROM photos/.test(sql)) return { rows: queue.filter((id) => !writes.some((w) => w[0] === id)).map((drive_id) => ({ drive_id })) };
    if (/^UPDATE photos SET taken_time/.test(sql)) { writes.push(params); return { rowCount: 1 }; }
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: queue.length - writes.length }] };
    return { rows: [] };
  } };
  const times = { a: '2024:06:21 22:30:00', b: undefined, c: '2024:06:21 14:00:00' };
  const client = { async getFile(id, fields) {
    assert.match(fields, /imageMediaMetadata\(time\)/);
    return { id, imageMediaMetadata: times[id] ? { time: times[id] } : {} };
  } };
  const r = await backfillFacts({ client, pool, log: () => {} });
  assert.deepStrictEqual(writes.sort(), [['a', '22:30:00', 'night'], ['b', null, null], ['c', '14:00:00', 'day']]);
  assert.strictEqual(r.withTime, 2);
  assert.strictEqual(r.noTime, 1);

  const writes2 = [];
  const pool2 = { async query(sql, params) {
    if (/^SELECT drive_id FROM photos/.test(sql)) return { rows: [{ drive_id: 'z' }] };
    if (/^UPDATE/.test(sql)) { writes2.push(params); return {}; }
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: 1 }] };
    return { rows: [] };
  } };
  const r2 = await backfillFacts({ client: { async getFile() { throw new Error('Drive 403: no'); } }, pool: pool2, log: () => {} });
  assert.ok(r2.stopped);
  assert.strictEqual(writes2.length, 0, 'a 403 stamps nothing');
});

test('the facts backfill pauses outside the photo window', async () => {
  const { backfillFacts } = require('../jobs/photo_facts');
  let asked = 0;
  const pool = { async query(sql) { if (/count/.test(sql)) return { rows: [{ n: 5 }] }; return { rows: [{ drive_id: 'a' }] }; } };
  const r = await backfillFacts({ client: { async getFile() { asked += 1; return {}; } }, pool, log: () => {}, gate: () => 'closed' });
  assert.strictEqual(r.paused, 'closed');
  assert.strictEqual(asked, 0);
});

// ------------------------------------------------------------- step 3: prompt

const PROMPT = T.buildPrompt({ groups: GROUPS, synonyms: SYNONYMS });

test('the look-alike pairs #1789 found each have a line', () => {
  assert.match(PROMPT, /two-top tables, and long highboys, are cocktail tables, never rounds/);
  assert.match(PROMPT, /projected light .* is a gobo/);
  assert.match(PROMPT, /neon or marquee, never a gobo/);
  assert.match(PROMPT, /A hedge or greenery wall is decor, never a step and repeat/);
  assert.match(PROMPT, /aisle with an altar or arch are a ceremony, never theater/);
});

test('the clock words are not offered to the model, and are dropped if it says them anyway', async () => {
  assert.doesNotMatch(PROMPT, /setting: [^\n]*\bnight\b/);
  assert.doesNotMatch(PROMPT, /setting: [^\n]*\bday\b/);
  assert.match(PROMPT, /setting: exterior; rain plan/);
  const vocab = A.buildVocabulary({ groups: GROUPS, synonyms: SYNONYMS });
  const model = { model: 'mock', async describe() {
    return JSON.stringify({ tags: [{ tag: 'night', confidence: 0.9 }, { tag: 'setting: day', confidence: 0.8 },
      { tag: 'rounds', confidence: 0.9 }], free: ['dusk'], event_type_guess: null });
  } };
  const r = await T.tagPhoto({ model, vocab, prompt: PROMPT, thumb: Buffer.from('x') });
  assert.deepStrictEqual(r.ai.map((t) => t.tag), ['rounds']);
  assert.strictEqual(r.dropped.filter((d) => /camera clock/.test(d.why)).length, 3);
});

// ------------------------------------------------------------- step 4: clusters

// 12 hand-made vectors: folder E1 has a tight group of 4 and a group of 3;
// folder E2 holds a near-copy of E1's first group, which must NOT join it.
function vec(base, jitter) {
  const v = new Float32Array(M.DIMS);
  for (let i = 0; i < M.DIMS; i += 1) v[i] = (base(i) + jitter * Math.sin(i * 7.3 + jitter * 100));
  return M.decodeVector(M.encodeVector(M.normalize(v)));
}
const baseA = (i) => (i % 3 === 0 ? 1 : 0.1);
const baseB = (i) => (i % 5 === 0 ? 1 : -0.1);
const baseC = (i) => Math.cos(i);
function fixture() {
  const photos = [];
  const vectors = new Map();
  const add = (id, folder, v) => { photos.push({ drive_id: id, folder_path: folder }); vectors.set(id, v); };
  add('a1', 'E1', vec(baseA, 0)); add('a2', 'E1', vec(baseA, 0.05)); add('a3', 'E1', vec(baseA, 0.08)); add('a4', 'E1', vec(baseA, 0.1));
  add('b1', 'E1', vec(baseB, 0)); add('b2', 'E1', vec(baseB, 0.05)); add('b3', 'E1', vec(baseB, 0.1));
  add('c1', 'E1', vec(baseC, 0));
  add('x1', 'E2', vec(baseA, 0.02)); add('x2', 'E2', vec(baseA, 0.06));
  add('y1', 'E2', vec(baseC, 0.5)); add('y2', 'E2', vec(baseB, 0.9));
  return { photos, vectors };
}

test('12 vectors form the expected groups at 0.92, and no group crosses a folder', () => {
  const { photos, vectors } = fixture();
  const groups = C.clusterPhotos(photos, vectors, { threshold: 0.92 });
  const shape = groups.map((g) => [g.folder, g.seed, g.members.map((m) => m.drive_id)]);
  assert.deepStrictEqual(shape.filter((g) => g[0] === 'E1'),
    [['E1', 'a1', ['a2', 'a3', 'a4']], ['E1', 'b1', ['b2', 'b3']], ['E1', 'c1', []]]);
  const e2 = shape.filter((g) => g[0] === 'E2');
  assert.deepStrictEqual(e2[0], ['E2', 'x1', ['x2']], 'E2 has its own copy of group A');
  for (const g of groups) for (const m of g.members) {
    assert.strictEqual(photos.find((p) => p.drive_id === m.drive_id).folder_path, g.folder);
    assert.ok(m.cosine >= 0.92);
  }
  const cov = C.coverage(groups);
  assert.strictEqual(cov.photos, 12);
  assert.ok(cov.seeds < 12);
});

test('no chaining: a member joins only on its own cosine to the seed', () => {
  const v = (arr) => M.decodeVector(M.encodeVector(M.normalize(Float32Array.from(arr))));
  // s~m1 = 0.95, s~m2 = 0.8 even though m1~m2 is high.
  const s = v([1, 0, 0]);
  const m1 = v([0.95, Math.sqrt(1 - 0.95 ** 2), 0]);
  const m2 = v([0.8, 0.6, 0]);
  const photos = ['s', 'm1', 'm2'].map((id) => ({ drive_id: id, folder_path: 'F' }));
  const groups = C.clusterPhotos(photos, new Map([['s', s], ['m1', m1], ['m2', m2]]), { threshold: 0.92 });
  assert.deepStrictEqual(groups[0].members.map((m) => m.drive_id), ['m1']);
});

test('the nearest-twin distribution counts photos at each band', () => {
  const { photos, vectors } = fixture();
  const d = C.nearestDistribution(photos, vectors);
  assert.strictEqual(d.photos, 12);
  assert.ok(d.atLeast['0.92'] >= 9, JSON.stringify(d));
  assert.ok(d.atLeast['0.80'] >= d.atLeast['0.98']);
});

test('propagation writes the seed id, caps confidence by the cosine, and never re-adds a removed tag', () => {
  const rows = C.propagationRows({ seed: 'a1', cosine: 0.93, removed: ['Uplighting'],
    seedAi: [{ tag: 'rounds', confidence: 0.99 }, { tag: 'uplighting', confidence: 0.8 }, { tag: 'gobo', confidence: 0.5 }] });
  assert.deepStrictEqual(rows, [
    { tag: 'rounds', confidence: 0.93, who: 'propagated:a1' },
    { tag: 'gobo', confidence: 0.5, who: 'propagated:a1' },
  ]);
  assert.strictEqual(C.seedOf('propagated:a1'), 'a1');
  assert.strictEqual(C.seedOf('claude-opus-5-5'), null);
});

test('a hand-picked member or one with its own answer keeps it', () => {
  assert.strictEqual(C.mayPropagate({ picked: true, own: [] }), false);
  assert.strictEqual(C.mayPropagate({ own: [{ who: 'claude-opus-5-5' }] }), false);
  assert.strictEqual(C.mayPropagate({ own: [{ who: 'propagated:a1' }] }), true);
  assert.strictEqual(C.mayPropagate({}), true);
});

// An in-memory photo_tags, enough for the writers' SQL.
function tagTable(initial = []) {
  const rows = initial.map((r) => ({ ...r }));
  return { rows, async query(sql, p) {
    if (/^DELETE FROM photo_tags WHERE drive_id = \$1 AND source = 'ai' AND who LIKE 'propagated:%'/.test(sql)) {
      for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].drive_id === p[0] && rows[i].source === 'ai' && C.isPropagated(rows[i].who)) rows.splice(i, 1);
    } else if (/^DELETE FROM photo_tags WHERE drive_id = \$1 AND source = 'ai'/.test(sql)) {
      for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].drive_id === p[0] && rows[i].source === 'ai') rows.splice(i, 1);
    } else if (/^INSERT INTO photo_tags/.test(sql)) {
      if (!rows.some((r) => r.drive_id === p[0] && r.tag === p[1] && r.source === 'ai')) rows.push({ drive_id: p[0], tag: p[1], source: 'ai', confidence: p[2], who: p[3] });
    }
    return { rows: [], rowCount: 1 };
  } };
}

test('writePropagated replaces only shared rows; human rows are untouched', async () => {
  const db = tagTable([
    { drive_id: 'm', tag: 'old', source: 'ai', who: 'propagated:z' },
    { drive_id: 'm', tag: 'uplighting', source: 'human_remove', who: 'person:1' },
  ]);
  await C.writePropagated(db, 'm', [{ tag: 'rounds', confidence: 0.93, who: 'propagated:a1' }]);
  assert.deepStrictEqual(db.rows.map((r) => [r.tag, r.source, r.who]).sort(),
    [['rounds', 'ai', 'propagated:a1'], ['uplighting', 'human_remove', 'person:1']]);
});

test('a hand pick on a member replaces its shared rows (writePickTags)', async () => {
  const { writePickTags } = require('../lib/photo-picks');
  const db = tagTable([{ drive_id: 'm', tag: 'rounds', source: 'ai', who: 'propagated:a1' }]);
  await writePickTags(db, 'm', [{ tag: 'cocktail tables', confidence: 0.9 }], 'claude-opus-5-5');
  assert.deepStrictEqual(db.rows.map((r) => [r.tag, r.who]), [['cocktail tables', 'claude-opus-5-5']]);
});

// ------------------------------------------------------------- step 5: the run

function runPool({ photos, vectors, tags = [], picks = [] }) {
  const db = tagTable(tags);
  const thumbs = [];
  return { db, thumbs, async query(sql, p) {
    if (/FROM photos p\s+JOIN photo_embeddings/.test(sql)) {
      return { rows: photos.map((x) => ({ ...x, vec: Buffer.from(Int8Array.from(vectors.get(x.drive_id).v).buffer) })) };
    }
    if (/^SELECT tag, grp FROM photo_vocab/.test(sql)) return { rows: [{ tag: 'rounds', grp: 'tables' }, { tag: 'uplighting', grp: 'lighting' }] };
    if (/^SELECT word, tag FROM photo_synonyms/.test(sql)) return { rows: [] };
    if (/^SELECT drive_id, tag, confidence, who FROM photo_tags/.test(sql)) return { rows: db.rows.filter((r) => r.source === 'ai') };
    if (/^SELECT drive_id, tag, source FROM photo_tags/.test(sql)) return { rows: db.rows.filter((r) => r.source !== 'ai') };
    if (/^SELECT drive_id FROM photo_picks/.test(sql)) return { rows: picks.map((drive_id) => ({ drive_id })) };
    if (/^SELECT thumb FROM photos/.test(sql)) { thumbs.push(p[0]); return { rows: [{ thumb: Buffer.from('jpg') }] }; }
    if (/^UPDATE photo_picks/.test(sql)) return { rowCount: 1 };
    if (/photo_tags/.test(sql)) return db.query(sql, p);
    return { rows: [] };   // schema statements
  } };
}

test('--clusters: the cap counts seeds, members get shared rows, a removed tag stays gone', async () => {
  const { main } = require('../jobs/photo_tag');
  const { photos, vectors } = fixture();
  const pool = runPool({ photos, vectors, tags: [{ drive_id: 'a3', tag: 'uplighting', source: 'human_remove', who: 'person:1' }] });
  const model = { model: 'claude-opus-5-5', async describeWithModel() {
    return { text: JSON.stringify({ tags: [{ tag: 'rounds', confidence: 0.97 }, { tag: 'uplighting', confidence: 0.9 }], free: [], event_type_guess: null }), model: 'claude-opus-5-5' };
  } };
  const logs = [];
  const r = await main({ argv: ['--clusters', '--cap', '2'], pool, model, log: (s) => logs.push(s) });
  assert.strictEqual(r.seeds, 2, 'two model calls');
  assert.deepStrictEqual(pool.thumbs.sort(), ['a1', 'b1'], 'the biggest groups first');
  assert.strictEqual(r.covered, 7);
  const of = (id) => pool.db.rows.filter((x) => x.drive_id === id && x.source === 'ai').map((x) => [x.tag, x.who]).sort();
  assert.deepStrictEqual(of('a1'), [['rounds', 'claude-opus-5-5'], ['uplighting', 'claude-opus-5-5']]);
  assert.deepStrictEqual(of('a2'), [['rounds', 'propagated:a1'], ['uplighting', 'propagated:a1']]);
  assert.deepStrictEqual(of('a3'), [['rounds', 'propagated:a1']], 'the human-removed tag is not re-added');
  assert.ok(logs.some((l) => /CLUSTERS DONE: 2 seeds tagged, 7 photos covered/.test(l)), logs.join('\n'));
});

test('--clusters: a picked member keeps its own answer; a seed already answered is shared with no call', async () => {
  const { main } = require('../jobs/photo_tag');
  const { photos, vectors } = fixture();
  const pool = runPool({ photos, vectors, picks: ['a2'], tags: [
    { drive_id: 'a1', tag: 'rounds', source: 'ai', confidence: 0.99, who: 'claude-opus-5-5' },
    { drive_id: 'a2', tag: 'cocktail tables', source: 'ai', confidence: 0.9, who: 'claude-opus-5-5' },
  ] });
  let calls = 0;
  const model = { model: 'claude-opus-5-5', async describeWithModel() { calls += 1; return { text: '{"tags":[]}', model: 'claude-opus-5-5' }; } };
  const r = await main({ argv: ['--clusters', '--cap', '0'], pool, model, log: () => {} });
  assert.strictEqual(calls, 0);
  assert.strictEqual(r.free >= 1, true);
  const of = (id) => pool.db.rows.filter((x) => x.drive_id === id && x.source === 'ai').map((x) => [x.tag, x.who]);
  assert.deepStrictEqual(of('a2'), [['cocktail tables', 'claude-opus-5-5']], 'picked member untouched');
  assert.deepStrictEqual(of('a4'), [['rounds', 'propagated:a1']]);
});

test('--clusters stops before a call when the photo window is closed', async () => {
  const { main } = require('../jobs/photo_tag');
  const { photos, vectors } = fixture();
  const pool = runPool({ photos, vectors });
  let calls = 0;
  const model = { model: 'm', async describeWithModel() { calls += 1; return { text: '{"tags":[]}', model: 'm' }; } };
  const r = await main({ argv: ['--clusters'], pool, model, log: () => {}, gate: () => 'outside the photo bonus window' });
  assert.strictEqual(calls, 0);
  assert.strictEqual(r.paused, 'outside the photo bonus window');
});

test('--clusters --dry-run needs no key, sends nothing, writes nothing, and prints the distribution', async () => {
  const { main } = require('../jobs/photo_tag');
  const { photos, vectors } = fixture();
  const pool = runPool({ photos, vectors });
  const logs = [];
  const r = await main({ argv: ['--clusters', '--dry-run'], pool, log: (s) => logs.push(s) });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(pool.thumbs.length, 0);
  assert.strictEqual(pool.db.rows.length, 0);
  assert.ok(logs.some((l) => /cosine >= 0.92/.test(l)));
  assert.ok(logs.some((l) => /threshold 0.92: \d+ seeds/.test(l)));
});

test('parseArgs: --clusters caps 300 seeds by default; --dry-run only with --clusters', () => {
  const { parseArgs } = require('../jobs/photo_tag');
  assert.strictEqual(parseArgs(['--clusters']).cap, 300);
  assert.strictEqual(parseArgs(['--clusters', '--threshold', '0.9']).threshold, 0.9);
  assert.throws(() => parseArgs(['--apply', '--dry-run']));
  assert.throws(() => parseArgs(['--clusters', '--threshold', '2']));
});

test('the nightly ships both new steps OFF', () => {
  const sh = require('fs').readFileSync(require('path').join(__dirname, '..', 'jobs', 'photo_nightly.sh'), 'utf8');
  assert.match(sh, /FACTS_MIN="\$\{PHOTO_FACTS_MIN:-0\}"/);
  assert.match(sh, /CLUSTER_CAP="\$\{PHOTO_CLUSTER_CAP:-0\}"/);
  // The always-on step is the measuring dry run, and only that.
  assert.match(sh, /node jobs\/photo_tag.js --clusters --dry-run'/);
});
