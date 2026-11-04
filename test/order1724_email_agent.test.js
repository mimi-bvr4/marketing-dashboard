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
  // #1748: the third call is the Copywriter pre-pass on the finished draft.
  assert.strictEqual(llm.calls.length, 3);
  assert.match(llm.calls[2].system, /^---\nname: copywriter/);
  assert.match(llm.calls[1].user, /Rewrite this card to remove these copy check hits: internal code in public copy "TBB \(write "The Bridge Building"\)"/);
  assert.match(r.cards[0].body, /Tour The Bridge Building this month\./);
  assert.strictEqual(r.cards[0].checks.ai_tells_summary, 'AI-tells: clean');
  assert.match(llm.calls[0].system, /The Copywriter's rules apply to every draft/);
});

test('a code the rewrite did not remove is named on the card', async () => {
  const store = createMemoryStore({ lint });
  const llm = fakeModel([card('Tour SWF and TBB.')]);
  const r = await runAgent({ slug: 'email', store, llm, ask: 'Tour nurture email 2 for Saddle Woods Farm', env: ENV, log: () => {} });
  assert.strictEqual(llm.calls.length, 3); // draft, one rewrite, the #1748 Copywriter pre-pass
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

// #2903: the scorecard moved into the Monthly Report; the Email agent no longer reads HubSpot statistics.
test('#2903: the Email agent carries no scorecard source; the Monthly Report carries it', () => {
  assert.ok(!loadAgent('email').sources.some((s) => s.type === 'hubspot_email_stats'));
  assert.ok(loadAgent('monthly-report').sources.some((s) => s.type === 'hubspot_email_stats'));
});

test('only the Email agent opts into the code check; the Copywriter measures the same codes', () => {
  assert.strictEqual(loadAgent('email').copy_check, true);
  for (const s of ['bloggy-bob', 'pinterest-paul', 'convention-connector', 'copywriter']) assert.ok(!loadAgent(s).copy_check, s);
  assert.deepStrictEqual(internalCodes('Visit TBB.\nOr ECD.').map((h) => [h.phrase, h.line]),
    [['TBB (write "The Bridge Building")', 1], ['ECD (write "The Estate at Cherokee Dock")', 2]]);
});

test('schedule: #2903 the Email agent has no scheduled run; the Monthly Report on the 3rd carries the scorecard', () => {
  for (const d of ['2026-11-03', '2026-10-13', '2026-10-12']) assert.ok(!dueAgents(d).includes('email'), d);
  assert.ok(dueAgents('2026-12-03').includes('monthly-report'));
});

test("Katherine's Drive orders reach the Email agent, and the Copywriter keeps its own", () => {
  assert.deepStrictEqual(matchAgent('Draft the wedding nurture series for Saddle Woods Farm'), ['email']);
  assert.deepStrictEqual(matchAgent('Email scorecard for September'), ['monthly-report']); // #2903
  assert.deepStrictEqual(matchAgent('Copy check on the holiday party email'), ['copywriter']);
});
