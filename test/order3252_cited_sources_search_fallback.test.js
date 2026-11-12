'use strict';
// ORDER #3252 (REPLY #3250 follow-on 3): the ai_cited_sources Claude call survives
// a refused web-search tool the way the ai_answers call already did: a 400 that
// names the tool is retried ONCE without `tools`, later questions stay plain, and
// the result says it came without live search. Any other 400 is not retried.
// Every HTTP call here is a fake; no key is real and nothing leaves the machine.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { aiCitedSourcesSource, aiAnswersSource } = require('../lib/agent-sources');

const VENUES = [{ name: 'The Bridge Building', aliases: ['Bridge Building'] }];
const PROMPTS = ['best event venues for rent in Nashville, TN', 'corporate event venues in Nashville'];
const NO_CONFIG = '/nonexistent/anthropic_api_key';
const TOOL_400 = { type: 'error', error: { type: 'invalid_request_error', message: "tools.0: Input tag 'web_search_20250305' found using 'type' does not match any of the expected tags" } };
const OTHER_400 = { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be greater than or equal to 1' } };

const page = (body) => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => body, url: '' });
const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });

function fakeFetch(log, { claude400 = null, perplexity = true } = {}) {
  return async (u, o = {}) => {
    if (u.includes('api.anthropic.com')) {
      const body = JSON.parse(o.body);
      log.push(body);
      if (claude400 === 'tool' && body.tools) return reply(400, TOOL_400);
      if (claude400 === 'other') return reply(400, OTHER_400);
      return reply(200, { content: [{ type: 'text', text: 'plain answer, no sources' }] });
    }
    if (u.includes('api.perplexity.ai')) return reply(200, { citations: ['https://www.partyslate.com/find-venues/near/nashville'] });
    if (u.includes('partyslate')) return page('<p>The Bridge Building</p>');
    return page('');
  };
}

const src = () => ({ type: 'ai_cited_sources', prompts: PROMPTS.slice(), venues: VENUES, our_domains: [] });
const ctxFor = (fetch, keys) => ({ env: keys, fetch, keychain: () => null, configFile: NO_CONFIG });

test('#3252 RED: web search refused (400 naming the tool): Claude retries once without tools, stays plain, and the result says "no live search"', async () => {
  const log = [];
  const r = await aiCitedSourcesSource(src(), ctxFor(fakeFetch(log, { claude400: 'tool' }), { ANTHROPIC_API_KEY: 'k', PERPLEXITY_API_KEY: 'p' }));
  assert.ok(r.ok, r.why);
  assert.strictEqual(log.length, 3, 'two searches + exactly one retry');
  assert.strictEqual(log.filter((b) => b.tools).length, 1, 'only the first request carried the tool');
  assert.ok(log.every((b) => b.model && b.max_tokens === 1024 && b.messages[0].content), 'same request otherwise');
  assert.strictEqual(r.noLiveSearch, true);
  assert.match(r.table, /no live search/i);
  assert.doesNotMatch(r.text, /answered 400/, 'the refusal is not reported as a failed answer');
  assert.match(r.table, /\| partyslate\.com \| 1 \| 2 \| The Bridge Building \|/);
});

test('#3252 RED: Claude the only assistant and its search refused: a result marked "no live search", not an error', async () => {
  const log = [];
  const r = await aiCitedSourcesSource(src(), ctxFor(fakeFetch(log, { claude400: 'tool' }), { ANTHROPIC_API_KEY: 'k' }));
  assert.ok(r.ok, r.why);
  assert.strictEqual(r.noLiveSearch, true);
  assert.match(r.text, /no live search/i);
  assert.strictEqual(log.length, 3);
});

test('#3252 known-bad: any other 400 is NOT retried and still surfaces as "answered 400", as it did before', async () => {
  const log = [];
  const both = await aiCitedSourcesSource(src(), ctxFor(fakeFetch(log, { claude400: 'other' }), { ANTHROPIC_API_KEY: 'k', PERPLEXITY_API_KEY: 'p' }));
  assert.ok(both.ok, both.why);
  assert.strictEqual(log.length, 2, 'one request per search, no retry');
  assert.ok(log.every((b) => b.tools && b.tools[0].type === 'web_search_20250305'), 'the tool was never dropped');
  assert.ok(!both.noLiveSearch);
  assert.match(both.text, /Not answered: claude on "best event venues for rent in Nashville, TN": answered 400/);
  const alone = await aiCitedSourcesSource(src(), ctxFor(fakeFetch([], { claude400: 'other' }), { ANTHROPIC_API_KEY: 'k' }));
  assert.strictEqual(alone.ok, false);
  assert.match(alone.why, /no assistant cited a page \(claude on .*: answered 400/);
});

test('#3252: the ai_answers call shares the same rule: a 400 not about the tool is not retried there either', async () => {
  const log = [];
  await aiAnswersSource({ type: 'ai_answers', assistants: ['claude'], venues: [{ code: 'SWF', name: 'Saddle Woods Farm' }] },
    ctxFor(fakeFetch(log, { claude400: 'other' }), { ANTHROPIC_API_KEY: 'k' }));
  assert.strictEqual(log.length, 1, 'one question, no retry');
  assert.ok(log[0].tools, 'the tool stayed on');
});

test('#3252: one fallback, not two: the web-search tool is spelled once in agent-sources.js and both call sites go through the shared helper', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-sources.js'), 'utf8');
  assert.strictEqual((s.match(/web_search_20250305/g) || []).length, 1);
  assert.strictEqual((s.match(/claudeWithSearch\(/g) || []).length, 3, 'defined once, called at ai_answers and ai_cited_sources');
});
