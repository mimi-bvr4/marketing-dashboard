// ORDER #3802: the handoff map, the Producer firing the next team member on
// approve / on a new post (PRODUCER_HANDOFFS, default OFF), and each card's
// "Came from" and "Next".
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const H = require('../lib/handoff-map');
const KQ = require('../lib/keyword-queen');
const { takeAndRun } = require('../jobs/agent_requests');

const ON = { PRODUCER_HANDOFFS: 'on' };
const OFF = {};

function rig() {
  let t = Date.parse('2026-11-25T16:00:00Z');
  const clock = () => new Date(t);
  const tick = (min = 1) => { t += min * 60e3; };
  const store = createMemoryStore({ lint, now: clock });
  return { store, clock, tick };
}

const TOPICS = [
  { n: 1, keyword: 'nashville wedding venue', venue: 'The Bell Tower', topic: 'A winter wedding at the Bell Tower', volume: '880', difficulty: '31', source: 'Ubersuggest' },
  { n: 2, keyword: 'corporate holiday party nashville', venue: 'Infinity Event Center', topic: 'Holiday parties downtown' },
];

async function approvedQueenCard(store, clock) {
  return store.insert({ agent: 'keyword-queen', agent_name: 'Keyword Queen', job: 'keywords', title: 'This week', body: 'x',
    status: 'ready', decided_by: 'katherine@infinityhospitality.net', decided_at: clock(), payload: { topics: TOPICS } });
}

test('FEATURE FLAG line says default OFF, and off fires nothing', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/handoff-map.js'), 'utf8');
  assert.match(src, /FEATURE FLAG: PRODUCER_HANDOFFS default OFF/);
  const { store, clock } = rig();
  await approvedQueenCard(store, clock);
  const r = await H.fire({ store, env: OFF, now: clock });
  assert.strictEqual(r.on, false);
  assert.strictEqual(store.chains.length, 0);
});

test('the first pass with the switch on records the moment and fires nothing from before it', async () => {
  const { store, clock, tick } = rig();
  await approvedQueenCard(store, clock);
  tick();
  const first = await H.fire({ store, env: ON, now: clock });
  assert.ok(first.baseline);
  assert.strictEqual(first.queued.length, 0);
  tick();
  const second = await H.fire({ store, env: ON, now: clock });
  assert.strictEqual(second.queued.length, 0, 'a card approved before the switch is never fired');
});

test('an approved Keyword Queen card fires Bob per topic and Google Business once, never twice', async () => {
  const { store, clock, tick } = rig();
  await H.fire({ store, env: ON, now: clock }); // baseline
  tick();
  const card = await approvedQueenCard(store, clock);
  tick();
  const r = await H.fire({ store, env: ON, now: clock });
  const edges = r.queued.map((q) => q.edge).sort();
  assert.deepStrictEqual(edges, ['queen-to-bob', 'queen-to-bob', 'queen-to-gbp']);
  const reqs = await store.runRequests();
  const bob = reqs.filter((q) => q.agent === 'bloggy-bob');
  assert.strictEqual(bob.length, 2);
  assert.ok(bob.every((q) => q.chain === KQ.CHAIN && q.from_card === card.id && q.priority === 3));
  assert.match(bob.find((q) => /bell tower/i.test(q.ask)).ask, /keyword: nashville wedding venue · site: The Bell Tower · post type: blog post/);
  assert.match(bob[0].ask, /fired by the Producer/);
  const gbp = reqs.find((q) => q.agent === 'gbp');
  assert.strictEqual(gbp.chain, H.CHAIN_QUEEN_GBP);
  assert.match(gbp.ask, /keyword: corporate holiday party nashville · venue: Infinity Event Center/);
  assert.match(gbp.ask, /nothing posts until Approve/);
  // The "Send to Bloggy Bob" button shares the key: a topic already fired is not sent again.
  const again = await KQ.approveTopic({ card, n: 1, who: 'k@x', store, env: { AGENT_KEYWORD_QUEEN: 'on' } });
  assert.strictEqual(again.already, true);
  tick();
  const r2 = await H.fire({ store, env: ON, now: clock });
  assert.strictEqual(r2.queued.length, 0);
  assert.strictEqual((await store.runRequests()).length, 3);
});

test('the Producer hold still applies: nothing fired or marked while drafts wait; fires once they clear', async () => {
  const { store, clock, tick } = rig();
  await H.fire({ store, env: ON, now: clock });
  tick();
  await approvedQueenCard(store, clock);
  const hold = require('../lib/producer').holdAt(clock());
  const drafts = [];
  // #3924: action drafts; a report card (an 'seo' card with no payload) no longer counts toward the hold.
  for (let i = 0; i < hold; i++) drafts.push(await store.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'j', title: `d${i}`, body: 'b' }));
  tick();
  const held = await H.fire({ store, env: ON, now: clock });
  assert.ok(held.held && /drafts are waiting/.test(held.held));
  assert.strictEqual(held.queued.length, 0);
  assert.strictEqual((await store.runRequests()).length, 0);
  for (const d of drafts) d.status = 'rejected';
  tick();
  const later = await H.fire({ store, env: ON, now: clock });
  assert.strictEqual(later.queued.length, 3);
});

test('a new post going live fires Google Business beside Pinterest Paul, naming the Bob card', async () => {
  const { store, clock, tick } = rig();
  await H.fire({ store, env: ON, now: clock });
  tick();
  await store.chainRun({ chain: 'new-post-to-paul', key: 'k1', agent: 'pinterest-paul', fromCard: 7,
    ask: 'Pin this new post: https://www.infinityhospitality.net/blog/winter-weddings/\n\nQueued by the Box ...' });
  tick();
  const r = await H.fire({ store, env: ON, now: clock });
  assert.deepStrictEqual(r.queued.map((q) => q.edge), ['bob-to-gbp']);
  const gbp = (await store.runRequests()).find((q) => q.agent === 'gbp');
  assert.strictEqual(gbp.chain, H.CHAIN_POST_GBP);
  assert.strictEqual(gbp.from_card, 7);
  assert.match(gbp.ask, /https:\/\/www\.infinityhospitality\.net\/blog\/winter-weddings\//);
  assert.match(gbp.ask, /From Bloggy Bob card #7/);
  tick();
  assert.strictEqual((await H.fire({ store, env: ON, now: clock })).queued.length, 0);
});

test('a chain-made card records where it came from; the card shows Came from and Next', async () => {
  const { store, clock } = rig();
  const queen = await approvedQueenCard(store, clock);
  await store.chainRun({ chain: KQ.CHAIN, key: `card-${queen.id}:1`, agent: 'bloggy-bob', ask: 'a', fromCard: queen.id });
  let made = null;
  await takeAndRun({ store, env: {}, log: () => {}, runOne: async (slug) => {
    made = await store.insert({ agent: slug, agent_name: 'Bloggy Bob', job: 'blog', title: 'Winter weddings', body: 'b' });
    return { ok: true, cards: [made] };
  } });
  const card = await store.get(made.id);
  assert.deepStrictEqual(card.came_from, { chain: KQ.CHAIN, agent: 'keyword-queen', agent_name: 'Keyword Queen', card: queen.id });
  const ch = H.cardChain(card, { env: OFF, nameOf: (s) => ({ 'pinterest-paul': 'Pinterest Paul', gbp: 'Google Business' }[s] || s) });
  assert.strictEqual(ch.came_from.line, `Keyword Queen, card #${queen.id}`);
  assert.strictEqual(ch.next_line, 'Pinterest Paul, Google Business (off)');
  assert.strictEqual(H.cardChain(card, { env: ON, nameOf: (s) => s }).next_line, 'pinterest-paul, gbp');
  // A person's own request (no chain) records nothing.
  assert.strictEqual(H.originOf({ chain: null }, null), null);
  // A Paul card from a post written outside the Box names the post, not an agent.
  assert.strictEqual(H.cardChain({ agent: 'pinterest-paul', came_from: H.originOf({ chain: 'new-post-to-paul' }, null) }).came_from.line, 'a new post on our site');
});

test('the map carries every handoff the order names, in plain words', () => {
  const rows = H.rows({ env: OFF, nameOf: (s) => s });
  const pairs = rows.map((r) => `${r.from || r.from_name}>${r.to}`);
  for (const p of ['keyword-queen>bloggy-bob', 'keyword-queen>gbp', 'Search Console GAPS list>gbp', 'bloggy-bob>pinterest-paul', 'bloggy-bob>gbp']) assert.ok(pairs.includes(p), p);
  assert.strictEqual(rows.find((r) => r.id === 'queen-to-gbp').on, false);
  assert.strictEqual(H.rows({ env: ON, nameOf: (s) => s }).find((r) => r.id === 'queen-to-gbp').on, true);
  for (const r of rows) for (const f of [r.from_name, r.to_name, r.when, r.what]) assert.doesNotMatch(String(f), /#\d{3,4}\b|ORDER \d/);
});

test('the pages show it: the map table on /agents, the chain line on Review, both routes feed it', () => {
  const agents = fs.readFileSync(path.join(__dirname, '../public/agents.html'), 'utf8');
  assert.match(agents, /function handoffsHtml\(p\)/);
  assert.match(agents, /\$\{handoffsHtml\(p\)\}/);
  assert.match(agents, /How the team hands work to each other/);
  const review = fs.readFileSync(path.join(__dirname, '../public/review.html'), 'utf8');
  assert.match(review, /function chainHtml\(c\)/);
  assert.match(review, /Came from: /);
  assert.match(review, /\$\{chainHtml\(c\)\}/);
  assert.match(fs.readFileSync(path.join(__dirname, '../routes/agents.js'), 'utf8'), /handoffs: require\('\.\.\/lib\/handoff-map'\)\.rows/);
  assert.match(fs.readFileSync(path.join(__dirname, '../routes/review.js'), 'utf8'), /handoffMap\.cardChain\(o, \{ nameOf \}\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '../jobs/agent_handoff.js'), 'utf8'), /require\('\.\.\/lib\/handoff-map'\)\.fire\(/);
});
