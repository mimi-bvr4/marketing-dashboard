'use strict';
// ORDER #3416: Google Business showed "failed: the model returned no cards" on
// 11.14 and 11.15. Diagnosis (REPLY #3416): both mornings the Producer's hold was
// on (20 in the 11.09-11.22 window; 21+ drafts waiting when gbp ran), so gbp ran
// in its #2909 split, "draft ONLY the reply cards your instructions mark RED".
// No review was RED, the model honestly answered no cards, and the runner's
// `if (!drafted) throw` turned that into a red on the board.
//
// Acceptance:
//   - KNOWN-BAD (the 11.14 replay): under the hold, an honest empty answer
//     finishes 'done' with a plain reason, no "run failed" card, and the board
//     line says so (state 'ran', never 'failed');
//   - KNOWN-GOOD control: with the hold off, an empty answer still fails exactly
//     as today ("the model returned no cards").
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = require('../lib/producer');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');

const YMD = '2026-11-14';
const AT = new Date('2026-11-14T12:00:00Z'); // 06:00 CT
const now = () => AT;

const LINE = 'ran today, 0 cards: nothing to draft: no review needed a RED reply, and post ideas wait while the Producer\'s hold is on';

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3416-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pulse.md'), '# Venue review pulse\n- Cannery Hall, Google, Ana, 5 stars: "The rooftop was perfect."\n');
  return { IHG_TREE: root };
}

const gbpDef = () => ({ ...loadAgent('gbp'), copy_prepass: false,
  sources: [{ type: 'file', path: 'pulse.md', required: true, label: 'the newest review pulse' }] });

// The model answers honestly: nothing to draft.
function emptyModel() {
  const calls = [];
  return { model: 'fake', calls, async complete(req) { calls.push(req); return JSON.stringify({ cards: [] }); } };
}

function dayRunner({ store, llm, env }) {
  return async (slug, opts = {}) => {
    if (slug !== 'gbp') return { ok: true, cards: [], unavailable: [] };
    const split = opts.only ? P.holdSplit(slug, opts.only) : null;
    return runAgent({ def: gbpDef(), store, llm, env, now, scheduled: true,
      fetchImpl: async () => { throw new Error('no network'); }, ...(split ? { split } : {}) });
  };
}

async function waitingDrafts(store, n) {
  // #3924: action drafts; a report card (an 'seo' card with no payload) no longer counts toward the hold.
  for (let i = 0; i < n; i++) await store.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'x', title: `waiting ${i}`, body: 'x' });
}

async function boardLine(store) {
  const history = new Map();
  for (const h of await store.runHistory(20)) { const a = history.get(h.agent) || []; a.push(h); history.set(h.agent, a); }
  const today = store.producerRows.filter((r) => r.ymd === YMD);
  return P.board({ ymd: YMD, defs: [{ slug: 'gbp', name: 'Google Business', sources: gbpDef().sources }], history, today, env: {} })[0];
}

test('KNOWN-BAD 11.14 replay: under the hold, an honest empty answer is not a failure and the board says why', async (t) => {
  const store = createMemoryStore({ lint, now });
  await waitingDrafts(store, 21);
  const llm = emptyModel();
  const rows = await P.runDay({ ymd: YMD, store, maxCardsOf: () => 4, runOne: dayRunner({ store, llm, env: tree(t) }) });

  assert.match(llm.calls[0].user, /THE PRODUCER'S HOLD IS ON/, 'gbp ran in the RED-only split, as on 11.14');
  const row = rows.find((r) => r.agent === 'gbp');
  assert.strictEqual(row.decision, 'ran');
  const run = store.runList.find((r) => r.agent === 'gbp');
  assert.strictEqual(run.status, 'done');
  assert.doesNotMatch(String(run.note), /no cards/);
  assert.match(run.note, /no review needed a RED reply/);
  assert.ok(!store.cards.some((c) => c.agent === 'gbp'), 'no "run failed" card, no card at all');

  const b = await boardLine(store);
  assert.strictEqual(b.state, 'ran');
  assert.strictEqual(b.line, LINE);
});

test('KNOWN-GOOD control: with the hold off, an empty answer still fails as today', async (t) => {
  const store = createMemoryStore({ lint, now });
  await waitingDrafts(store, 3);
  const llm = emptyModel();
  const rows = await P.runDay({ ymd: YMD, store, maxCardsOf: () => 4, runOne: dayRunner({ store, llm, env: tree(t) }) });

  assert.doesNotMatch(llm.calls[0].user, /HOLD IS ON/);
  assert.strictEqual(rows.find((r) => r.agent === 'gbp').decision, 'failed');
  const run = store.runList.find((r) => r.agent === 'gbp');
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.note, 'the model returned no cards');
  assert.ok(store.cards.some((c) => c.agent === 'gbp' && /run failed/.test(c.title)));
  const b = await boardLine(store);
  assert.strictEqual(b.state, 'failed');
  assert.strictEqual(b.line, 'ran today and failed: the model returned no cards');
});

test('the split names its empty reason; agents without a split are untouched', () => {
  assert.strictEqual(P.holdSplit('gbp', 'red').empty,
    'nothing to draft: no review needed a RED reply, and post ideas wait while the Producer\'s hold is on');
  assert.strictEqual(P.holdSplit('pr-patty', 'red'), null);
});
