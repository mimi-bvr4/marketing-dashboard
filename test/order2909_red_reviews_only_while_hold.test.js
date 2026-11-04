'use strict';
// ORDER #2909: while the Producer's 15-waiting hold is on, Google Business
// still runs but drafts only its RED review replies. Its profile post idea and
// its replies to kind reviews wait with the other held work. Hold off: as before.
//
// RED is the agent's own rule (agents/gbp/SKILL.md line 12): "3 stars or below,
// or any review that mentions pricing, staff or a problem ... Mark the card
// title "RED"". The code keeps a card by that title mark, never by star count.
//
// Acceptance (the order's own lines):
//   - KNOWN-BAD, 16 waiting drafts: one RED review and one kind review give one
//     RED reply card, no reply to the kind review, and no post idea;
//   - with the hold off, the same input gives today's output.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = require('../lib/producer');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');

const PULSE = `# Venue review pulse, October
- The Bell Tower, WeddingWire, Sam, 2 stars: "The pricing changed after we booked and nobody called us back."
- Cannery Hall, Google, Ana, 5 stars: "The rooftop at sunset was perfect for our photos."
`;

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt2909-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pulse.md'), PULSE);
  return { IHG_TREE: root };
}

// What Google Business writes for that pulse today: two replies and one post idea.
const RED = { title: 'RED Reply draft: The Bell Tower, Sam, WeddingWire', target: 'WeddingWire',
  body: 'Review: "The pricing changed after we booked."\n\nReply: Sam, thank you for telling us. Please write to sales@infinityhospitality.net so we can talk it through. The Bell Tower team' };
const KIND = { title: 'Reply draft: Cannery Hall, Ana, Google', target: 'Google',
  body: 'Review: "The rooftop at sunset was perfect."\n\nReply: Ana, thank you. We loved seeing your sunset photos on the rooftop. The Cannery Hall team' };
const POST = { title: 'Profile post idea: Cannery Hall', target: 'Google Business Profile',
  body: 'Fall weekends on the rooftop at Cannery Hall. Ask us about a tour. Photo: the rooftop at dusk.' };

function model() {
  const calls = [];
  return { model: 'fake', calls, async complete(req) { calls.push(req); return JSON.stringify({ cards: [RED, KIND, POST] }); } };
}

const gbpDef = () => ({ ...loadAgent('gbp'), copy_prepass: false,
  sources: [{ type: 'file', path: 'pulse.md', required: true, label: 'the newest review pulse' }] });

// The day's runOne, as jobs/agent_run.js builds it: Google Business runs for
// real (fake model, no network); the other due agents write nothing.
function dayRunner({ store, llm, env, calls }) {
  return async (...args) => {
    calls.push(args);
    const [slug, opts = {}] = args;
    if (slug !== 'gbp') return { ok: true, cards: [], unavailable: [] };
    const split = opts.only ? P.holdSplit(slug, opts.only) : null;
    return runAgent({ def: gbpDef(), store, llm, env, scheduled: true, fetchImpl: async () => { throw new Error('no network'); },
      ...(split ? { split } : {}) });
  };
}

async function waitingDrafts(store, n) {
  for (let i = 0; i < n; i++) await store.insert({ agent: 'seo', agent_name: 'SEO', job: 'x', title: `waiting ${i}`, body: 'x' });
}

test('the RED rule is the agent\'s own title mark, quoted from its SKILL', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'agents', 'gbp', 'SKILL.md'), 'utf8').split('\n');
  assert.match(skill[11], /3 stars or below, or any review that mentions pricing, staff or a problem/);
  assert.match(skill[11], /Mark the card title "RED"/);
  assert.strictEqual(P.isRedCard(RED), true);
  assert.strictEqual(P.isRedCard(KIND), false);
  assert.strictEqual(P.isRedCard(POST), false);
  // A word that only contains the letters is not the mark.
  assert.strictEqual(P.isRedCard({ title: 'Reply draft: Redwood Room, Jo, Google' }), false);
  assert.strictEqual(P.isRedCard({ title: 'Reply draft: Infinity, starred 1, Google' }), false, 'never from the star count');
});

test('decide: with 16 waiting, Google Business runs for RED replies only and says what it held', () => {
  const d = P.decide({ agent: 'gbp', waiting: 16, used: 40, maxCards: 4 });
  assert.strictEqual(d.run, true);
  assert.strictEqual(d.only, 'red');
  assert.match(d.why, /held: post ideas, 16 waiting/);
  // PR Patty is unchanged: never held, no split.
  assert.deepStrictEqual(P.decide({ agent: 'pr-patty', waiting: 16, used: 0, maxCards: 2 }), { run: true, why: 'never held: press deadlines are never held' });
});

test('decide: with the hold off, Google Business is exactly as before (no split, never held)', () => {
  for (const waiting of [0, 14]) {
    assert.deepStrictEqual(P.decide({ agent: 'gbp', waiting, used: 40, maxCards: 4 }),
      { run: true, why: 'never held: it carries the RED review replies, which are never held' });
  }
});

test('KNOWN-BAD: 16 waiting, one RED and one kind review give one RED reply card, no kind reply, no post idea', async (t) => {
  const store = createMemoryStore({ lint });
  await waitingDrafts(store, 16);
  const llm = model();
  const calls = [];
  const rows = await P.runDay({ ymd: '2026-11-03', store, maxCardsOf: () => 4, runOne: dayRunner({ store, llm, env: tree(t), calls }) });

  const gbpCards = store.cards.filter((c) => c.agent === 'gbp');
  assert.deepStrictEqual(gbpCards.map((c) => c.title), [RED.title], 'only the RED reply is saved');
  assert.ok(!gbpCards.some((c) => /Cannery Hall, Ana/.test(c.title)), 'no reply to the kind review');
  assert.ok(!gbpCards.some((c) => /post idea/i.test(c.title)), 'no post idea');

  // The decision is in producer_log.
  const row = rows.find((r) => r.agent === 'gbp');
  assert.strictEqual(row.decision, 'ran');
  assert.strictEqual(row.cards, 1);
  assert.match(row.why, /held: post ideas, 16 waiting/);
  assert.ok(store.producerRows.some((r) => r.agent === 'gbp' && /held: post ideas, 16 waiting/.test(r.why)));

  // The agent was told, and the run row says how many waited.
  assert.match(llm.calls[0].user, /THE PRODUCER'S HOLD IS ON/);
  const run = store.runList.find((r) => r.agent === 'gbp');
  assert.match(run.note, /2 held by the Producer's hold \(post ideas; RED review replies only\)/);
  // The skill itself was not changed.
  assert.strictEqual(llm.calls[0].system.startsWith(loadAgent('gbp').skill), true);
  // Every saved card is still a draft for Katherine.
  for (const c of gbpCards) assert.strictEqual(c.status, 'draft');
  // The other non-exempt agent due that Tuesday is held as before.
  assert.strictEqual(rows.find((r) => r.agent === 'convention-connector').decision, 'held');
});

test('a held kind-review reply is not marked seen, so it is drafted once the hold lifts', async (t) => {
  const store = createMemoryStore({ lint });
  await waitingDrafts(store, 16);
  const env = tree(t);
  const llm = model();
  await P.runDay({ ymd: '2026-11-03', store, maxCardsOf: () => 4, runOne: dayRunner({ store, llm, env, calls: [] }) });
  // Katherine clears the queue below 15; the next day runs in full.
  for (const c of store.cards.filter((x) => x.agent === 'seo')) c.status = 'rejected';
  await P.runDay({ ymd: '2026-11-04', store, maxCardsOf: () => 4, runOne: dayRunner({ store, llm, env, calls: [] }) });
  const titles = store.cards.filter((c) => c.agent === 'gbp').map((c) => c.title);
  assert.ok(titles.includes(KIND.title), 'the kind reply is drafted after the hold');
  assert.ok(titles.includes(POST.title), 'the post idea is drafted after the hold');
});

test('PINNED: with the hold off, the same input gives today\'s output', async (t) => {
  const env = tree(t);
  // Today: runAgent with no split at all.
  const before = createMemoryStore({ lint });
  const llmBefore = model();
  const r0 = await runAgent({ def: gbpDef(), store: before, llm: llmBefore, env, scheduled: true });
  assert.ok(r0.ok, r0.error);

  // Under the Producer with 3 waiting (hold off).
  const after = createMemoryStore({ lint });
  await waitingDrafts(after, 3);
  const llm = model();
  const calls = [];
  const rows = await P.runDay({ ymd: '2026-11-03', store: after, maxCardsOf: () => 4, runOne: dayRunner({ store: after, llm, env, calls }) });

  const gbpCall = calls.find((a) => a[0] === 'gbp');
  assert.deepStrictEqual(gbpCall, ['gbp'], 'runOne is called exactly as before, with no option');
  const strip = (cs) => cs.filter((c) => c.agent === 'gbp').map((c) => ({ title: c.title, target: c.target, status: c.status }));
  assert.deepStrictEqual(strip(after.cards), strip(before.cards));
  assert.deepStrictEqual(strip(after.cards).map((c) => c.title), [RED.title, KIND.title, POST.title]);
  assert.strictEqual(llm.calls[0].user, llmBefore.calls[0].user.replace(/^TODAY: .*$/m, llm.calls[0].user.match(/^TODAY: .*$/m)[0]),
    'the agent reads the same prompt (no hold line)');
  assert.doesNotMatch(llm.calls[0].user, /HOLD IS ON/);
  const row = rows.find((r) => r.agent === 'gbp');
  assert.strictEqual(row.why, 'never held: it carries the RED review replies, which are never held');
  assert.strictEqual(after.runList.find((r) => r.agent === 'gbp').note, before.runList.find((r) => r.agent === 'gbp').note);
  // And the return value carries no new field.
  assert.ok(!('held_by_split' in r0));
});
