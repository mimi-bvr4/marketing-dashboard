// ORDER #1724: the Email agent (#1716 part 2). Nurture drafts on request, every
// draft through the Copywriter's rules; the scorecard on the 3rd, read-only.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');

const { runAgent, loadAgent } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { internalCodes } = require('../lib/agent-sources');
const { lint } = require('../lib/ai-tells');
const { dueAgents } = require('../jobs/agent_run');
const { matchAgent } = require('../jobs/kh_route');

const ENV = { IHG_TREE: os.tmpdir() };
const card = (body) => JSON.stringify({ cards: [{ title: 'Wedding nurture 1 of 7, The Bridge Building: Your date at the river', target: 'The Bridge Building', body }] });

function fakeModel(answers) {
  const calls = [];
  return { calls, model: 'test', complete: async (a) => { calls.push(a); return answers[Math.min(calls.length - 1, answers.length - 1)]; } };
}

test('a draft with an internal code goes back once through the Copywriter check, and comes out clean', async () => {
  const store = createMemoryStore({ lint });
  const llm = fakeModel([card('Subject: Your date at TBB\n\nTour TBB this month.'), card('Subject: Your date at the river\n\nTour The Bridge Building this month.')]);
  const r = await runAgent({ slug: 'email', store, llm, ask: 'Wedding nurture email 1 for The Bridge Building', env: ENV, log: () => {} });
  assert.ok(r.ok, r.error);
  assert.strictEqual(llm.calls.length, 2);
  assert.match(llm.calls[1].user, /Rewrite this card to remove these copy check hits: internal code in public copy "TBB \(write "The Bridge Building"\)"/);
  assert.match(r.cards[0].body, /Tour The Bridge Building this month\./);
  assert.strictEqual(r.cards[0].checks.ai_tells_summary, 'AI-tells: clean');
  assert.match(llm.calls[0].system, /The Copywriter's rules apply to every draft/);
});

test('a code the rewrite did not remove is named on the card', async () => {
  const store = createMemoryStore({ lint });
  const llm = fakeModel([card('Tour SWF and TBB.')]);
  const r = await runAgent({ slug: 'email', store, llm, ask: 'Tour nurture email 2 for Saddle Woods Farm', env: ENV, log: () => {} });
  assert.strictEqual(llm.calls.length, 2);
  assert.match(r.cards[0].checks.ai_tells_summary, /internal codes left: SWF, TBB$/);
});

test('a drafting request never reads or reports the scorecard sources', async () => {
  const store = createMemoryStore({ lint });
  const llm = fakeModel([card('Tour The Bridge Building this month.')]);
  const r = await runAgent({ slug: 'email', store, llm, ask: 'Corporate nurture email 1', env: ENV, log: () => {} });
  assert.ok(r.ok, r.error);
  assert.ok(!r.unavailable.some((u) => /HubSpot|W1/.test(u.label)), JSON.stringify(r.unavailable));
  assert.doesNotMatch(llm.calls[0].user, /HubSpot marketing email analytics/);
});

// #1733: the read now exists and fails closed; a missing scope is still a "could not run" card.
test('the 3rd with HubSpot email statistics unreadable (scope missing): one card that says so, no model call, no number', async () => {
  const store = createMemoryStore({ lint });
  const llm = fakeModel(['{"cards":[{"title":"Email scorecard","body":"Opens 41%"}]}']);
  const fetchImpl = async () => ({ status: 200, json: async () => ({ ok: false, why: 'scope missing: scope-from-hubspot' }) });
  const r = await runAgent({ slug: 'email', store, llm, env: { ...ENV, MARKETING_FLEET_KEY: 'mkt_test', MARKETING_BASE_URL: 'https://example.test' },
    fetchImpl, log: () => {}, scheduled: true });
  assert.strictEqual(llm.calls.length, 0);
  assert.strictEqual(r.cards.length, 1);
  assert.match(r.cards[0].title, /could not run: a required source is missing/);
  assert.match(r.cards[0].body, /HubSpot marketing email analytics \(last month\): scope missing: scope-from-hubspot/);
  assert.doesNotMatch(r.cards[0].body, /\d+%/);
});

test('only the Email agent opts into the code check; the Copywriter measures the same codes', () => {
  assert.strictEqual(loadAgent('email').copy_check, true);
  for (const s of ['bloggy-bob', 'pinterest-paul', 'convention-connector', 'copywriter']) assert.ok(!loadAgent(s).copy_check, s);
  assert.deepStrictEqual(internalCodes('Visit TBB.\nOr ECD.').map((h) => [h.phrase, h.line]),
    [['TBB (write "The Bridge Building")', 1], ['ECD (write "The Estate at Cherokee Dock")', 2]]);
});

test('schedule: the scorecard runs on the 3rd only', () => {
  assert.ok(dueAgents('2026-11-03').includes('email'));
  assert.ok(!dueAgents('2026-10-13').includes('email'));
  assert.ok(!dueAgents('2026-10-12').includes('email'));
});

test("Katherine's Drive orders reach the Email agent, and the Copywriter keeps its own", () => {
  assert.deepStrictEqual(matchAgent('Draft the wedding nurture series for Saddle Woods Farm'), ['email']);
  assert.deepStrictEqual(matchAgent('Email scorecard for September'), ['email']);
  assert.deepStrictEqual(matchAgent('Copy check on the holiday party email'), ['copywriter']);
});
