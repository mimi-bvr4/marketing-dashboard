// ORDER #1795: the tagger's answer limit, and the answers it cuts off.
// Every fetch is a stub; no key is read and nothing reaches Anthropic.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/photo-archive');
const T = require('../lib/photo-tagger');
const { GROUPS, SYNONYMS } = require('../lib/photo-vocabulary');

const SRC = { groups: GROUPS, synonyms: SYNONYMS };
const VOCAB = A.buildVocabulary(SRC);
const PROMPT = T.buildPrompt(SRC);
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

// A fetch stub that records each request body and answers with `reply(body)`.
function stubFetch(reply) {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    return { ok: true, status: 200, json: async () => reply(body) };
  };
  return { bodies, fetchImpl };
}

const whole = { content: [{ type: 'text', text: '{"tags":[{"tag":"string lights","confidence":0.9}],"free":[]}' }],
  stop_reason: 'end_turn' };
const truncated = { content: [{ type: 'text', text: '{"tags":[{"tag":"string lights","confidence":0.9},{"tag":"dra' }],
  stop_reason: 'max_tokens' };

test('KNOWN-BAD (#1789): an answer cut off at max_tokens is counted and logged as cut off with its photo id, never tagged', async () => {
  const { fetchImpl } = stubFetch(() => truncated);
  const model = T.createClaudeClient({ apiKey: 'stub', fetchImpl });
  const lines = [];
  const tagged = [];
  const run = await T.tagBatch({
    photos: [{ drive_id: 'cut-1' }], getThumb: async () => THUMB, model, vocab: VOCAB, prompt: PROMPT,
    onTagged: async (p) => tagged.push(p.drive_id), log: (l) => lines.push(l),
  });
  assert.deepStrictEqual(tagged, [], 'a cut-off answer is never written as tags');
  assert.strictEqual(run.results.length, 0);
  assert.ok(Array.isArray(run.cutOff), 'the run returns its cut-offs');
  assert.deepStrictEqual(run.cutOff.map((c) => c.drive_id), ['cut-1']);
  assert.ok(lines.some((l) => /cut off/i.test(l) && l.includes('cut-1')), `no cut-off line names the photo: ${lines.join(' | ')}`);
  assert.ok(lines.some((l) => /1 cut off/.test(l)), `the run summary prints the cut-off count: ${lines.join(' | ')}`);
});

test('a whole answer in the same batch is still tagged beside a cut-off one', async () => {
  const { bodies, fetchImpl } = stubFetch(() => (bodies.length === 1 ? truncated : whole));
  const model = T.createClaudeClient({ apiKey: 'stub', fetchImpl });
  const run = await T.tagBatch({
    photos: [{ drive_id: 'a' }, { drive_id: 'b' }], batchSize: 1, getThumb: async () => THUMB,
    model, vocab: VOCAB, prompt: PROMPT, log: () => {},
  });
  assert.deepStrictEqual(run.cutOff.map((c) => c.drive_id), ['a']);
  assert.deepStrictEqual(run.results.map((r) => r.photo.drive_id), ['b']);
});

test('KNOWN-BAD (#1789): the request asks for 1200 answer tokens by default and honours an explicit override', async () => {
  const { bodies, fetchImpl } = stubFetch(() => whole);
  await T.createClaudeClient({ apiKey: 'stub', fetchImpl }).describe(THUMB, PROMPT);
  await T.createClaudeClient({ apiKey: 'stub', fetchImpl, maxTokens: 2000 }).describe(THUMB, PROMPT);
  assert.strictEqual(bodies[0].max_tokens, 1200);
  assert.strictEqual(bodies[1].max_tokens, 2000);
  assert.strictEqual(bodies[0].model, T.MODEL, 'the default model is unchanged');
});
