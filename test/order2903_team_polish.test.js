'use strict';
// ORDER #2903: marketing team polish (memo 2026-10-24 sections 6D and 6E, and
// ruling 5 of 11.03.2026). Acceptance:
//   - the team page shows the Web Agent and Site Guardian cards;
//   - the Monthly Report carries the email scorecard; the Email agent no longer
//     runs on the 3rd;
//   - Paid Ads is paused: a board line, never a weekly "could not run" card,
//     until the Google + Meta export Sheet exists;
//   - Site Guardian's card says its alerts go to Mimi first. (The alert ROUTE
//     itself is messaging code and rides its own branch, held for Mimi.)
// No test here loads express, so it runs in a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');

const P = require('../lib/producer');
const { listAgents, loadAgent, runAgent } = require('../lib/agent-runner');
const { dueAgents } = require('../jobs/agent_run');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const EM = '—';
const ORDER_NO = /#\d|ORDER \d/i;

function katherineSees(def) {
  const c = def.character;
  return [def.name, def.job, def.cadence, def.card_only || '', c.role, ...c.does, ...c.traits.flatMap((t) => [t.cant, t.instead]), ...c.needs, def.skill].join('\n');
}

test('the team page has both new cards, each with a character (job, never, traits)', () => {
  const slugs = listAgents();
  for (const s of ['web', 'site-guardian']) {
    assert.ok(slugs.includes(s), s);
    const d = loadAgent(s);
    assert.ok(d.character && d.character.role && d.character.does.length && d.character.traits.length, s);
    assert.match(d.skill, new RegExp(`^---\\nname: ${s}\\ndescription: .+\\n---`), s);
    const words = katherineSees(d);
    assert.doesNotMatch(words, ORDER_NO, `${s}: no order numbers in what Katherine sees`);
    assert.ok(!words.includes(EM), `${s}: no em dash`);
    assert.ok(P.cardOnly(d), `${s} is a card only`);
  }
  assert.strictEqual(loadAgent('site-guardian').character.role, 'The night watch');
  assert.strictEqual(loadAgent('web').character.role, 'The web builder');
  assert.strictEqual(loadAgent('web').ask_page, '/web');
});

test('ruling 5: Site Guardian says its alerts go to Mimi first, never Katherine first', () => {
  const d = loadAgent('site-guardian');
  assert.ok(d.character.does.some((x) => /alert goes to Mimi first/.test(x)));
  assert.ok(d.character.traits.some((t) => /^Alert Katherine first$/.test(t.cant) && /Mimi first/.test(t.instead)));
  assert.match(d.skill, /\*\*Mimi first\*\*, never to Katherine first/);
});

test('a card-only team member is never run by the marketing runner, scheduled or asked', async () => {
  for (const s of ['web', 'site-guardian']) {
    const store = createMemoryStore({ lint });
    for (const scheduled of [true, false]) {
      const r = await runAgent({ slug: s, store, llm: null, scheduled, ask: scheduled ? null : 'go' });
      assert.strictEqual(r.skipped, 'card only', s);
    }
    assert.strictEqual(store.cards.length, 0, `${s}: no card`);
    assert.strictEqual(store.runList.length, 0, `${s}: no run row`);
  }
});

test('the board: one plain line for each new card, and Paid Ads paused (not a card)', () => {
  const defs = ['web', 'site-guardian', 'paid-ads'].map((s) => loadAgent(s));
  const b = P.board({ ymd: '2026-11-04', defs });
  const line = (s) => b.find((x) => x.slug === s);
  assert.deepStrictEqual([line('web').state, line('web').line], ['own', 'works on its own page, Web: upload a page there']);
  assert.deepStrictEqual([line('site-guardian').state, line('site-guardian').line], ['own', 'not running yet: the read-only watch is being built']);
  assert.strictEqual(line('paid-ads').state, 'paused');
  assert.strictEqual(line('paid-ads').line, 'paused until the Google + Meta ads export Sheet exists; waiting since 10.13');
  for (const x of b) assert.doesNotMatch(x.line, ORDER_NO);
});

test('Paid Ads is off both schedules while its Sheet is pending; under the Producer it is a log row, never a run', async () => {
  for (const d of ['2026-11-02', '2026-11-09', '2026-11-16']) assert.ok(!dueAgents(d).includes('paid-ads'), d);
  const store = createMemoryStore({ lint });
  const ran = [];
  const rows = await P.runDay({ ymd: '2026-11-05', store, maxCardsOf: () => 1, draftsWaiting: async () => 0, defOf: loadAgent,
    runOne: async (a) => { ran.push(a); return { ok: true, cards: [], unavailable: [] }; } });
  assert.ok(!ran.includes('paid-ads'));
  const pa = rows.find((r) => r.agent === 'paid-ads');
  assert.strictEqual(pa.decision, 'paused');
  assert.strictEqual(pa.cards, 0);
  assert.strictEqual(store.cards.length, 0, 'no could-not-run card');
});

test('the pause ends by itself the day the Sheet is connected', () => {
  const pa = loadAgent('paid-ads');
  assert.ok(P.pausedFor(pa));
  const connected = { ...pa, sources: pa.sources.map((s) => (s.label === pa.paused_until ? { ...s, type: 'sheet' } : s)) };
  assert.strictEqual(P.pausedFor(connected), null);
  assert.strictEqual(P.pausedFor({ sources: [] }), null);
  assert.strictEqual(P.pausedFor(null), null);
});

test('memo 6D: the Monthly Report absorbs the email scorecard; one report on the 3rd, not two', () => {
  const mr = loadAgent('monthly-report');
  const stats = mr.sources.find((s) => s.type === 'hubspot_email_stats');
  assert.ok(stats, 'the Monthly Report reads the HubSpot email statistics');
  assert.ok(!stats.required, 'a missing email read never stops the whole report');
  assert.ok(mr.sources.some((s) => s.newest === '07_Marketing_and_Brand/Email_Buildout/W1_AUDIT_'), 'and the W1 baseline');
  assert.match(mr.skill, /\*\*Email scorecard\*\*/);
  assert.match(mr.skill, /no email number at all/);
  const em = loadAgent('email');
  assert.ok(!em.sources.some((s) => s.type === 'hubspot_email_stats' || s.only_scheduled));
  assert.doesNotMatch(em.skill, /## The monthly scorecard/);
  assert.ok(dueAgents('2026-12-03').includes('monthly-report'));
  assert.ok(!dueAgents('2026-12-03').includes('email'));
  assert.ok(!P.dueOn('2026-12-03').includes('email'));
  assert.ok(P.dueOn('2026-12-03').includes('monthly-report'));
});
