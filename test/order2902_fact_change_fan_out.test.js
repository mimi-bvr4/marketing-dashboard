'use strict';
// ORDER #2902: the fact-change fan-out through the Producer (memo 6C).
//
// The acceptance replay: Katherine searches "sparkling white wine", the Cadet
// finds it, she marks the answer changed to "Prosecco", and the Producer queues
// one re-check each by Email, Listings + Citations and Google Business, and
// fills the Change Log entry with old -> new. The queued runs are then taken by
// the real request runner and the real agent runner, with a fake model and a
// web that refuses every call: drafts only, nothing published, posted or sent,
// and no existing card is touched.
//
// Known-bad first: with PRODUCER_FACT_CHANGE off (it ships OFF) the mark is
// refused and nothing queues.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const cadetStore = require('../lib/cadet-store');
const { lint } = require('../lib/ai-tells');
const P = require('../lib/producer');
const { changeLogDraft } = require('../lib/cadet-search');
const { takeAndRun } = require('../jobs/agent_requests');
const { runAgent } = require('../lib/agent-runner');

const ON = { PRODUCER_FACT_CHANGE: '1' };
const KH = 'Katherine Hall';

// What the Cadet answered for "sparkling white wine" (the shape search() returns).
const RESULT = {
  phrase: 'sparkling white wine',
  searched_at: '2026-11-03T22:00:00.000Z',
  materials: [
    { company: 'TBB', title: 'TBB Bar Packages 2026', status: 'FOUND', lines: ['Champagne toast with sparkling white wine'], count: 1 },
    { company: 'SWF', title: 'SWF Wedding Guide', status: 'NOT FOUND' },
    { company: 'NEB', title: 'NEB Menu (image)', status: 'NOT CHECKED', why: 'an image-only file' },
  ],
  sites: [
    { site: 'thebridgebuilding.com', platform: 'WordPress', status: 'FOUND', pages: [{ page: '/bar-packages/', url: 'https://thebridgebuilding.com/bar-packages/', lines: ['a sparkling white wine toast'], count: 1 }] },
    { site: 'saddlewoodsfarm.com', platform: 'WordPress', status: 'NOT FOUND' },
  ],
  tally: { materials: { found: 1, not_found: 1, not_checked: 1 }, sites: { found: 1, not_found: 1, not_checked: 0 } },
};

async function finishedSearch() {
  const cs = cadetStore.createMemoryStore();
  const { ask } = await cs.queueAsk('sparkling white wine', KH);
  await cs.takeAsks(1);
  await cs.finishAsk(ask.id, { result: RESULT });
  return { cs, id: ask.id };
}

// Cards already on the Review tab. They must come out of the replay unchanged.
async function seeded() {
  const s = createMemoryStore({ lint });
  const approved = await s.insert({ agent: 'email', agent_name: 'Email', job: 'nurture', title: 'Wedding nurture 3: the toast',
    body: 'Subject: Raise a glass\nEvery package starts with a sparkling white wine toast.\nSee you soon.' });
  approved.status = 'ready';
  const waiting = await s.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'post idea', title: 'Friday post: bar packages',
    body: 'Our bar packages now include a sparkling white wine toast.' });
  const unrelated = await s.insert({ agent: 'email', agent_name: 'Email', job: 'nurture', title: 'Tour follow-up', body: 'Thanks for touring.' });
  const kh = await s.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'post', title: "Katherine's draft", body: 'sparkling white wine is our favorite.' });
  return { s, before: JSON.stringify([approved, waiting, unrelated, kh]) };
}

test('KNOWN-BAD: with PRODUCER_FACT_CHANGE off, the mark is refused and nothing queues', async () => {
  const { cs, id } = await finishedSearch();
  const { s } = await seeded();
  const r = await P.cadetChanged({ id, to: 'Prosecco', who: KH, cadetStore: cs, agentStore: s, env: {} });
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await s.runRequests()).length, 0);
  assert.strictEqual((await cs.ask(id)).changed_to, undefined, 'the answer is not marked');
  assert.strictEqual(P.factChangeOn({}), false, 'the switch ships OFF');
});

test('KNOWN-BAD: a search that has not finished, an empty wording, or the same wording is refused', async () => {
  const cs = cadetStore.createMemoryStore();
  const { s } = await seeded();
  const { ask } = await cs.queueAsk('sparkling white wine', KH);
  assert.strictEqual((await P.cadetChanged({ id: ask.id, to: 'Prosecco', who: KH, cadetStore: cs, agentStore: s, env: ON })).status, 409);
  await cs.takeAsks(1); await cs.finishAsk(ask.id, { result: RESULT });
  assert.strictEqual((await P.cadetChanged({ id: ask.id, to: '  ', who: KH, cadetStore: cs, agentStore: s, env: ON })).status, 400);
  assert.strictEqual((await P.cadetChanged({ id: ask.id, to: 'Sparkling White Wine', who: KH, cadetStore: cs, agentStore: s, env: ON })).status, 400);
  assert.strictEqual((await P.cadetChanged({ id: ask.id, to: 'Prosecco', who: null, cadetStore: cs, agentStore: s, env: ON })).status, 403);
  assert.strictEqual((await P.cadetChanged({ id: 99, to: 'Prosecco', who: KH, cadetStore: cs, agentStore: s, env: ON })).status, 404);
  assert.strictEqual((await s.runRequests()).length, 0);
});

test('REPLAY: "sparkling white wine" to "Prosecco", end to end, drafts only', async (t) => {
  const { cs, id } = await finishedSearch();
  const { s, before } = await seeded();

  // 1. Katherine marks the answer changed.
  const r = await P.cadetChanged({ id, to: 'Prosecco', who: KH, cadetStore: cs, agentStore: s, env: ON });
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.lines.map((l) => [l.agent, l.queued]), [['email', true], ['citations', true], ['gbp', true]]);
  assert.strictEqual(r.first, true);
  const mark = await cs.ask(id);
  assert.strictEqual(mark.changed_to, 'Prosecco');
  assert.strictEqual(mark.changed_by, KH);

  // 2. Three re-checks wait in the one queue, at Katherine's priority, under her name.
  const reqs = (await s.runRequests()).slice().reverse();
  assert.deepStrictEqual(reqs.map((q) => q.agent), ['email', 'citations', 'gbp']);
  for (const q of reqs) {
    assert.strictEqual(q.priority, P.PRIORITY.person);
    assert.strictEqual(q.requested_by, KH);
    assert.strictEqual(q.chain, P.CHAIN_FACT);
    assert.match(q.ask, /"sparkling white wine" is now "Prosecco"/);
    assert.match(q.ask, /TBB Bar Packages 2026 \(TBB\)/);
    assert.match(q.ask, /thebridgebuilding\.com\/bar-packages\//);
    assert.match(q.ask, /Draft only: nothing is published, posted or sent/);
    assert.doesNotMatch(q.ask, /ORDER|#\d/, 'no order numbers in anything Katherine sees');
    assert.doesNotMatch(q.ask, /SWF Wedding Guide|NEB Menu/, 'only places that hold the old wording are named');
  }
  assert.match(reqs[0].ask, /"Wedding nurture 3: the toast" \(approved\): Every package starts with a sparkling white wine toast\./, 'Email is shown its own approved card that still says it');
  assert.doesNotMatch(reqs[0].ask, /Tour follow-up/);
  assert.match(reqs[2].ask, /"Friday post: bar packages" \(waiting for review\)/, 'Google Business is shown its waiting card');
  assert.doesNotMatch(reqs[1].ask, /Your own cards/, 'Citations has no card that says it');
  assert.doesNotMatch(reqs.map((q) => q.ask).join('\n'), /Katherine's draft/, "another agent's card is not handed out");

  // 3. Marking it again queues nothing new and keeps the first wording.
  const again = await P.cadetChanged({ id, to: 'Cava', who: 'Someone Else', cadetStore: cs, agentStore: s, env: ON });
  assert.strictEqual(again.first, false);
  assert.strictEqual(again.after, 'Prosecco');
  assert.ok(again.lines.every((l) => !l.queued && /already queued/.test(l.why)));
  assert.strictEqual((await s.runRequests()).length, 3);

  // 4. The Change Log entry is pre-filled with old -> new (an area owner still approves it in Dispatch).
  const d = changeLogDraft((await cs.ask(id)).result, { bucket: 'menus', after: mark.changed_to });
  assert.strictEqual(d.title, 'Change "sparkling white wine" to "Prosecco"');
  assert.strictEqual(d.before, 'sparkling white wine');
  assert.strictEqual(d.after, 'Prosecco');
  assert.deepStrictEqual(d.collateral, [{ company: 'TBB', title: 'TBB Bar Packages 2026' }]);
  assert.deepStrictEqual(d.places, ['thebridgebuilding.com/bar-packages/']);
  assert.strictEqual(changeLogDraft(RESULT).title, 'Change "sparkling white wine"', 'without a mark the entry is as before');

  // 5. The Box takes the queue with the real runners: a fake model, a web that refuses everything.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt2902-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const web = []; const fetchImpl = async (u) => { web.push(String(u)); throw new Error('no network in this test'); };
  const asked = [];
  const llm = { model: 'fake', async complete(req) {
    const text = JSON.stringify(req);
    if (/Prosecco/.test(text)) asked.push(text);
    return JSON.stringify({ cards: [{ title: 'Fix: Prosecco toast', target: 'The Bridge Building', body: 'Every package starts with a Prosecco toast.' }] });
  } };
  const env = { IHG_TREE: root };
  const results = [];
  await takeAndRun({ store: s, env, log: () => {}, runOne: async (slug, ask) => {
    const out = await runAgent({ slug, store: s, llm, ask, env, fetchImpl });
    results.push({ slug, ok: out.ok, blocked: out.blocked, error: out.error, cards: (out.cards || []).length });
    return out;
  } });
  assert.deepStrictEqual(results.map((x) => x.slug), ['email', 'citations', 'gbp']);
  const after = (await s.runRequests()).filter((q) => q.chain === P.CHAIN_FACT);
  assert.ok(after.every((q) => q.status === 'done' || q.status === 'failed'), 'every re-check was taken');
  assert.ok(results.every((x) => x.ok && x.cards === 1), `each re-check ran and drafted one fix (${JSON.stringify(results)})`);
  const made = s.cards.slice(4);
  assert.deepStrictEqual(made.map((c) => c.agent).sort(), ['citations', 'email', 'gbp']);
  assert.ok(made.every((c) => c.status === 'draft'), 'every fix is a draft waiting for review');
  assert.ok(asked.length >= 1, 'the model was given the new wording');
  assert.strictEqual(JSON.stringify(s.cards.slice(0, 4)), before, 'no existing card was edited, approved or rejected');
  assert.ok(s.cards.every((c) => !c.handoff), 'nothing was handed off to WordPress, Pinterest or anywhere else');
  assert.ok(!web.some((u) => /hubapi|mybusiness|wp-json\/wp\/v2\/(posts|pages)|pinterest/i.test(u)), `nothing was asked of a publishing API (${web.join(', ')})`);
});

test('the fan-out names at most 12 places and 5 own cards, and says when the Cadet found nothing', () => {
  const many = Array.from({ length: 15 }, (_, i) => `place ${i + 1}`);
  const cards = Array.from({ length: 7 }, (_, i) => ({ title: `card ${i + 1}`, state: 'approved', line: 'x' }));
  const a = P.factAsk({ before: 'a', after: 'b', job: 'Re-check', places: many, cards });
  assert.match(a, /- place 12\n- and 3 more/);
  assert.doesNotMatch(a, /place 13/);
  assert.match(a, /- "card 5" \(approved\): x\n- and 2 more/);
  assert.match(P.factAsk({ before: 'a', after: 'b', job: 'Re-check', places: [] }), /did not find the old wording/);
});
