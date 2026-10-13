'use strict';
// ORDER #1703: no claim about an outside page without a quote that is really on
// it. Mimi 10.13.2026: "well we need to do better."
const { test } = require('node:test');
const assert = require('node:assert');

const G = require('../lib/quote-gate');
const { runAgent, modelText } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { draftUrls } = require('../scripts/quote_recheck');

const KNOT_STE = 'https://theknot.com/marketplace/saint-elle-nashville-tn-2039859';
const WW_STE = 'https://www.weddingwire.com/biz/saint-elle/5110faf762b284d0.html';
// The real text of Saint Elle's WeddingWire page as the Box fetched it 10.13.2026 (excerpt).
const WW_STE_TEXT = "Message vendor Where is Saint Elle located? Open Map Location 1420 3rd Avenue South #101 Nashville, TN, 37210 615-369-6474 All visits are by APPOINTMENT ONLY.";
const PRIOR_OWNERS = 'The Knot page names three prior owners (Chandra Watson, Nealy Glenn, Leigh Watson) and calls The Cordelle "the owners\' first space".';

// The Knot answers the Box 403 (measured 10.13.2026 on all 7 venue pages).
function web(pages) {
  return async (url) => {
    const p = pages[url];
    if (!p) return { status: url.includes('theknot.com') ? 403 : 404, text: async () => '' };
    return { status: 200, text: async () => `<html><title>t</title><body><h1>x</h1><p>${p}</p><script>var x="Chandra Watson"</script></body></html>` };
  };
}

test('norm: whitespace, entities and curly quotes, case kept', () => {
  assert.strictEqual(G.norm('  Saint\n\tElle&#x27;s  &amp; ’x” '), "Saint Elle's & 'x\"");
  assert.ok(G.quoteFound('1420 3rd Avenue   South #101', WW_STE_TEXT));
  assert.ok(!G.quoteFound('1420 3rd avenue south #101', WW_STE_TEXT), 'case is kept');
  assert.ok(!G.quoteFound('Saint Elle', WW_STE_TEXT), 'a quote under the minimum proves nothing');
});

test('KNOWN BAD: the Saint Elle prior-owner sentence fails the gate', async () => {
  // On the Knot page itself: the Box cannot read it, so it is never verified.
  let r = await G.checkClaims([{ claim: PRIOR_OWNERS, url: KNOT_STE, quote: 'Chandra Watson, Nealy Glenn, Leigh Watson' }], G.snapshotter({ fetchImpl: web({}) }));
  assert.strictEqual(r.passed.length, 0);
  assert.match(r.failed[0].why, /not read this run \(page answered 403\)/);
  // Against real page text the Box did read: the quote is not on it.
  r = await G.checkClaims([{ claim: PRIOR_OWNERS, url: WW_STE, quote: 'Chandra Watson, Nealy Glenn, Leigh Watson' }], G.snapshotter({ fetchImpl: web({ [WW_STE]: WW_STE_TEXT }) }));
  assert.strictEqual(r.passed.length, 0);
  assert.strictEqual(r.failed[0].why, 'quote not found on the page fetched this run');
  // Script text is not page text: a name hidden in a <script> does not count.
  r = await G.checkClaims([{ claim: 'names Chandra Watson as owner', url: WW_STE, quote: 'Chandra Watson' }], G.snapshotter({ fetchImpl: web({ [WW_STE]: WW_STE_TEXT }) }));
  assert.strictEqual(r.passed.length, 0);
});

test('a real quote passes; no quote, short quote or no URL fails without guessing', async () => {
  let fetched = 0;
  const f = web({ [WW_STE]: WW_STE_TEXT });
  const snap = G.snapshotter({ fetchImpl: async (u, o) => { fetched++; return f(u, o); } });
  const r = await G.checkClaims([
    { claim: 'Address 1420 3rd Avenue South #101', url: WW_STE, quote: '1420 3rd Avenue South #101 Nashville, TN, 37210' },
    { claim: 'Phone is current', url: WW_STE, quote: '37210 615-369-6474' },
    { claim: 'no quote', url: WW_STE },
    { claim: 'short', url: WW_STE, quote: 'Elle' },
    { claim: 'no url', quote: '1420 3rd Avenue South' },
  ], snap);
  assert.deepStrictEqual(r.passed.map((p) => p.claim), ['Address 1420 3rd Avenue South #101', 'Phone is current']);
  assert.deepStrictEqual(r.failed.map((x) => x.why), ['no quote given', 'quote under 12 characters', 'no URL given']);
  assert.strictEqual(fetched, 1, 'one fetch per URL per run');
});

test('applyGate: failed claim becomes UNVERIFIED, "Verified" survives only beside a passed quote', () => {
  const body = [
    `| The Knot | Saint Elle | Verified. ${PRIOR_OWNERS} |`,
    '| WeddingWire | Saint Elle | Verified. 1420 3rd Avenue South #101 Nashville, TN, 37210 |',
    '| Zola | Saint Elle | Verified. Marked "Unclaimed". |',
    'This row was unverified before and stays that way.',
  ].join('\n');
  const out = G.applyGate(body, {
    passed: [{ claim: 'Address', url: WW_STE, quote: '1420 3rd Avenue South #101 Nashville, TN, 37210' }],
    failed: [{ claim: PRIOR_OWNERS, url: KNOT_STE, why: 'page not read this run (page answered 403)' }],
  });
  const lines = out.split('\n');
  assert.match(lines[0], /UNVERIFIED\. UNVERIFIED: The Knot page names three prior owners/);
  assert.match(lines[1], /\| Verified\. 1420/);
  assert.match(lines[2], /\| UNVERIFIED\. Marked/);
  assert.strictEqual(lines[3], 'This row was unverified before and stays that way.');
  assert.ok(!/\bVerified\b/.test(lines[0] + lines[2]));
});

test('runner: a card is gated before it is saved, and lists what was not checked', async () => {
  const store = createMemoryStore({ lint });
  const llm = { model: 'fake', complete: async () => JSON.stringify({ cards: [{ title: 'Saint Elle listings', target: 'STE',
    body: `Verified: ${PRIOR_OWNERS}\n\nThe WeddingWire address is 1420 3rd Avenue South #101.`,
    claims: [
      { claim: PRIOR_OWNERS, url: KNOT_STE, quote: 'Chandra Watson, Nealy Glenn, Leigh Watson' },
      { claim: 'The WeddingWire address is 1420 3rd Avenue South #101.', url: WW_STE, quote: '1420 3rd Avenue South #101 Nashville' },
    ] }] }) };
  const def = { slug: 'listings', name: 'Listings', job: 'test', skill: 'x', sources: [{ type: 'request' }], max_cards: 1 };
  const r = await runAgent({ slug: 'listings', def, store, llm, ask: 'check Saint Elle', fetchImpl: web({ [WW_STE]: WW_STE_TEXT }), now: () => new Date('2026-10-13T20:00:00Z') });
  assert.ok(r.ok, r.error);
  const card = r.cards[0];
  const words = modelText(card.body);
  assert.match(words, /UNVERIFIED: UNVERIFIED: The Knot page names/);
  assert.ok(!/\bVerified\b/.test(words), 'no "Verified" on a line without a passed quote');
  assert.match(card.body, /### Quotes checked this run \(10\.13\.2026 15:00 CT\)\n\n- The WeddingWire address is 1420 3rd Avenue South #101\.: "1420 3rd Avenue South #101 Nashville"/);
  assert.match(card.body, /### Not checked this run\n\n- UNVERIFIED: The Knot page names three prior owners.*page not read this run \(page answered 403\)/);
  assert.deepStrictEqual(card.checks.quotes, { passed: 1, failed: 1 });
  assert.match(card.body, /_Drafted by Listings/);
});

test('recheck script: every https URL in the draft table rows, http upgraded, no repeats', () => {
  const md = '| a | https://x.com/1 | n |\n| b | http://facebook.com/y | |\n| c | https://x.com/1 | |\nhttps://not-a-row.com\n';
  assert.deepStrictEqual(draftUrls(md), ['https://x.com/1', 'https://facebook.com/y']);
});
