// ORDER #3250 (#3218 rows 4 and 6): the photo tagger's tag call and the
// /api/ai/narrative call read ONE fast-model constant, default
// claude-haiku-5-5, overridable by the FAST_MODEL env variable.
// Every fetch is a stub and the real fetch is replaced by one that throws, so
// nothing reaches Anthropic and no key is read.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../lib/photo-tagger');

const ROOT = path.join(__dirname, '..');
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const TEST_MODEL = 'claude-test-model-3250';

const realFetch = globalThis.fetch;
const savedEnv = process.env.FAST_MODEL;
test.beforeEach(() => {
  globalThis.fetch = async () => { throw new Error('network refused in test (ORDER #3250)'); };
  delete process.env.FAST_MODEL;
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnv === undefined) delete process.env.FAST_MODEL; else process.env.FAST_MODEL = savedEnv;
});

function stubFetch() {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({
      content: [{ type: 'text', text: '{"tags":[],"free":[]}' }], stop_reason: 'end_turn' }) };
  };
  return { bodies, fetchImpl };
}

function narrative() {
  // Required inside each test so a missing module fails that test, not the file.
  return require('../lib/ai-narrative');
}

test('(a) env unset: the photo tagger tag call sends claude-haiku-5-5', async () => {
  const { bodies, fetchImpl } = stubFetch();
  await T.createClaudeClient({ apiKey: 'stub', fetchImpl }).describe(THUMB, 'p');
  assert.strictEqual(bodies[0].model, 'claude-haiku-5-5');
});

test('(a) env unset: the /api/ai/narrative call sends claude-haiku-5-5', async () => {
  const { bodies, fetchImpl } = stubFetch();
  await narrative().requestNarrative({ apiKey: 'stub', prompt: 'p', data: { a: 1 }, fetchImpl });
  assert.strictEqual(bodies[0].model, 'claude-haiku-5-5');
});

test('(b) FAST_MODEL set: the photo tagger tag call sends that value', async () => {
  process.env.FAST_MODEL = TEST_MODEL;
  const { bodies, fetchImpl } = stubFetch();
  await T.createClaudeClient({ apiKey: 'stub', fetchImpl }).describe(THUMB, 'p');
  assert.strictEqual(bodies[0].model, TEST_MODEL);
});

test('(b) FAST_MODEL set: the /api/ai/narrative call sends that value', async () => {
  process.env.FAST_MODEL = TEST_MODEL;
  const { bodies, fetchImpl } = stubFetch();
  await narrative().requestNarrative({ apiKey: 'stub', prompt: 'p', data: { a: 1 }, fetchImpl });
  assert.strictEqual(bodies[0].model, TEST_MODEL);
});

test('the narrative request is otherwise unchanged: max_tokens 500, prompt + data, the first text block or the fallback', async () => {
  const { bodies, fetchImpl } = stubFetch();
  const out = await narrative().requestNarrative({ apiKey: 'stub', prompt: 'Say', data: { x: 2 }, fetchImpl });
  assert.strictEqual(bodies[0].max_tokens, 500);
  assert.deepStrictEqual(bodies[0].messages, [{ role: 'user', content: 'Say\n\nData: {"x":2}' }]);
  assert.strictEqual(out.text, '{"tags":[],"free":[]}');
  const empty = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const none = await narrative().requestNarrative({ apiKey: 'stub', prompt: 'p', data: {}, fetchImpl: empty });
  assert.strictEqual(none.text, 'No analysis available.');
});

test('(c) neither the tagger nor the narrative path holds a claude-haiku literal outside the one constant', () => {
  const files = ['lib/photo-tagger.js', 'server.js', 'lib/ai-narrative.js'];
  for (const f of files) {
    const p = path.join(ROOT, f);
    assert.ok(fs.existsSync(p), `${f} exists`);
    assert.ok(!/claude-haiku/.test(fs.readFileSync(p, 'utf8')), `${f} holds a claude-haiku literal`);
  }
  const constFile = fs.readFileSync(path.join(ROOT, 'lib/fast-model.js'), 'utf8');
  assert.strictEqual((constFile.match(/claude-haiku[\w.-]*/g) || []).length, 1, 'exactly one model id in lib/fast-model.js');
  assert.ok(/require\('\.\/lib\/ai-narrative'\)/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
    'server.js routes /api/ai/narrative through lib/ai-narrative');
});

test('the Opus pick pin (#3218 row 5) is left as it is', () => {
  assert.strictEqual(T.PICK_MODEL, 'claude-opus-5-5');
});
