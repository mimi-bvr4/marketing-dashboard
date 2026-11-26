// ORDER #3852 (#3849 follow-on): the two claude-haiku-5-5 call sites get a
// budget Haiku 5.5 can finish in.
//
// MEASURED, 11.26.2026 ~05:20 CT, one fixture call each (no client data), sent
// exactly as lib/ai-narrative.js builds it with the numbers.html prompt:
//   - max_tokens 500:   stop_reason max_tokens, output_tokens 500 (thinking 500),
//                       blocks [thinking], 0 characters of text. The page would
//                       read "No analysis available."
//   - max_tokens 10000: stop_reason end_turn, output_tokens 1707 (thinking 1344),
//                       blocks [thinking, text], 919 characters, 163 words.
// So Haiku 5.5 spent 1344 tokens before its first text, and the answer itself
// took 1707 - 1344 = 363 tokens.
//
// The fixture model is #3847's: it spends the measured overhead of max_tokens
// in a thinking block before writing, then writes the answer and cuts it where
// the budget ends, with stop_reason max_tokens. The tagger was not called live
// (the order allows no call for it); the narrative's overhead is applied to it.
// Every fetch is a stub; nothing reaches Anthropic and no key is read.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const N = require('../lib/ai-narrative');
const T = require('../lib/photo-tagger');
const FM = require('../lib/fast-model');
const LLM = require('../lib/agent-llm');

const MEASURED_OVERHEAD = 1344;      // thinking tokens before the first text block
const MEASURED_ANSWER_TOKENS = 363;  // 1707 - 1344
const CHARS_PER_TOKEN = 919 / 363;   // the measured answer's own ratio

const NARRATIVE_ANSWER = 'x'.repeat(919);
const TAG_ANSWER = '{"tags":[{"tag":"string lights","confidence":0.9}],"free":[],"event_type_guess":null}';

// #3847's fixture model at the measured Haiku 5.5 overhead.
function haikuFixture(answer) {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    const room = Math.max(0, body.max_tokens - MEASURED_OVERHEAD);
    const need = Math.ceil(answer.length / CHARS_PER_TOKEN);
    const cut = need > room;
    const content = [{ type: 'thinking', thinking: '...' }];
    const text = cut ? answer.slice(0, Math.floor(room * CHARS_PER_TOKEN)) : answer;
    if (text) content.push({ type: 'text', text });
    return { ok: true, status: 200, json: async () => ({ content, stop_reason: cut ? 'max_tokens' : 'end_turn' }) };
  };
  return { bodies, fetchImpl };
}

test('the Haiku 5.5 overhead is one named, exported constant, at least the measured overhead', () => {
  assert.strictEqual(typeof FM.HAIKU_5_5_OVERHEAD_TOKENS, 'number');
  assert.ok(FM.HAIKU_5_5_OVERHEAD_TOKENS >= MEASURED_OVERHEAD, `${FM.HAIKU_5_5_OVERHEAD_TOKENS} < ${MEASURED_OVERHEAD}`);
  assert.strictEqual(LLM.HAIKU_5_5_OVERHEAD_TOKENS, FM.HAIKU_5_5_OVERHEAD_TOKENS, 'agent-llm exports it beside SONNET_5_5_OVERHEAD_TOKENS');
});

test('KNOWN-BAD (#3852 measured): the /api/ai/narrative answer arrives whole on Haiku 5.5, not "No analysis available."', async () => {
  const { bodies, fetchImpl } = haikuFixture(NARRATIVE_ANSWER);
  const out = await N.requestNarrative({ apiKey: 'stub', prompt: 'p', data: [{ a: 1 }], fetchImpl });
  assert.strictEqual(out.text, NARRATIVE_ANSWER, `cut or empty at max_tokens ${bodies[0].max_tokens}`);
  assert.ok(bodies[0].max_tokens >= MEASURED_OVERHEAD + MEASURED_ANSWER_TOKENS);
});

test('the narrative budget is the old 500 plus the Haiku overhead, exported', async () => {
  assert.strictEqual(N.NARRATIVE_MAX_TOKENS, 500 + FM.HAIKU_5_5_OVERHEAD_TOKENS);
  const { bodies, fetchImpl } = haikuFixture(NARRATIVE_ANSWER);
  await N.requestNarrative({ apiKey: 'stub', prompt: 'p', data: {}, fetchImpl });
  assert.strictEqual(bodies[0].max_tokens, N.NARRATIVE_MAX_TOKENS);
});

test('KNOWN-BAD (#3852, overhead applied): the tagger answer is not cut off on Haiku 5.5', async () => {
  const { bodies, fetchImpl } = haikuFixture(TAG_ANSWER);
  const text = await T.createClaudeClient({ apiKey: 'stub', fetchImpl }).describe(Buffer.from([0xff, 0xd8]), 'p');
  assert.strictEqual(text, TAG_ANSWER);
  assert.strictEqual(bodies[0].max_tokens, 1200 + FM.HAIKU_5_5_OVERHEAD_TOKENS);
  assert.strictEqual(T.MAX_TOKENS, 1200 + FM.HAIKU_5_5_OVERHEAD_TOKENS);
});

test('the Opus pick client keeps its 1200 (not measured here), and an explicit override still wins', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"tags":[]}' }], stop_reason: 'end_turn' }) };
  };
  await T.createClaudeClient({ apiKey: 'stub', fetchImpl, model: T.PICK_MODEL }).describe(Buffer.from([0xff]), 'p');
  await T.createClaudeClient({ apiKey: 'stub', fetchImpl, maxTokens: 2000 }).describe(Buffer.from([0xff]), 'p');
  assert.strictEqual(bodies[0].max_tokens, 1200);
  assert.strictEqual(T.PICK_MAX_TOKENS, 1200);
  assert.strictEqual(bodies[1].max_tokens, 2000);
});

test('model ids and the Sonnet overhead are unchanged', () => {
  assert.strictEqual(FM.FAST_MODEL, 'claude-haiku-5-5');
  assert.strictEqual(T.PICK_MODEL, 'claude-opus-5-5');
  assert.strictEqual(LLM.SONNET_5_5_OVERHEAD_TOKENS, 9000);
});
