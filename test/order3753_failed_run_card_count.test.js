'use strict';
// ORDER #3753: a failed marketing agent run counted its own failure notice as
// a card. Every failed run logged a line that contradicts itself:
//   "gbp: FAILED the model returned no cards, 1 card(s)"
// because the catch block saved the "<name> run failed" notice through put(),
// which pushes into `written`, and then finishRun stored cards: written.length
// and the runner returned cards: written (jobs/agent_run.js:127 prints
// r.cards.length; lib/producer.js:249 adds it to the week's count).
//
// The fix: the notice is saved outside `written` and returned on its own as
// `notice` (jobs/kh_route.js names it in a failed REPLY). Its title and body
// are unchanged and it still reaches the Review tab.
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

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3753-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pulse.md'), '# Venue review pulse\n- Cannery Hall, Google, Ana, 5 stars: "The rooftop was perfect."\n- Cannery Hall, Google, Ben, 5 stars: "Great staff."\n');
  return { IHG_TREE: root };
}

const gbpDef = () => ({ ...loadAgent('gbp'), copy_prepass: false,
  sources: [{ type: 'file', path: 'pulse.md', required: true, label: 'the newest review pulse' }] });

function model(answer) {
  return { model: 'fake', lastStop: 'end_turn', async complete() { return JSON.stringify(answer); } };
}

// The jobs/agent_run.js:127 line, same template, for the before/after quote.
const runLine = (slug, r) => `${slug}: ${r.ok ? 'done' : 'FAILED ' + r.error}, ${r.cards.length} card(s)${r.seen_skipped ? `, ${r.seen_skipped} skipped as already seen` : ''}${r.unavailable.length ? `, ${r.unavailable.length} source(s) unavailable` : ''}`;

async function run(t, answer, store = createMemoryStore({ lint, now })) {
  const lines = [];
  const res = await runAgent({ def: gbpDef(), store, llm: model(answer), env: tree(t), now, scheduled: true,
    log: (l) => lines.push(l), fetchImpl: async () => { throw new Error('no network'); } });
  return { store, lines, res };
}

test('11.22 gbp shape: an empty answer is a failed run of 0 cards, and the notice still reaches Review', async (t) => {
  const { store, res } = await run(t, { cards: [] });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'the model returned no cards');
  const row = store.runList.find((x) => x.agent === 'gbp');
  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.cards, 0, 'the run row counts drafted cards only');
  assert.strictEqual(res.cards.length, 0, 'the returned cards are drafts only');
  assert.strictEqual(runLine('gbp', res), 'gbp: FAILED the model returned no cards, 0 card(s)');
  const notices = store.cards.filter((c) => c.agent === 'gbp' && c.title === 'Google Business run failed');
  assert.strictEqual(notices.length, 1, 'exactly one failure notice on the Review tab');
  assert.strictEqual(store.cards.filter((c) => c.agent === 'gbp').length, 1);
  assert.match(notices[0].body, /^The run stopped: the model returned no cards\. Nothing was drafted\. The next scheduled run tries again\./);
  assert.ok(res.notice, 'the notice is returned on its own');
  assert.strictEqual(res.notice.id, notices[0].id);
});

test('mid-run failure after 1 real card was saved reports 1, not 2', async (t) => {
  const store = createMemoryStore({ lint, now });
  const insert = store.insert.bind(store);
  let n = 0;
  store.insert = async (c) => { n++; if (n === 2) throw new Error('database went away'); return insert(c); };
  const card = (who, id, text) => ({ title: `Reply draft: Cannery Hall, ${who}, Google`,
    body: `Review date: 11.21.2026 | Stars: 5 | Google review id: ${id}\n\nThank you, ${who}. We are glad you enjoyed your day at Cannery Hall.`,
    seen: { venue: 'Cannery Hall', reviewer: who, platform: 'Google', review_id: id, review_text: text } });
  const { res } = await run(t, { cards: [card('Ana', 'a1', 'The rooftop was perfect.'), card('Ben', 'b2', 'Great staff.')] }, store);
  assert.strictEqual(res.ok, false);
  const row = store.runList.find((x) => x.agent === 'gbp');
  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.cards, 1);
  assert.strictEqual(res.cards.length, 1);
  assert.strictEqual(res.cards[0].title, 'Reply draft: Cannery Hall, Ana, Google');
  assert.strictEqual(store.cards.filter((c) => c.title === 'Google Business run failed').length, 1, 'the notice is still saved');
});

test('KNOWN-GOOD control: a morning that drafts a card is done with 1 card and no notice', async (t) => {
  const { store, res } = await run(t, { cards: [{ title: 'Reply draft: Cannery Hall, Ana, Google',
    body: 'Review date: 11.20.2026 | Stars: 5 | Google review id: abc\n\nThank you, Ana. We are glad the rooftop was perfect for your day at Cannery Hall.',
    seen: { venue: 'Cannery Hall', reviewer: 'Ana', platform: 'Google', review_id: 'abc', review_text: 'The rooftop was perfect.' } }] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.cards.length, 1);
  assert.strictEqual(store.runList.find((x) => x.agent === 'gbp').cards, 1);
  assert.strictEqual(res.notice, undefined);
});
