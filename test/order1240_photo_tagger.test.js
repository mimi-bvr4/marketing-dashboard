// ORDER #1240: the AI tagger. Every model answer is a mock; no key is read and
// nothing reaches Anthropic, Drive or a database.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/photo-archive');
const T = require('../lib/photo-tagger');
const J = require('../jobs/photo_tag');
const { GROUPS, SYNONYMS } = require('../lib/photo-vocabulary');

const SRC = { groups: GROUPS, synonyms: SYNONYMS };
const VOCAB = A.buildVocabulary(SRC);
const PROMPT = T.buildPrompt(SRC);
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const answer = (o) => ({ model: 'mock', describe: async () => (typeof o === 'string' ? o : JSON.stringify(o)) });
const quiet = () => {};

function mockPool(answers = () => []) {
  const queries = [];
  return { queries, query: async (sql, params) => { queries.push({ sql, params }); return { rows: answers(sql, params) || [] }; } };
}

test('LAW: a tag that identifies a person is refused, free text or vocabulary-shaped', async () => {
  const r = await T.tagPhoto({ model: answer({ tags: [{ tag: 'string lights', confidence: 0.9 }, { tag: 'bride named sarah', confidence: 0.8 }],
    free: ['asian guests', 'Jane Doe', 'mr smith'] }), vocab: VOCAB, prompt: PROMPT, thumb: THUMB });
  assert.deepStrictEqual(r.ai.map((t) => t.tag), ['string lights']);
  const why = r.dropped.map((d) => d.why);
  assert.ok(why.includes('identifies a person'), JSON.stringify(r.dropped));
  assert.ok(!r.ai.some((t) => /sarah|asian|jane|smith/i.test(t.tag)));
});

test('the person filter refuses no tag in the seed vocabulary', () => {
  const caught = [...VOCAB.lookup.keys()].filter(T.personTag);
  assert.deepStrictEqual(caught, []);
});

test('LAW: a human-removed tag stays removed when the AI tags the photo again', async () => {
  const model = answer({ tags: [{ tag: 'chandeliers', confidence: 0.95 }, { tag: 'draping', confidence: 0.9 }] });
  const first = await T.tagPhoto({ model, vocab: VOCAB, prompt: PROMPT, thumb: THUMB });
  assert.ok(first.final.includes('chandeliers'));
  const state = A.applyTagEdit({ added: [], removed: [] }, 'remove', 'chandeliers');
  const again = await T.tagPhoto({ model, vocab: VOCAB, prompt: PROMPT, thumb: THUMB, removed: state.removed });
  assert.deepStrictEqual(again.final, ['draping']);
  assert.ok(!again.ai.some((t) => t.tag === 'chandeliers'), 'the AI row itself leaves the removed tag out');
});

test('a synonym collapses to its head tag', async () => {
  const r = await T.tagPhoto({ model: answer({ tags: [{ tag: 'media wall', confidence: 0.7 }, { tag: 'step and repeat', confidence: 0.9 },
    { tag: 'bistro lights', confidence: 0.6 }] }), vocab: VOCAB, prompt: PROMPT, thumb: THUMB });
  assert.deepStrictEqual(r.ai, [{ tag: 'step-and-repeat', confidence: 0.9 }, { tag: 'string lights', confidence: 0.6 }]);
});

test('KNOWN-BAD (#1278): a vocabulary tag with its group in front still lands; an unknown word after a colon is still dropped', async () => {
  const r = await T.tagPhoto({ model: answer({ tags: [{ tag: 'setting: night', confidence: 0.9 },
    { tag: 'lighting: string lights', confidence: 0.8 }, { tag: 'decor: zzz unknown thing', confidence: 0.7 }] }),
  vocab: VOCAB, prompt: PROMPT, thumb: THUMB });
  assert.deepStrictEqual(r.ai, [{ tag: 'night', confidence: 0.9 }, { tag: 'string lights', confidence: 0.8 }]);
  assert.strictEqual(r.dropped.length, 1);
});

test('malformed model JSON skips that photo and is logged; the batch goes on', async () => {
  const lines = [];
  let n = 0;
  const model = { describe: async () => (++n === 2 ? 'Sure! Here are the tags: string lights' : JSON.stringify({ tags: [{ tag: 'bar', confidence: 0.8 }] })) };
  const run = await T.tagBatch({ photos: [{ drive_id: 'a' }, { drive_id: 'b' }, { drive_id: 'c' }], getThumb: async () => THUMB,
    model, vocab: VOCAB, prompt: PROMPT, batchSize: 1, log: (l) => lines.push(l) });
  assert.deepStrictEqual(run.results.map((r) => r.photo.drive_id), ['a', 'c']);
  assert.deepStrictEqual(run.skipped.map((s) => s.drive_id), ['b']);
  assert.ok(lines.some((l) => l.startsWith('SKIPPED b:')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('2 of 3 tagged')), lines.join('\n'));
});

test('the batch cap is honored: no photo past the cap reaches the model', async () => {
  let calls = 0;
  const model = { describe: async () => { calls += 1; return '{"tags":[]}'; } };
  const photos = Array.from({ length: 25 }, (_, i) => ({ drive_id: `p${i}` }));
  const run = await T.tagBatch({ photos, getThumb: async () => THUMB, model, vocab: VOCAB, prompt: PROMPT, cap: 7, batchSize: 3, log: quiet });
  assert.strictEqual(calls, 7);
  assert.strictEqual(run.results.length, 7);
  assert.strictEqual(run.capped, true);
});

test('LAW: only a thumbnail is sent; an original-sized image is refused before the model call', async () => {
  let called = false;
  const model = { describe: async () => { called = true; return '{"tags":[]}'; } };
  await assert.rejects(T.tagPhoto({ model, vocab: VOCAB, prompt: PROMPT, thumb: Buffer.alloc(T.MAX_THUMB_BYTES + 1) }), /not a thumbnail/);
  assert.strictEqual(called, false);
});

test('the real client sends one image block plus the prompt, to the named model', async () => {
  const sent = [];
  const c = T.createClaudeClient({ apiKey: 'k', fetchImpl: async (url, o) => { sent.push({ url, body: JSON.parse(o.body), headers: o.headers });
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"tags":[]}' }] }) }; } });
  assert.strictEqual(await c.describe(THUMB, 'P'), '{"tags":[]}');
  assert.strictEqual(sent[0].url, T.API_URL);
  assert.strictEqual(sent[0].body.model, T.MODEL);
  const content = sent[0].body.messages[0].content;
  assert.deepStrictEqual(content.map((x) => x.type), ['image', 'text']);
  assert.strictEqual(content[0].source.data, THUMB.toString('base64'));
});

test('the key is found by name in the order env, Keychain, config, and absent means null', () => {
  assert.strictEqual(T.findApiKey({ env: { ANTHROPIC_API_KEY: 'e' }, keychain: () => 'k' }).source, 'env ANTHROPIC_API_KEY');
  assert.strictEqual(T.findApiKey({ env: {}, keychain: () => 'k' }).source, 'Keychain item anthropic-api-key');
  assert.strictEqual(T.findApiKey({ env: {}, keychain: () => null, configFile: '/nonexistent/x' }), null);
});

test('the prompt carries the vocabulary and synonyms from the DB rows', () => {
  const src = T.vocabFromRows([{ tag: 'neon sign', grp: 'decor' }], [{ word: 'neon', tag: 'neon sign' }]);
  const p = T.buildPrompt(src);
  assert.ok(p.includes('decor: neon sign'));
  assert.ok(p.includes('neon -> neon sign'));
  assert.ok(/JSON only/.test(p));
});

test('the sample has 20 photos, at least 8 corporate or NLP, across at least 4 venues', () => {
  const files = [];
  const add = (path, k) => { for (let i = 0; i < k; i += 1) files.push({ id: `${path.join('-')}-${i}`, mimeType: 'image/jpeg', thumbnailLink: 'x=s220', path }); };
  add(['IH Event Albums', 'Weddings'], 60);
  add(['NLP', 'Gala'], 5);
  add(['Event Design', 'Corporate Events'], 5);
  ['ECD', 'TBB', 'SWF', 'COR', 'STE'].forEach((v) => add(['Venues', v, 'Main Floor'], 3));
  const s = T.pickSample(files);
  assert.strictEqual(s.sample.length, 20);
  assert.ok(s.corporate >= 8, `corporate ${s.corporate}`);
  assert.ok(s.venues.length >= 4, `venues ${s.venues}`);
});

test('--apply writes AI rows and never writes a human-removed tag back', async () => {
  const pool = mockPool((sql) => {
    if (/FROM photo_vocab/.test(sql)) return [{ tag: 'bar', grp: 'decor' }, { tag: 'draping', grp: 'decor' }];
    if (/FROM photo_synonyms/.test(sql)) return [];
    if (sql === J.TODO_SQL) return [{ drive_id: 'p1' }];
    if (/source IN \('human_add', 'human_remove'\)/.test(sql)) return [{ drive_id: 'p1', tag: 'bar', source: 'human_remove' }];
    if (/SELECT thumb FROM photos/.test(sql)) return [{ thumb: THUMB }];
    return [];
  });
  const model = answer({ tags: [{ tag: 'bar', confidence: 0.9 }, { tag: 'draping', confidence: 0.8 }] });
  await J.main({ argv: ['--apply', '--cap', '5'], pool, model, log: quiet });
  const inserts = pool.queries.filter((q) => /INSERT INTO photo_tags/.test(q.sql));
  assert.deepStrictEqual(inserts.map((q) => q.params[1]), ['draping']);
  assert.ok(!pool.queries.some((q) => /DELETE FROM photo_tags/.test(q.sql) && !/source = 'ai'/.test(q.sql)), 'human rows are never deleted');
});

test('the paste count reads the same photos the tagger would pick, with no ORDER BY', () => {
  assert.ok(J.COUNT_SQL.startsWith('SELECT count(*)::int AS n FROM photos p'));
  assert.ok(!/ORDER BY/.test(J.COUNT_SQL));
  assert.ok(J.COUNT_SQL.includes("t.source = 'ai'") && J.COUNT_SQL.includes('p.thumb IS NOT NULL'));
});

test('no key: the job refuses with exit code 4 and calls nothing', async () => {
  await assert.rejects(J.main({ argv: ['--apply'], pool: mockPool(), makeModel: () => null, log: quiet }),
    (e) => e.exitCode === 4 && /KEY MISSING/.test(e.message));
});
