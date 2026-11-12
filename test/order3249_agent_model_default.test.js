'use strict';
// ORDER #3249 (#3218 row 3): the marketing agents' default model is
// claude-sonnet-5-5, and AGENT_MODEL still overrides it everywhere the agent
// path reads it. Every HTTP call is a stub; no key here is real and no
// request leaves the process.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createTextClient, DEFAULT_MODEL } = require('../lib/agent-llm');
const { aiAnswersSource, aiCitedSourcesSource } = require('../lib/agent-sources');

const noKeychain = () => null;
const NO_CONFIG = '/nonexistent/anthropic_api_key';
const refused = async () => { throw new Error('network refused in test'); };

function stubAnthropic(log) {
  return async (url, opt) => {
    const body = JSON.parse(opt.body);
    log.push({ url, body });
    if (!url.includes('anthropic.com')) throw new Error('network refused in test: ' + url);
    const json = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
    return { ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json };
  };
}

function withAgentModel(value, fn) {
  const saved = process.env.AGENT_MODEL;
  if (value === undefined) delete process.env.AGENT_MODEL; else process.env.AGENT_MODEL = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.AGENT_MODEL; else process.env.AGENT_MODEL = saved;
  }
}

test('(a) AGENT_MODEL unset: DEFAULT_MODEL and createTextClient\'s model are claude-sonnet-5-5', async () => {
  assert.strictEqual(DEFAULT_MODEL, 'claude-sonnet-5-5');
  const log = [];
  const c = withAgentModel(undefined, () => createTextClient({ apiKey: 'sk-test-only', fetchImpl: stubAnthropic(log) }));
  assert.strictEqual(c.model, 'claude-sonnet-5-5');
  await c.complete({ system: 's', user: 'u' });
  assert.strictEqual(log[0].body.model, 'claude-sonnet-5-5');
});

test('(a) AGENT_MODEL unset: both agent-sources Claude call sites send claude-sonnet-5-5', async () => {
  const log = [];
  await aiAnswersSource({ type: 'ai_answers', assistants: ['claude'], venues: [{ code: 'SWF', name: 'Saddle Woods Farm' }] },
    { env: { ANTHROPIC_API_KEY: 'sk-test-only' }, keychain: noKeychain, configFile: NO_CONFIG, fetch: stubAnthropic(log) });
  await aiCitedSourcesSource({ type: 'ai_cited_sources', prompts: ['best Nashville venues'], venues: [] },
    { env: { ANTHROPIC_API_KEY: 'sk-test-only' }, keychain: noKeychain, configFile: NO_CONFIG, fetch: stubAnthropic(log) });
  const claude = log.filter((c) => c.url.includes('anthropic.com'));
  assert.ok(claude.length >= 2, 'both call sites reached the stub');
  assert.ok(claude.every((c) => c.body.model === 'claude-sonnet-5-5'), JSON.stringify(claude.map((c) => c.body.model)));
});

test('(b) AGENT_MODEL set: it wins in createTextClient', async () => {
  const log = [];
  const c = withAgentModel('claude-test-override', () => createTextClient({ apiKey: 'sk-test-only', fetchImpl: stubAnthropic(log) }));
  assert.strictEqual(c.model, 'claude-test-override');
  await c.complete({ system: 's', user: 'u' });
  assert.strictEqual(log[0].body.model, 'claude-test-override');
  // network refused: a client with a refusing fetch throws, it never reaches the API
  const r = withAgentModel('claude-test-override', () => createTextClient({ apiKey: 'k', fetchImpl: refused }));
  await assert.rejects(r.complete({ system: 's', user: 'u' }), /network refused/);
});

test('(b) AGENT_MODEL set: it wins at both agent-sources call sites (:370 ai_answers, :802 ai_cited_sources)', async () => {
  const env = { ANTHROPIC_API_KEY: 'sk-test-only', AGENT_MODEL: 'claude-test-override' };
  const a = [];
  await aiAnswersSource({ type: 'ai_answers', assistants: ['claude'], venues: [{ code: 'SWF', name: 'Saddle Woods Farm' }] },
    { env, keychain: noKeychain, configFile: NO_CONFIG, fetch: stubAnthropic(a) });
  assert.ok(a.length >= 1 && a.every((c) => c.body.model === 'claude-test-override'));
  const b = [];
  await aiCitedSourcesSource({ type: 'ai_cited_sources', prompts: ['best Nashville venues'], venues: [] },
    { env, keychain: noKeychain, configFile: NO_CONFIG, fetch: stubAnthropic(b) });
  assert.ok(b.length >= 1 && b.every((c) => c.body.model === 'claude-test-override'));
});

test('(c) no lib/agent-*.js file holds a claude- model literal other than DEFAULT_MODEL', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const hits = [];
  for (const f of fs.readdirSync(lib).filter((n) => /^agent-.*\.js$/.test(n))) {
    fs.readFileSync(path.join(lib, f), 'utf8').split('\n').forEach((line, i) => {
      if (/['"`]claude-[a-z0-9.-]+['"`]/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, ["agent-llm.js:10: const DEFAULT_MODEL = 'claude-sonnet-5-5';"]);
});
