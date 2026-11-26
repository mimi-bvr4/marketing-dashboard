'use strict';
// ORDER #3834 (follow-on to #3814, named in REPLY #3814): a card that answers a
// homework item (#3806) always reaches the Review tab as a card and marks that
// homework done, whatever agent made it. Before this, a report agent's
// scheduled run (no ask, not a Redo) folded its answer into the Monday digest
// (#3814), `written` never grew, and the homework stayed open forever.
// Unprompted report cards with no homework still fold exactly as #3814 built.
//
// No database (in-memory store), no model call (a fake that answers JSON), no network.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');

const AT = new Date('2026-11-23T14:00:00Z'); // 11.23.2026 08:00 CT, a Monday
const now = () => AT;
const BY = 'tester@example.org';

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3834-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'week.md'), '# Measured this week\n- 3 pages slower than last week.\n');
  return { IHG_TREE: root };
}

// max_cards 2 so a run can return the answer and a bare report side by side.
const def = (slug) => ({ ...loadAgent(slug), copy_prepass: false, seen_before: null, max_cards: 2,
  sources: [{ type: 'file', path: 'week.md', required: true, label: 'the week measured' }] });

function model(answer) {
  return { model: 'fake', lastStop: 'end_turn', async complete() { return JSON.stringify(answer); } };
}

async function run(t, slug, cards, { store, dryRun = false } = {}) {
  const res = await runAgent({ def: def(slug), store, llm: model({ cards }), env: tree(t), now, scheduled: true, dryRun,
    log: () => {}, fetchImpl: async () => { throw new Error('no network'); } });
  return res;
}

const REPORT = { title: 'Site speed this week: 3 pages slower', target: null,
  body: 'The venue pages on the fixture site loaded slower this week than last. The home page is unchanged.' };
const ANSWER = { title: 'Homework: the three slow pages, measured', target: null,
  body: 'The three slow pages are the barn page, the garden page and the gallery. Each loads over four seconds.' };

test('RED: a scheduled report run answering open homework saves one card and marks the homework done', async (t) => {
  const store = createMemoryStore({ lint, now });
  const hw = (await store.addHomework('site-health', { note: 'Which pages got slower this week?' }, BY)).homework;
  const res = await run(t, 'site-health', [{ ...ANSWER, homework: hw.id, homework_result: 'Three slow pages named' }], { store });
  assert.strictEqual(res.ok, true, JSON.stringify(res.error));
  assert.strictEqual(store.cards.filter((c) => c.agent === 'site-health').length, 1, 'the answer is a Review card');
  assert.strictEqual(res.cards.length, 1);
  assert.deepStrictEqual(res.folded, [], 'the answer is not folded');
  assert.strictEqual((await store.weekReports()).length, 0);
  const row = store.homeworkRows.find((r) => r.id === hw.id);
  assert.strictEqual(row.status, 'done', 'the homework is marked done');
  assert.strictEqual(row.result, 'Three slow pages named');
  assert.deepStrictEqual(row.cards, [res.cards[0].id], 'done with its card id');
  for (const k of ['homework', 'homework_result', 'answers_homework']) assert.ok(!(k in res.cards[0]), `the saved card carries no ${k}`);
});

test('the same report run with no homework still folds (#3814 unchanged)', async (t) => {
  const store = createMemoryStore({ lint, now });
  const res = await run(t, 'site-health', [REPORT], { store });
  assert.strictEqual(store.cards.length, 0);
  assert.strictEqual(res.folded.length, 1);
  assert.strictEqual((await store.weekReports()).length, 1);
});

test('answering #A while #B stays open marks only #A; a bare report card in the same run still folds', async (t) => {
  const store = createMemoryStore({ lint, now });
  const a = (await store.addHomework('scout', { note: 'Item A: what did the fixture competitor post?' }, BY)).homework;
  const b = (await store.addHomework('scout', { note: 'Item B: not answered this run' }, BY)).homework;
  const res = await run(t, 'scout', [{ ...ANSWER, title: 'Homework A answered', homework: a.id }, REPORT], { store });
  assert.strictEqual(res.ok, true, JSON.stringify(res.error));
  assert.strictEqual(res.cards.length, 1, 'only the answer is a card');
  assert.strictEqual(res.cards[0].title, 'Homework A answered');
  assert.strictEqual(res.folded.length, 1, 'the bare report folds');
  const rows = store.homeworkRows;
  assert.strictEqual(rows.find((r) => r.id === a.id).status, 'done');
  assert.deepStrictEqual(rows.find((r) => r.id === a.id).cards, [res.cards[0].id]);
  assert.strictEqual(rows.find((r) => r.id === b.id).status, 'open', '#B stays open');
});

test('a homework number the run was not handed does not stop the fold', async (t) => {
  const store = createMemoryStore({ lint, now });
  await store.addHomework('site-health', { note: 'An open item' }, BY);
  const res = await run(t, 'site-health', [{ ...REPORT, homework: 99 }], { store });
  assert.strictEqual(store.cards.length, 0, 'a made-up number is not an answer');
  assert.strictEqual(res.folded.length, 1);
  assert.strictEqual(store.homeworkRows[0].status, 'open');
});

test('a dry run writes nothing: no card, no folded entry, homework still open', async (t) => {
  const store = createMemoryStore({ lint, now });
  const hw = (await store.addHomework('site-health', { note: 'Which pages got slower?' }, BY)).homework;
  const res = await run(t, 'site-health', [{ ...ANSWER, homework: hw.id }], { store, dryRun: true });
  assert.strictEqual(res.cards.length, 1, 'the dry run reports it as a card');
  assert.deepStrictEqual(res.folded, []);
  assert.strictEqual(store.cards.length, 0);
  assert.strictEqual((await store.weekReports()).length, 0);
  assert.strictEqual(store.homeworkRows[0].status, 'open');
});
