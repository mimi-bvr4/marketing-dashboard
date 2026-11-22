'use strict';
// ORDER #3755: a marketing agent run that finishes `done` counted its notice
// cards as drafts. #3753 took the failure notice out of a FAILED run's count;
// four other notices still went through put() into `written`:
//   "<name> could not run: ..."                      (lib/agent-runner.js:406)
//   "<name>: measured, not written up (no model key ...)" (:410)
//   "<name> run produced an empty card"              (:521)
//   "<name>: already drafted, nothing new"           (:558)
// so the run row's `cards`, the jobs/agent_run.js:127 log line and the
// Producer's day row and weekly `used` (lib/producer.js:249) counted a notice
// as a draft.
//
// The fix: each notice is saved outside `written` and returned on its own as
// `notices`. Titles and bodies are unchanged and each still reaches Review.
//
// No database (in-memory store), no model call (a fake that answers JSON).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');

const AT = new Date('2026-11-22T12:00:00Z'); // 06:00 CT
const now = () => AT;

function tree(t, { pulse = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3755-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (pulse) fs.writeFileSync(path.join(root, 'pulse.md'), '# Venue review pulse\n- Cannery Hall, Google, Ana, 5 stars: "The rooftop was perfect."\n- Cannery Hall, Google, Ben, 5 stars: "Great staff."\n');
  return { IHG_TREE: root };
}

const gbpDef = () => ({ ...loadAgent('gbp'), copy_prepass: false,
  sources: [{ type: 'file', path: 'pulse.md', required: true, label: 'the newest review pulse' }] });

function model(answer) {
  return { model: 'fake', lastStop: 'end_turn', async complete() { return JSON.stringify(answer); } };
}

// The jobs/agent_run.js:127 line, same template, for the before/after quote.
const runLine = (slug, r) => `${slug}: ${r.ok ? 'done' : 'FAILED ' + r.error}, ${r.cards.length} card(s)${r.seen_skipped ? `, ${r.seen_skipped} skipped as already seen` : ''}${r.unavailable.length ? `, ${r.unavailable.length} source(s) unavailable` : ''}`;

const card = (who, id, text) => ({ title: `Reply draft: Cannery Hall, ${who}, Google`,
  body: `Review date: 11.21.2026 | Stars: 5 | Google review id: ${id}\n\nThank you, ${who}. We are glad you enjoyed your day at Cannery Hall.`,
  seen: { venue: 'Cannery Hall', reviewer: who, platform: 'Google', review_id: id, review_text: text } });

async function run(t, { llm, ask = null, store = createMemoryStore({ lint, now }), env = tree(t) } = {}) {
  const lines = [];
  const res = await runAgent({ def: gbpDef(), store, llm, ask, env, now, scheduled: true,
    log: (l) => lines.push(l), fetchImpl: async () => { throw new Error('no network'); } });
  return { store, lines, res };
}

// Every notice case asserts the same five things.
function assertNotice(store, res, { title, body, drafts = 0 }) {
  assert.strictEqual(res.ok, true);
  const rows = store.runList.filter((x) => x.agent === 'gbp');
  const row = rows[rows.length - 1];
  assert.strictEqual(row.status, 'done');
  assert.strictEqual(row.cards, drafts, 'the run row counts drafted cards only');
  assert.strictEqual(res.cards.length, drafts, 'the returned cards are drafts only');
  assert.ok(res.cards.every((c) => c.title !== title), 'no notice inside the returned cards');
  const onReview = store.cards.filter((c) => c.agent === 'gbp' && c.title === title);
  assert.strictEqual(onReview.length, 1, 'the notice still reaches the Review tab');
  assert.match(onReview[0].body, body);
  assert.ok(Array.isArray(res.notices), 'the notices are returned on their own');
  assert.strictEqual(res.notices.length, 1);
  assert.strictEqual(res.notices[0].id, onReview[0].id);
}

test('"could not run": a missing required source is done with 0 cards and one notice', async (t) => {
  const { store, res } = await run(t, { llm: model({ cards: [] }), env: tree(t, { pulse: false }) });
  assertNotice(store, res, { title: 'Google Business could not run: a required source is missing',
    body: /^Google Business did not draft anything this run, because a source it needs is not available\. Connecting it is the next step; nothing else is wrong\./ });
});

test('"no model key": measured, not written up, is done with 0 cards and one notice', async (t) => {
  const { store, res } = await run(t, { llm: null });
  assertNotice(store, res, { title: 'Google Business: measured, not written up (no model key on this machine)',
    body: /^The sources were read, but there is no Anthropic API key here, so no draft was written\. The measured evidence is below\./ });
});

test('"empty card": a "..." draft is done with 0 cards and one notice', async (t) => {
  const { store, res } = await run(t, { llm: model({ cards: [{ ...card('Ana', 'a1', 'The rooftop was perfect.'), body: '...' }] }) });
  assertNotice(store, res, { title: 'Google Business run produced an empty card',
    body: /^The run drafted "Reply draft: Cannery Hall, Ana, Google" but the text is only "\.\.\.", so it was not saved as a draft\./ });
  assert.strictEqual(store.cards.find((c) => c.title === 'Google Business run produced an empty card').checks.empty_card, true);
});

test('"already drafted, nothing new": a Run now that finds only seen items is done with 0 cards and one notice', async (t) => {
  const store = createMemoryStore({ lint, now });
  const env = tree(t);
  const first = await run(t, { llm: model({ cards: [card('Ana', 'a1', 'The rooftop was perfect.')] }), store, env });
  assert.strictEqual(first.res.cards.length, 1, 'the first run drafts Ana');
  const { res } = await run(t, { llm: model({ cards: [card('Ana', 'a1', 'The rooftop was perfect.')] }), ask: 'Draft the new replies.', store, env });
  assertNotice(store, res, { title: 'Google Business: already drafted, nothing new',
    body: /^Everything this run found was drafted before, so nothing was redrafted:\n\n- Reply draft: Cannery Hall, Ana, Google: / });
  assert.strictEqual(res.seen_skipped, 1);
  assert.strictEqual(runLine('gbp', res), 'gbp: done, 0 card(s), 1 skipped as already seen');
});

test('mixed: 2 real drafts and 1 empty card reports 2', async (t) => {
  const { store, res } = await run(t, { llm: model({ cards: [card('Ana', 'a1', 'The rooftop was perfect.'), card('Ben', 'b2', 'Great staff.'),
    { ...card('Cy', 'c3', 'Lovely.'), body: '...' }] }) });
  assertNotice(store, res, { title: 'Google Business run produced an empty card', body: /^The run drafted "Reply draft: Cannery Hall, Cy, Google"/, drafts: 2 });
  assert.deepStrictEqual(res.cards.map((c) => c.title), ['Reply draft: Cannery Hall, Ana, Google', 'Reply draft: Cannery Hall, Ben, Google']);
  assert.strictEqual(runLine('gbp', res), 'gbp: done, 2 card(s)');
});

test('KNOWN-GOOD control: a run that drafts a card is done with 1 card and no notices', async (t) => {
  const { store, res } = await run(t, { llm: model({ cards: [card('Ana', 'a1', 'The rooftop was perfect.')] }) });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.cards.length, 1);
  assert.strictEqual(store.runList.find((x) => x.agent === 'gbp').cards, 1);
  assert.deepStrictEqual(res.notices || [], []);
});
