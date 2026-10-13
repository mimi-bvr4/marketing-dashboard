'use strict';
// ORDER #1663 C and B/D: the ai_answers source (Mimi's ruling 10.12.2026:
// Claude, ChatGPT, Gemini and Perplexity, monthly on the 15th) and the three
// agent.json changes. Every HTTP call is a fake; no key here is real.
const { test } = require('node:test');
const assert = require('node:assert');
const { gather, REGISTRY, aiAnswersSource, MAX_QUESTIONS_PER_VENUE } = require('../lib/agent-sources');
const { loadAgent } = require('../lib/agent-runner');
const { lint } = require('../lib/ai-tells');
const { dueAgents } = require('../jobs/agent_run');

const VENUES = [{ code: 'TBT', name: 'The Bell Tower', category: 'historic wedding venues in Nashville' }, { code: 'SWF', name: 'Saddle Woods Farm' }];
const noKeychain = () => null;
const NO_CONFIG = '/nonexistent/anthropic_api_key';

function fakeAssistants(log, { claudeStatus = 200 } = {}) {
  return async (url, opt) => {
    const body = JSON.parse(opt.body);
    log.push({ url, headers: opt.headers, body });
    const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
    if (url.includes('anthropic.com')) {
      if (claudeStatus !== 200 && body.tools) return reply(claudeStatus, { error: { message: 'tool not allowed' } });
      return reply(200, { content: [{ type: 'server_tool_use' }, { type: 'text', text: 'Claude says: ' + body.messages[0].content }] });
    }
    if (url.includes('openai.com') || url.includes('perplexity.ai')) return reply(200, { choices: [{ message: { content: 'chat says ' + 'x'.repeat(3000) } }] });
    if (url.includes('googleapis.com')) return reply(200, { candidates: [{ content: { parts: [{ text: 'Gemini says hi' }] } }] });
    return reply(404, {});
  };
}

test('missing keys: those assistants are skipped, not failed, and the run still has a source', async () => {
  const log = [];
  const r = await gather([{ type: 'ai_answers', venues: VENUES }],
    { env: { ANTHROPIC_API_KEY: 'sk-test-only' }, keychain: noKeychain, configFile: NO_CONFIG, fetch: fakeAssistants(log), lint });
  assert.strictEqual(r.unavailable.length, 0);
  assert.strictEqual(r.got.length, 1);
  assert.match(r.got[0].table, /\| chatgpt \| 0 \| 0 \| skipped: no key \|/);
  assert.match(r.got[0].table, /\| gemini \| 0 \| 0 \| skipped: no key \|/);
  assert.match(r.got[0].table, /\| perplexity \| 0 \| 0 \| skipped: no key \|/);
  assert.match(r.got[0].table, /\| claude \| 3 \| 0 \| \|/);
  assert.ok(log.every((c) => c.url.includes('anthropic.com')), 'no call to an assistant without a key');
  const direct = await aiAnswersSource({ type: 'ai_answers', venues: VENUES }, { env: { ANTHROPIC_API_KEY: 'k' }, keychain: noKeychain, configFile: NO_CONFIG, fetch: fakeAssistants([]) });
  assert.deepStrictEqual(direct.skipped.map((s) => [s.assistant, s.skipped, s.why]), [['chatgpt', true, 'no key'], ['gemini', true, 'no key'], ['perplexity', true, 'no key']]);
});

test('no key at all: the source is unavailable with every assistant named, never a crash', async () => {
  const r = await gather([{ type: 'ai_answers', venues: VENUES }], { env: {}, keychain: noKeychain, configFile: NO_CONFIG, fetch: fakeAssistants([]), lint });
  assert.strictEqual(r.got.length, 0);
  assert.match(r.unavailable[0].why, /claude: no key, chatgpt: no key, gemini: no key, perplexity: no key/);
});

test('Claude path: the agents\' key and model, web search tool, the question text, answers in the source', async () => {
  const log = [];
  const r = await aiAnswersSource({ type: 'ai_answers', assistants: ['claude'], venues: VENUES },
    { env: { ANTHROPIC_API_KEY: 'sk-test-only', AGENT_MODEL: 'claude-test-model' }, keychain: noKeychain, configFile: NO_CONFIG, fetch: fakeAssistants(log) });
  assert.strictEqual(log.length, 3);                          // TBT asks 2, SWF (no category) asks 1
  assert.strictEqual(log[0].headers['x-api-key'], 'sk-test-only');
  assert.strictEqual(log[0].body.model, 'claude-test-model');
  assert.strictEqual(log[0].body.tools[0].name, 'web_search');
  assert.strictEqual(log[0].body.messages[0].content, 'What is The Bell Tower in Nashville and what kind of events is it known for?');
  assert.strictEqual(log[1].body.messages[0].content, 'What are the best historic wedding venues in Nashville?');
  assert.match(r.text, /### claude \| TBT \| What is The Bell Tower/);
  assert.match(r.text, /Claude says: What is Saddle Woods Farm/);
  assert.match(r.text, /canonical venue facts/);
});

test('Claude falls back to a plain question once if web search is refused, then stays plain', async () => {
  const log = [];
  const r = await aiAnswersSource({ type: 'ai_answers', assistants: ['claude'], venues: VENUES },
    { env: { ANTHROPIC_API_KEY: 'k' }, keychain: noKeychain, configFile: NO_CONFIG, fetch: fakeAssistants(log, { claudeStatus: 400 }) });
  assert.strictEqual(log.length, 4);                          // 3 questions + one retry
  assert.strictEqual(log.filter((c) => c.body.tools).length, 1);
  assert.strictEqual(r.calls, 4);
  assert.match(r.table, /\| claude \| 3 \| 0 \|/);
});

test('total calls are bounded: at most 2 per venue per assistant (plus one Claude retry), answers cut at 1500 characters', async () => {
  const log = [];
  const venues = Array.from({ length: 7 }, (_, i) => ({ code: 'V' + i, name: 'Venue ' + i, category: 'wedding venues in Nashville' }));
  const env = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g', PERPLEXITY_API_KEY: 'p' };
  const r = await aiAnswersSource({ type: 'ai_answers', venues }, { env, keychain: noKeychain, configFile: NO_CONFIG, fetch: fakeAssistants(log) });
  assert.strictEqual(MAX_QUESTIONS_PER_VENUE, 2);
  assert.ok(log.length <= venues.length * 2 * 4 + 1, `${log.length} calls`);
  assert.strictEqual(log.length, 56);
  assert.strictEqual(r.calls, 56);
  for (const host of ['anthropic.com', 'openai.com', 'googleapis.com', 'perplexity.ai']) assert.strictEqual(log.filter((c) => c.url.includes(host)).length, 14, host);
  assert.match(r.text, /x{1000,}\.*.*\[truncated\]/);
  assert.ok(!/x{1500,}/.test(r.text));
  assert.strictEqual(log.find((c) => c.url.includes('openai.com')).headers.Authorization, 'Bearer o');
  assert.strictEqual(log.find((c) => c.url.includes('googleapis.com')).headers['x-goog-api-key'], 'g');
});

test('keys are read from the Keychain items when env is empty', async () => {
  const log = [];
  const items = { 'openai-api-key': 'ko', 'gemini-api-key': 'kg', 'perplexity-api-key': 'kp', 'anthropic-api-key': 'ka' };
  const r = await aiAnswersSource({ type: 'ai_answers', venues: VENUES.slice(1) }, { env: {}, keychain: (s) => items[s] || null, configFile: NO_CONFIG, fetch: fakeAssistants(log) });
  assert.strictEqual(r.skipped.length, 0);
  assert.strictEqual(log.length, 4);
  assert.strictEqual(log.find((c) => c.url.includes('anthropic.com')).headers['x-api-key'], 'ka');
});

test('an assistant error is reported on the card, the others still answer', async () => {
  const web = async (url, opt) => (url.includes('openai.com') ? { status: 500, text: async () => 'down' } : fakeAssistants([])(url, opt));
  const r = await aiAnswersSource({ type: 'ai_answers', assistants: ['chatgpt', 'gemini'], venues: VENUES.slice(1) },
    { env: { OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' }, keychain: noKeychain, configFile: NO_CONFIG, fetch: web });
  assert.match(r.table, /\| chatgpt \| 0 \| 1 \|/);
  assert.match(r.text, /\(no answer: answered 500\)/);
  assert.match(r.text, /Gemini says hi/);
});

// ------------------------------------------------------------- the agent.json changes

const EM = '—'; const EN = '–';

test('agent.json sources validate: every type is registered, no pending source left where the order replaced it', () => {
  for (const slug of ['monthly-report', 'citations']) { // #1699: listings folded into citations
    const a = loadAgent(slug);
    for (const s of a.sources) {
      assert.ok(REGISTRY[s.type], `${slug}: unknown source type ${s.type}`);
      if (s.type === 'dashboard') assert.ok(Array.isArray(s.paths) && s.paths.every((p) => p.startsWith('/api/')), slug);
      if (s.type === 'file') assert.ok(s.path || s.newest, slug);
      if (s.type === 'ai_answers') {
        assert.deepStrictEqual(s.assistants, ['claude', 'chatgpt', 'gemini', 'perplexity']);
        assert.ok(s.venues.length && s.venues.every((v) => v.code && v.name), slug);
      }
    }
    const text = JSON.stringify(a) + a.skill;
    assert.ok(!text.includes(EM) && !text.includes(EN), `${slug} has an em or en dash`);
  }
  const mr = loadAgent('monthly-report');
  assert.ok(mr.sources.some((s) => s.type === 'dashboard' && s.paths.includes('/api/funnel/monthly')));
  assert.ok(!mr.sources.some((s) => s.type === 'pending' && /HubSpot/.test(s.label)));
  assert.deepStrictEqual(mr.character.needs, ['A read-only dashboard key in the Box Keychain (marketing-fleet-key)', 'The ads export Sheet']);
  assert.ok(!/Katherine's call|stages count/i.test(mr.skill));

  const c = loadAgent('citations');
  assert.ok(!c.sources.some((s) => s.type === 'pending'));
  assert.ok(c.sources.some((s) => s.type === 'file' && s.newest === '07_Marketing_and_Brand/Listings/DIRECTORY_LISTINGS_'));
  assert.ok(c.character.needs.includes('Keys for ChatGPT, Gemini and Perplexity (Claude runs now)'));
  assert.ok(dueAgents('2026-10-15').includes('citations') && !dueAgents('2026-10-14').includes('citations'));
  assert.match(c.cadence, /^the 15th of each month, 06:00 CT/); // #1699 adds the quarterly packs

  // #1699: Listings lives inside Citations now; the listings draft is read but not required, so the monthly check still runs without it.
  assert.ok(c.sources.some((s) => s.newest === '07_Marketing_and_Brand/Listings/DIRECTORY_LISTINGS_' && !s.required));
  assert.ok(c.character.needs.includes('Katherine confirms which listings are paid and who owns each login (draft is in 07_Marketing_and_Brand/Listings/)'));
});

test('monthly report: the dashboard source asks /api/funnel/monthly with the fleet key', async () => {
  const seen = [];
  const web = async (url, opt) => { seen.push([url, opt.headers.Authorization]); return { status: 200, json: async () => ({ month: '2026-09', leads: { total: 4 } }) }; };
  const src = loadAgent('monthly-report').sources.find((s) => s.paths && s.paths.includes('/api/funnel/monthly'));
  const r = await gather([src], { env: { MARKETING_FLEET_KEY: 'mkt_test', MARKETING_BASE_URL: 'https://example.test' }, fetch: web, lint });
  assert.deepStrictEqual(seen, [['https://example.test/api/funnel/monthly', 'Bearer mkt_test']]);
  assert.match(r.got[0].text, /"total":4/);
});
