'use strict';
// ORDER #1758: the marketing agents' seen-before memory.
//
// Known-bad first: on main (06dc7da) a second run over the same review pulse,
// the same convention company or the same press request drafts every card
// again. Each agent below is run with its REAL agent.json (the seen_before spec
// is the thing under test), a memory store, a fake model and a web that refuses
// every call, so nothing is published, sent or pinned by any test.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent, modelText } = require('../lib/agent-runner');
const { digestBody } = require('../lib/agent-digest');

// A project tree with one review pulse and one events file in it.
function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt1758-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return { IHG_TREE: root };
}

// The model answers every call with the same cards; the Copywriter call gets
// them too, finds no verdict, and the card says "Copy check did not run".
function model(cards) {
  const calls = [];
  return { model: 'fake', calls, async complete(req) { calls.push(req); return JSON.stringify({ cards: cards() }); } };
}

// The web: every call is refused and counted. Nothing may go out.
function web() {
  const calls = [];
  const f = async (url) => { calls.push(String(url)); throw new Error('no network in this test'); };
  f.calls = calls;
  return f;
}

const PULSE = { '07_Marketing_and_Brand/Venue_Review_Pulse_2026-10.md': '# Review pulse 10.2026\n- The Bridge Building, Google, Ana P.: "Lovely night."\n- Saddle Woods Farm, The Knot, Ben R.: "Great team."' };
const gbpCards = (text = 'Lovely night.') => [
  { title: 'Reply to Ana P. on Google', target: 'The Bridge Building', body: 'Thank you, Ana. We loved hosting you.',
    seen: { venue: 'The Bridge Building', reviewer: 'Ana P.', platform: 'Google', review_text: text } },
  { title: 'Reply to Ben R. on The Knot', target: 'Saddle Woods Farm', body: 'Thank you, Ben. The team was glad to help.',
    seen: { venue: 'Saddle Woods Farm', reviewer: 'Ben R.', platform: 'The Knot', review_text: 'Great team.' } },
];

test('KNOWN-BAD: two GBP runs on the same review pulse draft cards only on the first', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, PULSE);
  const fetchImpl = web();
  const llm = model(() => gbpCards());
  const r1 = await runAgent({ slug: 'gbp', store, llm, env, fetchImpl, scheduled: true });
  assert.ok(r1.ok, r1.error);
  assert.strictEqual(r1.cards.length, 2, 'the first run drafts both replies');
  const r2 = await runAgent({ slug: 'gbp', store, llm, env, fetchImpl, scheduled: true });
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(r2.cards.length, 0, 'the second run over the same pulse redrafts nothing');
  assert.strictEqual(store.cards.length, 2);
  assert.strictEqual(store.runList[1].seen_skipped, 2, 'the run records how many it skipped');
  assert.match(store.runList[1].note, /2 skipped as already seen/);
  assert.strictEqual(fetchImpl.calls.length, 0, 'nothing went out');
});

test('KNOWN-BAD: one Convention Connector company and event is drafted once', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, { 'events.md': '# Nashville events\n- Acme DMC works the Music Expo, 03.02.2027 to 03.05.2027' });
  const def = { ...loadAgent('convention-connector'), sources: [{ type: 'file', path: 'events.md', required: true, label: 'the events' }] };
  const fetchImpl = web();
  const llm = model(() => [{ title: 'Acme DMC: offsite nights for the Music Expo', target: 'Acme DMC', body: 'A short note offering our venues for Expo receptions.',
    seen: { company: 'Acme DMC', event: 'Music Expo', event_dates: '03.02.2027 to 03.05.2027' } }]);
  const r1 = await runAgent({ def, store, llm, env, fetchImpl, scheduled: true });
  const r2 = await runAgent({ def, store, llm, env, fetchImpl, scheduled: true });
  assert.ok(r1.ok && r2.ok);
  assert.strictEqual(r1.cards.length, 1);
  assert.strictEqual(r2.cards.length, 0, 'the same company and event is not redrafted on the next Monday');
  assert.strictEqual(r2.seen_skipped, 1);
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('KNOWN-BAD: one PR Patty request is pitched once', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, { 'press.md': '# Press requests\n- Qwoted 88123: Nashville venue experts for a fall wedding story' });
  const def = { ...loadAgent('pr-patty'), skip_when_nothing_new: false, sources: [{ type: 'file', path: 'press.md', required: true, label: 'press requests' }] };
  const fetchImpl = web();
  const llm = model(() => [{ title: 'Pitch: fall weddings in Nashville', target: 'Qwoted', body: 'A short pitch with our real venue facts.',
    seen: { request_id_or_url: 'Qwoted 88123' } }]);
  const r1 = await runAgent({ def, store, llm, env, fetchImpl, scheduled: true });
  const r2 = await runAgent({ def, store, llm, env, fetchImpl, scheduled: true });
  assert.strictEqual(r1.cards.length, 1);
  assert.strictEqual(r2.cards.length, 0);
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('the model is told the fields to name and, on the next run, what it already drafted', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, PULSE);
  const llm = model(() => gbpCards());
  await runAgent({ slug: 'gbp', store, llm, env, fetchImpl: web(), scheduled: true });
  assert.match(llm.calls[0].system, /SEEN-BEFORE MEMORY: add to every card "seen": \{"venue", "reviewer", "platform", "review_id" \(when known\), "review_text"\}/);
  assert.doesNotMatch(llm.calls[0].user, /ALREADY DRAFTED/);
  const n = llm.calls.length;
  await runAgent({ slug: 'gbp', store, llm, env, fetchImpl: web(), scheduled: true });
  assert.match(llm.calls[n].user, /ALREADY DRAFTED[\s\S]*venue=the bridge building\|reviewer=ana p\|platform=google \(waiting for review\)/);
});

test('approved and waiting items are skipped; a rejected one comes back only when its source changed, and says so', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, PULSE);
  let text = 'Lovely night.';
  const llm = model(() => gbpCards(text));
  await runAgent({ slug: 'gbp', store, llm, env, fetchImpl: web(), scheduled: true });
  const [ana, ben] = store.cards;
  await store.decide(ana.id, { action: 'reject', who: 'katherine@x', reason: 'too short' });
  await store.decide(ben.id, { action: 'approve', who: 'katherine@x' });
  assert.strictEqual(store.cards[1].status, 'ready');

  // Rejected, same review text: still skipped. Approved: skipped.
  const r2 = await runAgent({ slug: 'gbp', store, llm, env, fetchImpl: web(), scheduled: true });
  assert.strictEqual(r2.cards.length, 0);
  assert.strictEqual(r2.seen_skipped, 2);

  // The reviewer edited the review: the rejected item comes back, once, with a note.
  text = 'Lovely night, and the bar team was quick.';
  const r3 = await runAgent({ slug: 'gbp', store, llm, env, fetchImpl: web(), scheduled: true });
  assert.strictEqual(r3.cards.length, 1);
  assert.strictEqual(r3.seen_skipped, 1, 'the approved one stays skipped');
  const back = r3.cards[0];
  assert.match(back.body, /### Seen before\n\nThis item was drafted before and rejected on \d\d\.\d\d\.\d{4} \("too short"\)\. It is back because its source changed: review text\./);
  assert.ok(!modelText(back.body).includes('Seen before'), 'the note is the Box\'s, never linted as the bot\'s words');
  assert.deepStrictEqual(back.seen_source, { review_text: text });
  const r4 = await runAgent({ slug: 'gbp', store, llm, env, fetchImpl: web(), scheduled: true });
  assert.strictEqual(r4.cards.length, 0, 'the returned card is now waiting, so it is not drafted a third time');
});

test('a card the model did not key is saved as before; the same item twice in one run is saved once', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, PULSE);
  const llm = model(() => [
    { title: 'Post idea for Saddle Woods Farm', target: 'Saddle Woods Farm', body: 'A fall post for the quietest venue.' },
    gbpCards()[0], gbpCards()[0],
  ]);
  const r1 = await runAgent({ slug: 'gbp', store, llm, env, fetchImpl: web(), scheduled: true });
  assert.deepStrictEqual(r1.cards.map((c) => c.title), ['Post idea for Saddle Woods Farm', 'Reply to Ana P. on Google']);
  assert.strictEqual(r1.seen_skipped, 1);
  const r2 = await runAgent({ slug: 'gbp', store, llm, env, fetchImpl: web(), scheduled: true });
  assert.deepStrictEqual(r2.cards.map((c) => c.title), ['Post idea for Saddle Woods Farm'], 'the memory never hides a card it cannot match');
});

test('Bloggy Bob: a Run now for a keyword already drafted answers with one card saying so', async () => {
  const store = createMemoryStore({ lint });
  const def = { ...loadAgent('bloggy-bob'), copy_prepass: false, sources: [{ type: 'request', required: true, label: 'the request' }] };
  const llm = model(() => [{ title: 'Nashville rooftop wedding venues', target: 'thebridgebuilding.com', body: 'A draft post outline.',
    seen: { target_keyword_or_url: 'nashville rooftop wedding venues' } }]);
  const r1 = await runAgent({ def, store, llm, ask: 'a post on Nashville rooftop wedding venues', fetchImpl: web() });
  assert.strictEqual(r1.cards.length, 1);
  const r2 = await runAgent({ def, store, llm, ask: 'a post on Nashville rooftop wedding venues', fetchImpl: web() });
  assert.strictEqual(r2.cards.length, 1);
  assert.match(r2.cards[0].title, /already drafted, nothing new/);
  assert.match(r2.cards[0].body, /Nashville rooftop wedding venues: on the Review tab/);
});

test('an agent with no seen_before spec is unchanged', async (t) => {
  const store = createMemoryStore({ lint });
  const def = { slug: 'demo', name: 'Demo Agent', job: 'j', max_cards: 2, skill: '# Demo', sources: [{ type: 'request', required: true, label: 'the request' }] };
  const llm = model(() => [{ title: 'Same', body: 'Same words.', seen: { anything: 'x' } }]);
  await runAgent({ def, store, llm, ask: 'x' });
  await runAgent({ def, store, llm, ask: 'x' });
  assert.strictEqual(store.cards.length, 2);
  assert.doesNotMatch(llm.calls[0].system, /SEEN-BEFORE/);
  assert.strictEqual(store.cards[0].seen_key, undefined);
});

test('the Monday digest states how many items each run skipped as already seen', () => {
  const names = new Map([['gbp', 'Google Business'], ['scout', 'Scout']]);
  const body = digestBody({ cards: [], runs: [
    { agent: 'gbp', status: 'done', unavailable: [], seen_skipped: 2 },
    { agent: 'gbp', status: 'done', unavailable: [], seen_skipped: 0 },
    { agent: 'gbp', status: 'done', unavailable: [], seen_skipped: 3 },
    { agent: 'scout', status: 'done', unavailable: [], seen_skipped: 0 },
  ] }, names);
  assert.match(body, /### Skipped as already drafted\n- Google Business: 5 items \(runs: 2, 0, 3\)/);
  assert.doesNotMatch(body, /- Scout:/);
  assert.match(digestBody({ cards: [], runs: [] }, names), /No run skipped an item as already drafted this week\./);
});

test('keys: case, punctuation and URL dressing do not make a new item; a missing required field gives no key', () => {
  const { seenKey, sourceChanges } = require('../lib/agent-seen');
  const spec = { key: ['venue', 'reviewer', 'platform', 'review_id?'] };
  const a = seenKey(spec, { venue: 'The Bridge Building', reviewer: 'Ana P.', platform: 'Google' });
  assert.strictEqual(a, seenKey(spec, { venue: 'the bridge  building', reviewer: 'ana p', platform: 'GOOGLE' }));
  assert.notStrictEqual(a, seenKey(spec, { venue: 'The Bridge Building', reviewer: 'Ana P.', platform: 'Google', review_id: 'r9' }));
  assert.strictEqual(seenKey(spec, { venue: 'The Bridge Building', platform: 'Google' }), null);
  const url = { key: ['request_id_or_url'] };
  assert.strictEqual(seenKey(url, { request_id_or_url: 'https://www.qwoted.com/r/88123/' }), seenKey(url, { request_id_or_url: 'qwoted.com/r/88123' }));
  assert.deepStrictEqual(sourceChanges({ event_dates: '03.02.2027' }, { event_dates: '04.02.2027' }), ['event_dates']);
  assert.deepStrictEqual(sourceChanges({}, { event_dates: '04.02.2027' }), [], 'unknown before is not a change');
});

test('the four agents carry the ruled keys', () => {
  assert.deepStrictEqual(loadAgent('gbp').seen_before, { key: ['venue', 'reviewer', 'platform', 'review_id?'], source: ['review_text'] });
  assert.deepStrictEqual(loadAgent('convention-connector').seen_before, { key: ['company', 'event'], source: ['event_dates'] });
  assert.deepStrictEqual(loadAgent('pr-patty').seen_before.key, ['request_id_or_url']);
  assert.deepStrictEqual(loadAgent('bloggy-bob').seen_before.key, ['target_keyword_or_url']);
});
