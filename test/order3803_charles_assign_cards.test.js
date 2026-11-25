'use strict';
// ORDER #3803 (Mimi 11.24.2026): "Convention Charles: Monday list for this week
// didn't show anything." Cause (REPLY_2026-11-25_3803_L1): the Producer calendar
// runs Charles on Tuesday, not Monday, and the 3 cards the Tuesday 11.24 run made
// were archived from Drafts by a person the same day. Fix here: the list is
// posted as ACTION cards, one per prospect, "Assign to Mary: <convention>,
// <dates>", each with its own draft email; the 4-year table stays as reference;
// the stale "Mondays" labels now say Tuesday. #3344 / #3552 HubSpot rules untouched.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../lib/agent-runner');
const P = require('../lib/producer');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const GOOD = '### Who\nExample DMC, runs offsite receptions. Contact: https://example.org/contact\n\n'
  + '### Why it fits\nExample Association annual meeting, 03.10.2027 to 03.12.2027, Music City Center. https://example.org/2027\n\n'
  + '### What Mary does\nAssign this lead to a salesperson on the Sales Hand-off desk.\n\nDraft email: Subject: Your reception in March. Hello from Nashville.';

test('agent.json asks for prospect cards, has room for them, and says Tuesday like the Producer', () => {
  const a = R.loadAgent('convention-connector');
  assert.strictEqual(a.prospect_cards, true);
  assert.ok(a.max_cards >= 8 && a.max_cards <= 10, 'table card(s) plus up to 6 prospects, inside the 1 to 10 limit');
  assert.strictEqual(a.cadence, 'Tuesdays 06:00 CT');
  assert.ok(P.calendar().find((e) => e.agent === 'convention-connector').days.includes('tue'));
  assert.ok(!a.character.does.some((d) => /Every Monday/.test(d)), 'no stale Monday label on the team page');
  assert.match(a.skill, /Assign to Mary: <convention>, <dates>/);
  assert.doesNotMatch(a.skill, /\*\*"Draft emails, <MM\.DD\.YYYY>"\*\*/, 'no separate Draft emails card');
  // #3344 / #3552 rules unchanged: still a sales agent with the same seen key.
  assert.strictEqual(a.sales_fields, true);
  assert.deepStrictEqual(a.seen_before, { key: ['company', 'event'], source: ['event_dates'] });
});

test('prospectGaps: title shape and three headings; the reference table cards are exempt', () => {
  assert.deepStrictEqual(R.prospectGaps({ title: 'Assign to Mary: Example Association annual meeting, 03.10.2027 to 03.12.2027', body: GOOD }), []);
  assert.deepStrictEqual(R.prospectGaps({ title: 'Conventions coming to Nashville, 11.24.2026', body: 'table' }), []);
  assert.deepStrictEqual(R.prospectGaps({ title: 'Conventions coming to Nashville, later years, 11.24.2026', body: 'table' }), []);
  assert.deepStrictEqual(R.prospectGaps({ title: 'Draft emails, 11.24.2026', body: GOOD }), ['the title "Assign to Mary: <convention>, <dates>"']);
  assert.deepStrictEqual(R.prospectGaps({ title: 'Assign to Mary: Example meeting, 03.10.2027', body: '### Who\nx' }), ['Why it fits', 'What Mary does']);
  assert.deepStrictEqual(R.prospectGaps({ title: 'Assign to Mary: Example meeting, spring', body: GOOD }), ['the title "Assign to Mary: <convention>, <dates>"']);
});

test('a Charles run sends the prospect contract and marks a malformed prospect card; table and good cards are clean', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3803-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\nExample Association meets at Music City Center 03.10.2027.\n');
  const def = { ...R.loadAgent('convention-connector'), copy_prepass: false, sources: [{ type: 'file', path: 'notes.md', required: true, label: 'the notes' }] };
  const calls = [];
  const llm = { model: 'fake', lastStop: 'end_turn', complete: async (x) => { calls.push(x); return JSON.stringify({ cards: [
    { title: 'Conventions coming to Nashville, 11.24.2026', target: 'sales', body: '| Event | Dates | Link |\n|---|---|---|\n| Example Association annual meeting | 03.10.2027 to 03.12.2027 | https://example.org/2027 |' },
    { title: 'Assign to Mary: Example Association annual meeting, 03.10.2027 to 03.12.2027', target: 'sales', body: GOOD,
      seen: { company: 'Example DMC', event: 'Example Association annual meeting', event_dates: '03.10.2027 to 03.12.2027' } },
    { title: 'Assign to Mary: Other Expo, 04.01.2027', target: 'sales', body: '### Who\nOther Expo office, https://example.com/contact',
      seen: { company: 'Other Expo office', event: 'Other Expo', event_dates: '04.01.2027' } },
  ] }); } };
  const store = createMemoryStore({ lint });
  const r = await R.runAgent({ def, store, llm, env: { IHG_TREE: root }, log: () => {}, fetchImpl: async () => { throw new Error('no network'); } });
  assert.ok(r.ok, r.error);
  assert.match(calls[0].system, /PROSPECT CARDS\. The convention list is posted as actions/);
  assert.match(calls[0].user, /Write at most 8 card\(s\)\./);
  const byTitle = (re) => r.cards.find((c) => re.test(c.title));
  assert.doesNotMatch(byTitle(/^Conventions coming/).body, /Missing from this card/);
  assert.doesNotMatch(byTitle(/Example Association/).body, /Missing from this card/);
  assert.match(byTitle(/Other Expo/).body, /Missing from this card \(code check\):\*\* Why it fits, What Mary does\./);
});

test('other agents do not get the prospect contract', () => {
  for (const s of ['planner-scout', 'gala-scout', 'pr-patty', 'gbp']) assert.ok(!R.loadAgent(s).prospect_cards, s);
});
