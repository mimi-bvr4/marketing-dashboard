'use strict';
// ORDER #3849 (#3847 follow-on): every model call that was AT RISK on
// claude-sonnet-5-5 gets a budget with room for the answer AFTER the overhead.
//
// Measured, from ~/Library/Logs/ihg_marketing_agents.out (#3847):
//   - 11.23.2026 :679, seo at max_tokens 9000: "first answer unreadable (stop
//     max_tokens) ... characters 693 to 773 of 773". So about 9000 - 773/3 =
//     8,743 tokens went before any text the client keeps.
//   - 11.25.2026 :741, gala-scout at max_tokens 12000: "answer cut off at the
//     length limit; kept 1 whole card, anything unfinished dropped".
//
// The fixture model is #3847's: it spends MEASURED_OVERHEAD tokens of the
// budget first, then writes the answer at ~3 characters per token (the Sonnet
// 4.6 gala-scout measurement, 12000 tokens = 35,672 characters), cut where the
// budget ends, with stop_reason max_tokens.
//
// The answer each agent writes in the fixture is 90% of the room its Sonnet 4.6
// budget gave it (old max_tokens x 3 characters): the room it ran clean in, on
// 4.6, before #3249. Gala-scout is the exception (see its row).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../lib/agent-runner');
const S = require('../lib/agent-sources');
const LLM = require('../lib/agent-llm');

const CHARS_PER_TOKEN = 3;
const MEASURED_OVERHEAD = 9000 - Math.ceil(773 / CHARS_PER_TOKEN); // 8,742: the 11.23 seo answer
const DEFAULT_BUDGET = () => R.DEFAULT_AGENT_MAX_TOKENS || 8000;   // main: a bare 8000

// slug -> the max_tokens it had on Sonnet 4.6 (origin/main 674f60c), and the answer the fixture writes.
const room46 = (t) => Math.floor(t * CHARS_PER_TOKEN * 0.9);
const AT_RISK = {
  seo: { was: 9000, chars: room46(9000), cards: 1 },                 // logged cut-off 11.23 :679
  // Gala-scout's answer is long by nature (#3224): on 4.6 it filled 12000 tokens
  // and was still cut. On 5.5, 11.25 :741, 12000 left room for ONE of its two
  // cards (about (12000 - 8742) x 3 = 9,774 characters). The fixture writes two
  // cards, 15,000 characters: more than that, so it is cut on main.
  'gala-scout': { was: 12000, chars: 15000, cards: 2 },
  scout: { was: 6000, chars: room46(6000), cards: 1 },               // budget below the overhead
  'engagement-sleuth': { was: 6000, chars: room46(6000), cards: 1 }, // budget below the overhead
  'collateral-cadet': { was: 2000, chars: room46(2000), cards: 1 },  // budget below the overhead
  'pinterest-paul': { was: 4000, chars: room46(4000), cards: 1 },    // budget below the overhead
  'keyword-queen': { was: 8000, chars: room46(8000), cards: 1 },     // budget below the overhead
  copywriter: { was: 9000, chars: room46(9000), cards: 1 },          // the same 9000 the seo cut-off had
  gbp: { was: 8000, chars: room46(8000), cards: 1 },                 // no max_tokens in its file: the default
};

function cardsJson(total, n) {
  const sentence = 'Saturday dates in April still have room for a ceremony and reception. ';
  const per = Math.floor(total / n);
  const cards = [];
  for (let i = 0; i < n; i++) cards.push({ title: `Card ${i + 1}`, target: 'sales', body: sentence.repeat(Math.ceil(per / sentence.length)).slice(0, per) });
  return JSON.stringify({ cards });
}

function fixtureModel(answer) {
  const calls = [];
  return {
    calls,
    lastStop: null,
    async complete({ maxTokens }) {
      calls.push(maxTokens);
      const room = Math.max(0, (maxTokens || 8000) - MEASURED_OVERHEAD) * CHARS_PER_TOKEN;
      if (answer.length > room) { this.lastStop = 'max_tokens'; return answer.slice(0, room); }
      this.lastStop = 'end_turn';
      return answer;
    },
  };
}

const budgetOf = (slug) => R.loadAgent(slug).max_tokens || DEFAULT_BUDGET();

for (const [slug, a] of Object.entries(AT_RISK)) {
  test(`${slug}: with the measured 5.5 overhead, the whole answer arrives on the first call (RED on main)`, async () => {
    const lines = [];
    const llm = fixtureModel(cardsJson(a.chars, a.cards));
    const cards = await R.draftCards(llm, { system: 's', user: 'u', maxTokens: budgetOf(slug), max: a.cards, log: (l) => lines.push(l), slug });
    assert.equal(llm.calls.length, 1, `one call, no retry (log: ${lines.join(' | ')})`);
    assert.equal(llm.lastStop, 'end_turn');
    assert.equal(cards.length, a.cards);
    assert.deepEqual(lines.filter((l) => /unreadable|cut off/.test(l)), []);
  });

  test(`${slug}: its budget is at least the overhead plus ${slug === 'gala-scout' ? 'its two cards' : 'its Sonnet 4.6 room'}`, () => {
    const need = slug === 'gala-scout' ? MEASURED_OVERHEAD + Math.ceil(a.chars / CHARS_PER_TOKEN) : MEASURED_OVERHEAD + a.was;
    assert.ok(budgetOf(slug) >= need, `${slug} max_tokens ${budgetOf(slug)} < ${need}`);
  });
}

test('the overhead constant is exported and covers the measurement', () => {
  assert.ok(LLM.SONNET_5_5_OVERHEAD_TOKENS >= MEASURED_OVERHEAD, `SONNET_5_5_OVERHEAD_TOKENS ${LLM.SONNET_5_5_OVERHEAD_TOKENS}`);
  assert.equal(R.DEFAULT_AGENT_MAX_TOKENS, 8000 + LLM.SONNET_5_5_OVERHEAD_TOKENS);
});

test('gala-scout stays inside the #3224 shape: its own budget still cuts the 11.11 one-row-per-event table', () => {
  // order3224 test 1 builds a ~59,000-character table; 18000 tokens is 54,000 characters.
  assert.ok(R.loadAgent('gala-scout').max_tokens * CHARS_PER_TOKEN < 58000);
});

// The two Claude call sites in lib/agent-sources.js (ai_answers, ai_cited_sources).
const NO_CONFIG = '/nonexistent/anthropic_api_key';
function claudeFetch(log, answer) {
  return async (u, o = {}) => {
    if (!u.includes('api.anthropic.com')) return { status: 404, headers: { get: () => 'text/html' }, text: async () => '', url: '' };
    const body = JSON.parse(o.body);
    log.push(body);
    const room = Math.max(0, body.max_tokens - MEASURED_OVERHEAD) * CHARS_PER_TOKEN;
    const cut = answer.length > room;
    const json = { content: [{ type: 'text', text: cut ? answer.slice(0, room) : answer }], stop_reason: cut ? 'max_tokens' : 'end_turn' };
    return { status: 200, text: async () => JSON.stringify(json) };
  };
}

test('ai_answers (agent-sources askers.claude): a 1024-token-room answer arrives whole (RED on main)', async () => {
  const log = [];
  const answer = 'The Bridge Building is a riverfront venue downtown. '.repeat(60).slice(0, room46(1024));
  const ask = S.askers({ env: { ANTHROPIC_API_KEY: 'k' }, fetch: claudeFetch(log, answer), keychain: () => null, configFile: NO_CONFIG }, {}, () => {});
  const text = await ask.claude('best event venues in Nashville');
  assert.equal(text, answer);
  assert.ok(log[0].max_tokens >= MEASURED_OVERHEAD + 1024, `max_tokens ${log[0].max_tokens}`);
});

test('ai_cited_sources sends the same budget as ai_answers', async () => {
  const log = [];
  const src = { type: 'ai_cited_sources', prompts: ['venues in Nashville'], venues: [{ name: 'The Bridge Building' }], our_domains: [], providers: ['claude'] };
  await S.aiCitedSourcesSource(src, { env: { ANTHROPIC_API_KEY: 'k' }, fetch: claudeFetch(log, 'plain answer'), keychain: () => null, configFile: NO_CONFIG });
  assert.ok(log.length >= 1);
  assert.ok(log.every((b) => b.max_tokens >= MEASURED_OVERHEAD + 1024), `max_tokens ${log.map((b) => b.max_tokens)}`);
});

test('ai-narrative joins every text block, like lib/agent-llm.js (RED on main: it read content[0].text only)', async () => {
  const { requestNarrative } = require('../lib/ai-narrative');
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    content: [{ type: 'thinking', thinking: 'weighing the numbers' }, { type: 'text', text: 'Leads rose. ' }, { type: 'text', text: 'Tours held steady.' }],
    stop_reason: 'end_turn' }) });
  const out = await requestNarrative({ apiKey: 'stub', prompt: 'p', data: {}, fetchImpl });
  assert.equal(out.text, 'Leads rose. Tours held steady.');
  const none = await requestNarrative({ apiKey: 'stub', prompt: 'p', data: {}, fetchImpl: async () => ({ json: async () => ({ content: [{ type: 'thinking', thinking: 'x' }] }) }) });
  assert.equal(none.text, 'No analysis available.');
});
