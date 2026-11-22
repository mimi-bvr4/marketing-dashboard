'use strict';
// ORDER #3750 (REPLY #3726 side note 1): a due run that FAILED today is raised by
// the morning health line, never "all clear". On 11.19-11.22.2026 gbp (and once
// PR Patty) failed with exit 1 and the line still said "all clear", because a
// failed run counted as `ran` and no alert covered a failure.
//
// Stub store only (the in-memory store), no database, no model call. Every
// state other than `failed` must give the same line and alerts as before,
// character for character.
const { test } = require('node:test');
const assert = require('node:assert');

const H = require('../lib/team-health');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

function clocked(now) {
  let t = now;
  const store = createMemoryStore({ lint, now: () => t });
  return { store, at: (d) => { t = d; } };
}
async function run(s, agent, when, fin) { s.at(when); const id = await s.store.startRun(agent); await s.store.finishRun(id, fin); }

// ---- (a) the 11.22 shape: gbp failed, PR Patty done -------------------------
const YMD22 = '2026-11-22';
const NOW22 = new Date('2026-11-22T13:00:00Z'); // 07:00 CST, after the 06:00 run
const DEFS22 = [
  { slug: 'gbp', name: 'Google Business', sources: [] },
  { slug: 'pr-patty', name: 'PR Patty', sources: [] },
];
async function fixture22() {
  const s = clocked(NOW22);
  await run(s, 'gbp', new Date('2026-11-22T12:01:00Z'), { status: 'failed', cards: 0, unavailable: [], note: 'FICTIONAL REASON the model returned nothing' });
  await run(s, 'pr-patty', new Date('2026-11-22T12:02:00Z'), { status: 'done', cards: 1, unavailable: [] });
  s.at(NOW22);
  return s.store;
}

test('RED->GREEN (a): a due run that failed today is state `failed`, one `failed` alert, and the line is not all clear', async () => {
  const store = await fixture22();
  const h = await H.teamHealth({ ymd: YMD22, store, defs: DEFS22, due: ['gbp', 'pr-patty'], now: NOW22 });
  const row = (slug) => h.agents.find((a) => a.slug === slug);
  assert.strictEqual(row('gbp').state, 'failed');
  assert.strictEqual(row('pr-patty').state, 'ran');
  assert.deepStrictEqual(h.alerts, [{ kind: 'failed', slug: 'gbp', line: "Google Business's due run failed" }]);
  assert.doesNotMatch(h.line, /all clear/);
  // A failed run did run: it counts in "N of M due runs ran" (the alert carries the failure).
  assert.strictEqual(h.due_ran, 2);
  // Before (main): 'Marketing team 11.22: all clear. 2 of 2 due runs ran, 0 drafts waiting.'
  assert.strictEqual(h.line, "Marketing team 11.22: 1 alert: Google Business's due run failed. 2 of 2 due runs ran, 0 drafts waiting.");
  assert.doesNotMatch(h.line, /#\d/);
  // Narrow reads: the failure's reason never leaves.
  assert.ok(!(JSON.stringify(h) + h.line).includes('FICTIONAL REASON'));
});

test('a later run today that finished supersedes a failed one: the newest run today decides', async () => {
  const store = await fixture22();
  const s = { store, at: () => {} };
  await store.finishRun(await store.startRun('gbp'), { status: 'done', cards: 1, unavailable: [] });
  const h = await H.teamHealth({ ymd: YMD22, store: s.store, defs: DEFS22, due: ['gbp', 'pr-patty'], now: new Date('2026-11-22T23:00:00Z') });
  assert.strictEqual(h.agents.find((a) => a.slug === 'gbp').state, 'ran');
  assert.ok(!h.alerts.some((a) => a.kind === 'failed'));
});

// ---- (b) every other state reads exactly as before --------------------------
const YMD = '2026-11-04'; // a Wednesday
const NOW = new Date('2026-11-04T13:00:00Z');
const DEFS = [
  { slug: 'gbp', name: 'Google Business', sources: [] },        // due, ran
  { slug: 'pr-patty', name: 'PR Patty', sources: [] },          // due, blocked
  { slug: 'scout', name: 'Scout', sources: [] },                // due, missed
  { slug: 'seo', name: 'SEO', sources: [] },                    // due, held by the Producer
  { slug: 'copywriter', name: 'Copywriter', sources: [], card_only: 'on request' }, // paused
  { slug: 'site-health', name: 'Site Health', sources: [] },    // not due
];
async function fixtureAll() {
  const s = clocked(NOW);
  await run(s, 'gbp', new Date('2026-11-04T12:01:00Z'), { status: 'done', cards: 2, unavailable: [] });
  await run(s, 'pr-patty', new Date('2026-11-04T12:02:00Z'), { status: 'blocked', cards: 0, unavailable: [] });
  await run(s, 'site-health', new Date('2026-11-02T12:00:00Z'), { status: 'failed', cards: 0, unavailable: [] }); // not due today: not raised
  s.at(NOW);
  await s.store.producerLog({ ymd: YMD, week_start: '2026-11-02', agent: 'seo', decision: 'held', why: 'x', cards: 0 });
  return s.store;
}

test('(b) ran / blocked / missed / held / paused / not due: states, alerts and line byte-identical to main', async () => {
  const store = await fixtureAll();
  const h = await H.teamHealth({ ymd: YMD, store, defs: DEFS, due: ['gbp', 'pr-patty', 'scout', 'seo'], now: NOW });
  assert.deepStrictEqual(h.agents.map((a) => [a.slug, a.state]), [
    ['gbp', 'ran'], ['pr-patty', 'blocked'], ['scout', 'missed'], ['seo', 'held'], ['copywriter', 'paused'], ['site-health', 'not due'],
  ]);
  assert.deepStrictEqual(h.alerts, [{ kind: 'missed', slug: 'scout', line: 'Scout missed its due run' }]);
  assert.strictEqual(h.line, 'Marketing team 11.04: 1 alert: Scout missed its due run. 2 of 4 due runs ran, 1 blocked, 0 drafts waiting.');
  const clear = await H.teamHealth({ ymd: YMD, store: createMemoryStore({ lint, now: () => NOW }), defs: DEFS.slice(0, 1), due: [], now: NOW });
  assert.strictEqual(clear.line, 'Marketing team 11.04: all clear. 0 of 0 due runs ran, 0 drafts waiting.');
});

// ---- (c) the weekly list counts failed days -----------------------------------
function dayOf(ymd, agents) {
  return { ymd, agents: agents.map((a) => ({ stuck_asks: 0, oldest_ask_hours: null, drafts: 0, oldest_draft_hours: null, blocked: false, ...a })), alerts: [] };
}

test('RED->GREEN (c): weeklyList gives a failed character its own line (look into the failed run; failed N due runs)', () => {
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'].map((ymd, i) => dayOf(ymd, [
    { slug: 'gbp', name: 'Google Business', state: i === 0 ? 'ran' : 'failed' },
    { slug: 'pr-patty', name: 'PR Patty', state: i === 3 ? 'failed' : 'ran' },
    { slug: 'scout', name: 'Scout', state: 'ran' },
  ]));
  const r = H.weeklyList({ weekStart: '2026-11-16', days });
  assert.deepStrictEqual(r.lines, [
    { slug: 'gbp', name: 'Google Business', what: 'look into the failed run', why: 'failed 3 due runs' },
    { slug: 'pr-patty', name: 'PR Patty', what: 'look into the failed run', why: 'failed 1 due run' },
  ]);
});

test('(c) a missed run still leads the weekly line; the failed count joins the why', () => {
  const days = [
    dayOf('2026-11-16', [{ slug: 'gbp', name: 'Google Business', state: 'missed' }]),
    dayOf('2026-11-17', [{ slug: 'gbp', name: 'Google Business', state: 'failed' }]),
  ];
  assert.deepStrictEqual(H.weeklyList({ weekStart: '2026-11-16', days }).lines, [
    { slug: 'gbp', name: 'Google Business', what: 'look into the missed run', why: 'missed 1 due run; failed 1 due run' },
  ]);
});
