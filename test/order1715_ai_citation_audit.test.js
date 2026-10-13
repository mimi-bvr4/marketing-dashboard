// ORDER #1715: the AI citation audit (Mimi 10.13.2026, "Citation audit for AI is someting we need to look at for sure").
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { aiCitedSourcesSource, citedUrls, mentions } = require('../lib/agent-sources');
const { loadAgent } = require('../lib/agent-runner');

const VENUES = [{ name: 'The Bridge Building', aliases: ['Bridge Building'] }, { name: 'The Estate at Cherokee Dock', aliases: ['Cherokee Dock'] }];

test('cited pages are read from each provider: Claude citations first, else its search results; Perplexity citations and search_results', () => {
  const claude = { content: [{ type: 'text', text: 'x', citations: [{ url: 'https://www.peerspace.com/venues/nashville--tn' }] },
    { type: 'web_search_tool_result', content: [{ url: 'https://other.com/' }] }] };
  assert.deepStrictEqual(citedUrls('claude', claude), ['https://www.peerspace.com/venues/nashville--tn']);
  assert.deepStrictEqual(citedUrls('claude', { content: [{ type: 'web_search_tool_result', content: [{ url: 'https://a.com/' }, { url: 'https://a.com/' }] }] }), ['https://a.com/']);
  assert.deepStrictEqual(citedUrls('perplexity', { citations: ['https://cvent.com/x'], search_results: [{ url: 'https://partyslate.com/y' }] }), ['https://cvent.com/x', 'https://partyslate.com/y']);
  assert.deepStrictEqual(mentions('Book the Bridge Building today', VENUES), ['The Bridge Building']);
  assert.deepStrictEqual(mentions('Nothing of ours here', VENUES), []);
});

const page = (body) => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => body, url: '' });

test('the audit asks, collects cited pages, reads each, and flags the sites that never name us', async () => {
  const asked = [];
  const fetch = async (u, o = {}) => {
    if (u.includes('api.anthropic.com')) { asked.push('claude'); return { status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 't', citations: [{ url: 'https://www.peerspace.com/venues/nashville--tn' }, { url: 'https://thebridgebuilding.com/' }] }] }) }; }
    if (u.includes('api.perplexity.ai')) { asked.push('perplexity'); return { status: 200, text: async () => JSON.stringify({ citations: ['https://www.partyslate.com/find-venues/near/nashville', 'https://www.peerspace.com/venues/nashville--tn'] }) }; }
    if (u.includes('peerspace')) return page('<p>Loft spaces and rooftops</p>');
    if (u.includes('partyslate')) return page('<p>The Bridge Building and The Estate at Cherokee Dock</p>');
    return page('');
  };
  const src = { type: 'ai_cited_sources', prompts: ['best event venues for rent in Nashville, TN', 'corporate event venues in Nashville'], venues: VENUES, our_domains: ['thebridgebuilding.com'] };
  const r = await aiCitedSourcesSource(src, { env: { ANTHROPIC_API_KEY: 'k', PERPLEXITY_API_KEY: 'p' }, fetch, keychain: () => null });
  assert.ok(r.ok, r.why);
  assert.deepStrictEqual(asked, ['claude', 'perplexity', 'claude', 'perplexity']);
  assert.match(r.table, /\| peerspace\.com \| 1 \| 2 \| NONE \|/);
  assert.match(r.table, /\| partyslate\.com \| 1 \| 2 \| The Bridge Building, The Estate at Cherokee Dock \|/);
  assert.match(r.table, /\| thebridgebuilding\.com \(OURS\) \| 1 \| 2 \| our own site \|/);
  assert.match(r.table, /\| https:\/\/www\.peerspace\.com\/venues\/nashville--tn \| claude, perplexity \|/);
  const none = await aiCitedSourcesSource(src, { env: {}, fetch, keychain: () => null, findApiKey: () => null });
  assert.match(none.why, /no Claude or Perplexity key/);
});

test('Citations carries the audit: the source, the searches, our 12 sites, and the new card in its instructions', () => {
  const a = loadAgent('citations');
  const s = a.sources.find((x) => x.type === 'ai_cited_sources');
  assert.ok(s && s.prompts.length >= 5 && s.our_domains.length === 12 && s.venues.length === 7);
  assert.match(a.skill, /Where AI gets its answers/);
  assert.match(a.skill, /business decision for Katherine and Mimi/);
  assert.ok(a.max_cards >= 5);
});
