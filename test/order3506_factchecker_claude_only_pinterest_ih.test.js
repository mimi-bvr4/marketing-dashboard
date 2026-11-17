// ORDER #3506: two Mimi rulings, 11.17.2026.
// 1. "Claude only for now." Listings + Citations (the publicist and fact-checker)
//    checks Claude's answers only. No ChatGPT, Gemini or Perplexity key is asked for;
//    their code path stays in place, switched OFF in the agent's config.
// 2. "IH as a group." The 4th brand Pinterest account (#3495) is the main
//    Infinity Hospitality Group account. IHG-wide or shared posts offer it by
//    default; Katherine can still pick another account.
// Every HTTP call is a fake; no key here is real.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { loadAgent } = require('../lib/agent-runner');
const { gather, aiCitedSourcesSource } = require('../lib/agent-sources');
const { lint } = require('../lib/ai-tells');
const PV = require('../lib/pinterest-venues');
const { characterOf } = require('../routes/agents');

const noKeychain = () => null;
const NO_CONFIG = '/nonexistent/anthropic_api_key';
const ALL_KEYS = { ANTHROPIC_API_KEY: 'sk-test-only', OPENAI_API_KEY: 'o-test', GEMINI_API_KEY: 'g-test', PERPLEXITY_API_KEY: 'p-test' };

function fakeAll(log) {
  return async (url, opt) => {
    log.push(url);
    const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
    if (url.includes('anthropic.com')) return reply(200, { content: [{ type: 'text', text: 'Claude answer', citations: [{ url: 'https://example.com/a' }] }] });
    if (url.includes('openai.com') || url.includes('perplexity.ai')) return reply(200, { choices: [{ message: { content: 'other' } }], citations: ['https://example.com/p'] });
    if (url.includes('googleapis.com')) return reply(200, { candidates: [{ content: { parts: [{ text: 'gem' }] } }] });
    return reply(200, '<html><body>page</body></html>');
  };
}

// ---------------------------------------------------------------- ruling 1
test('ruling 1: the Fact-Checker card waits on nobody for AI keys', () => {
  const c = loadAgent('citations');
  assert.ok(!c.character.needs.some((n) => /ChatGPT|Gemini|Perplexity/.test(n)), 'the keys line is gone from Waiting on');
  assert.ok(c.character.needs.includes('Katherine: confirm which listings are paid and who owns each login (draft is in 07_Marketing_and_Brand/Listings/)'));
  const shown = characterOf(c, [], {}, new Date(), null, {});
  assert.ok(!shown.needs.some((n) => /ChatGPT|Gemini|Perplexity/.test(n)));
  assert.ok(shown.does.some((d) => /Claude's answers/.test(d)), 'the card says it checks Claude\'s answers');
  assert.ok(!shown.does.some((d) => /ChatGPT|Gemini|Perplexity/.test(d) && !/switched off/.test(d)), 'no Does line promises the other AIs');
});

test('ruling 1: the config the agent reads says Claude only, with the other AIs kept but OFF', () => {
  const c = loadAgent('citations');
  const ans = c.sources.find((s) => s.type === 'ai_answers');
  assert.deepStrictEqual(ans.assistants, ['claude']);
  assert.deepStrictEqual(ans.assistants_off, ['chatgpt', 'gemini', 'perplexity']);
  assert.match(ans.ruling, /Mimi 11\.17\.2026/);
  assert.match(ans.ruling, /Claude only for now/);
  const cited = c.sources.find((s) => s.type === 'ai_cited_sources');
  assert.deepStrictEqual(cited.providers, ['claude']);
  assert.match(c.skill, /Claude only/);
  assert.ok(!/Claude, ChatGPT, Gemini and Perplexity, asked monthly/.test(c.skill));
});

test('ruling 1: even with every key present, only Claude is asked', async () => {
  const c = loadAgent('citations');
  const ans = c.sources.find((s) => s.type === 'ai_answers');
  const log = [];
  const r = await gather([{ ...ans, venues: ans.venues.slice(0, 1) }], { env: ALL_KEYS, keychain: noKeychain, configFile: NO_CONFIG, fetch: fakeAll(log), lint });
  assert.strictEqual(r.got.length, 1);
  assert.ok(log.length > 0 && log.every((u) => u.includes('anthropic.com')), `asked: ${log.join(', ')}`);
  const cited = c.sources.find((s) => s.type === 'ai_cited_sources');
  const log2 = [];
  await aiCitedSourcesSource({ ...cited, prompts: cited.prompts.slice(0, 1) }, { env: ALL_KEYS, keychain: noKeychain, configFile: NO_CONFIG, fetch: fakeAll(log2) });
  assert.ok(!log2.some((u) => u.includes('perplexity.ai')), 'Perplexity is off for cited sources too');
  assert.ok(log2.some((u) => u.includes('anthropic.com')));
});

test('ruling 1: the code path for the other AIs is still there, so it can be switched back on', async () => {
  const log = [];
  await gather([{ type: 'ai_answers', assistants: ['claude', 'chatgpt'], venues: [{ code: 'TBT', name: 'The Bell Tower' }] }],
    { env: ALL_KEYS, keychain: noKeychain, configFile: NO_CONFIG, fetch: fakeAll(log), lint });
  assert.ok(log.some((u) => u.includes('openai.com')));
  const log2 = [];
  await aiCitedSourcesSource({ type: 'ai_cited_sources', prompts: ['q'], venues: [], our_domains: [] },
    { env: ALL_KEYS, keychain: noKeychain, configFile: NO_CONFIG, fetch: fakeAll(log2) });
  assert.ok(log2.some((u) => u.includes('perplexity.ai')), 'no providers list: both, as #1715 built it');
});

// ---------------------------------------------------------------- ruling 2
test('ruling 2: the 4th brand account is Infinity Hospitality Group, connectable, not Nashville Event Bartending', () => {
  const fourth = PV.BRANDS[3];
  assert.strictEqual(fourth.code, 'IHG');
  assert.strictEqual(fourth.name, 'Infinity Hospitality Group');
  assert.strictEqual(fourth.site, 'infinityhospitalitygroup.com');
  assert.strictEqual(fourth.brand, true);
  assert.ok(!fourth.unconfirmed && !fourth.candidates);
  assert.strictEqual(PV.byCode('IHG'), fourth);
  assert.strictEqual(PV.byCode('NEB'), null);
  assert.strictEqual(PV.tokenItem('IHG'), 'pinterest-refresh-token-ihg');
  assert.strictEqual(PV.ACCOUNTS.length, 11);
  assert.strictEqual(PV.CONNECTABLE.length, 11);
});

test('ruling 2: an IHG-wide or shared post offers the IHG account by default, and Katherine can still pick another', () => {
  for (const link of ['https://infinityhospitalitygroup.com/blog/x/', 'https://nashvilleeventbartending.com/blog/x/', 'https://nashvilleweddingvenue.com/blog/x/']) {
    assert.deepStrictEqual(PV.venueForLink(link), { pick: true, offer: 'IHG' }, link);
    const pin = PV.placePin({ link, board: '(Katherine picks)' });
    assert.strictEqual(pin.venue, 'IHG', link);
    assert.strictEqual(pin.pick, true, link);
  }
  // Single-venue and single-brand sites are unchanged.
  assert.deepStrictEqual(PV.venueForLink('https://saddlewoodsfarm.com/blog/x/'), { venue: 'SWF' });
  assert.deepStrictEqual(PV.venueForLink('https://dreameventsandcatering.com/blog/x/'), { venue: 'DEC' });
  // Katherine picks another account on an IHG post.
  const card = { status: 'draft', payload: { pin: PV.placePin({ link: 'https://infinityhospitalitygroup.com/blog/x/', board: '' }) } };
  const accounts = [{ venue: 'TBT', connected: true, boards: [{ name: 'Downtown Weddings' }] }, { venue: 'IHG', connected: true, boards: [{ name: 'Weddings' }] }];
  const other = PV.choosePin(card, { venue: 'TBT', board: 'Downtown Weddings' }, accounts);
  assert.ok(other.payload, other.error);
  assert.strictEqual(other.payload.pin.venue, 'TBT');
  const ihg = PV.choosePin(card, { board: 'Weddings' }, accounts);
  assert.ok(ihg.payload, ihg.error);
  assert.strictEqual(ihg.payload.pin.venue, 'IHG');
});

test('ruling 2: Approve still waits for a real board; the "(Katherine picks)" placeholder is not a board', () => {
  const pin = PV.placePin({ link: 'https://infinityhospitalitygroup.com/blog/x/', board: '(Katherine picks)' });
  assert.deepStrictEqual(PV.pinBlockers(pin), ['the pin: pick a board']);
  assert.deepStrictEqual(PV.pinBlockers({ ...pin, board: 'Weddings' }), []);
});
