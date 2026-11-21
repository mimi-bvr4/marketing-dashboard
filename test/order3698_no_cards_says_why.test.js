'use strict';
// ORDER #3698: marketing-agents exited 1 on 11.19 (pr-patty), 11.20 and 11.21
// (gbp) with "<agent>: FAILED the model returned no cards". None was a hold
// morning (3 and 4 drafts waiting, hold 20), so #3416's split fix did not apply.
// The log could not say WHY: the model answering {"cards":[]} and the runner
// dropping cards that had no title or body both end in the same line. Verdict
// CAN'T TELL, so this adds the one log line that settles it, and nothing else:
//   "<slug>: no card kept: the model's JSON held <N> card(s) ..."
// N = 0: the model drafted nothing (honest empty or a prompt fault, read the
// answer's start); N > 0: the cards were dropped by the parse (PARSE-DROPPED).
//
// Acceptance:
//   - the empty answer (the 11.20/11.21 shape) logs the line with N = 0 and
//     still FAILS exactly as before (no behaviour change);
//   - cards with no body log the line with N = 2 (the PARSE-DROPPED shape);
//   - KNOWN-GOOD control: a morning that drafts a card logs no such line and
//     finishes 'done' with its card.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');

const AT = new Date('2026-11-21T12:00:00Z'); // 06:00 CT
const now = () => AT;

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3698-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pulse.md'), '# Venue review pulse\n- Cannery Hall, Google, Ana, 5 stars: "The rooftop was perfect."\n');
  return { IHG_TREE: root };
}

const gbpDef = () => ({ ...loadAgent('gbp'), copy_prepass: false,
  sources: [{ type: 'file', path: 'pulse.md', required: true, label: 'the newest review pulse' }] });

function model(answer) {
  return { model: 'fake', lastStop: 'end_turn', async complete() { return JSON.stringify(answer); } };
}

async function run(t, answer) {
  const store = createMemoryStore({ lint, now });
  const lines = [];
  const res = await runAgent({ def: gbpDef(), store, llm: model(answer), env: tree(t), now, scheduled: true,
    log: (l) => lines.push(l), fetchImpl: async () => { throw new Error('no network'); } });
  return { store, lines, res, why: lines.filter((l) => /no card kept/.test(l)) };
}

test('11.21 shape: an empty answer says the JSON held 0 cards, and still fails as before', async (t) => {
  const { store, why, res } = await run(t, { cards: [] });
  assert.strictEqual(why.length, 1, 'exactly one settling line');
  assert.match(why[0], /^gbp: no card kept: the model's JSON held 0 card\(s\); stop end_turn; 0 item\(s\) listed as already drafted; answer starts: \{"cards":\[\]\}$/);
  assert.strictEqual(res.ok, false);
  const r = store.runList.find((x) => x.agent === 'gbp');
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.note, 'the model returned no cards');
});

test('PARSE-DROPPED shape: cards with no body are counted, so the line tells the two causes apart', async (t) => {
  const { why, res } = await run(t, { cards: [{ title: 'Reply draft: Cannery Hall, Ana, Google' }, { title: 'Post idea' }] });
  assert.strictEqual(why.length, 1);
  assert.match(why[0], /the model's JSON held 2 card\(s\)/);
  assert.strictEqual(res.ok, false);
});

test('KNOWN-GOOD control: a morning that drafts a card logs no such line and stays done', async (t) => {
  const { store, why, res } = await run(t, { cards: [{ title: 'Reply draft: Cannery Hall, Ana, Google',
    body: 'Review date: 11.20.2026 | Stars: 5 | Google review id: abc\n\nThank you, Ana. We are glad the rooftop was perfect for your day at Cannery Hall.',
    seen: { venue: 'Cannery Hall', reviewer: 'Ana', platform: 'Google', review_id: 'abc', review_text: 'The rooftop was perfect.' } }] });
  assert.strictEqual(why.length, 0);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.cards.length, 1);
  assert.strictEqual(store.runList.find((x) => x.agent === 'gbp').status, 'done');
});
