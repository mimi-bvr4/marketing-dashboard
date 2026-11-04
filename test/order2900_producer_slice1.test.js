'use strict';
// ORDER #2900: the Producer, slice 1. The calendar, the brakes, and the board.
// Acceptance (the order's own lines):
//   - a replay of the 10.13 to 10.19 week runs the same agents, spread across
//     the days, with no week over the cap;
//   - a test with 16 waiting drafts holds Scout but runs Patty;
//   - the board shows Paid Ads waiting on the ads export Sheet since 10.13.
const { test } = require('node:test');
const assert = require('node:assert');

const P = require('../lib/producer');
const { dueAgents } = require('../jobs/agent_run');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');

const WEEK = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'];

// The real card counts of that week's scheduled runs, read read-only from
// agent_runs on 11.03.2026 (box_ro_select --db marketing). Google Business and
// PR Patty by day (Patty's first run of the day; 10.13 had none); every other
// agent by its one scheduled run that week. Paid Ads is 1 because it wrote the
// "could not run" card; under the Producer that becomes a board line.
const GBP = { '2026-10-13': 4, '2026-10-14': 4, '2026-10-15': 3, '2026-10-16': 2, '2026-10-17': 1, '2026-10-18': 1, '2026-10-19': 2 };
const PATTY = { '2026-10-19': 1 };
const ONCE = { citations: 5, 'site-health': 1, scout: 1, seo: 1, 'convention-connector': 2 };
const maxCardsOf = (slug) => loadAgent(slug).max_cards || 3;

function replayRunner(ymd, ran) {
  return async (agent) => {
    ran.push({ ymd, agent });
    if (agent === 'paid-ads') return { ok: true, blocked: ['Google + Meta ads export Sheet'], cards: [], unavailable: [] };
    const n = agent === 'gbp' ? GBP[ymd] || 0 : agent === 'pr-patty' ? PATTY[ymd] || 0 : ONCE[agent] || 0;
    return { ok: true, cards: Array.from({ length: n }, () => ({})), unavailable: [] };
  };
}

test('REPLAY 10.13 to 10.19, drafts decided as they come: the same agents run, spread across the days, no week over the cap', async () => {
  const store = createMemoryStore({ lint });
  const ran = [];
  for (const ymd of WEEK) {
    const rows = await P.runDay({ ymd, store, maxCardsOf, runOne: replayRunner(ymd, ran), draftsWaiting: async () => 0 });
    assert.ok(rows.every((r) => r.decision !== 'held'), `${ymd}: nothing held (${JSON.stringify(rows)})`);
  }
  const old = new Set(WEEK.flatMap((d) => dueAgents(d)));
  const now = new Set(ran.map((r) => r.agent));
  assert.deepStrictEqual([...now].sort(), [...old].sort(), 'the same agents run that week');
  // Spread: the old Monday carried 5 weekly agents; the Producer's carries 3.
  const oldMon = dueAgents('2026-10-19').filter((a) => !['gbp', 'pr-patty'].includes(a));
  const newMon = ran.filter((r) => r.ymd === '2026-10-19' && !['gbp', 'pr-patty'].includes(r.agent)).map((r) => r.agent);
  assert.strictEqual(oldMon.length, 5);
  assert.deepStrictEqual(newMon.sort(), ['scout', 'seo', 'site-health']);
  assert.ok(ran.some((r) => r.ymd === '2026-10-13' && r.agent === 'convention-connector'), 'Convention Connector on Tuesday');
  assert.ok(ran.some((r) => r.ymd === '2026-10-15' && r.agent === 'paid-ads'), 'Paid Ads on Thursday');
  // No cap week over 25 (10.13 to 10.18 fall in the week of 10.12; 10.19 starts the next).
  const a = await store.producerWeekCards('2026-10-12');
  const b = await store.producerWeekCards('2026-10-19');
  assert.ok(a <= P.WEEKLY_CAP && b <= P.WEEKLY_CAP, `weeks: ${a} and ${b}`);
  assert.strictEqual(a, 22); // 15 GBP + 5 Citations + 2 Convention Connector; Paid Ads is a board line now
  assert.strictEqual(b, 6);
  // The Paid Ads run is recorded as waiting, never as a card.
  assert.ok(store.producerRows.some((r) => r.agent === 'paid-ads' && r.decision === 'waiting' && /export Sheet/.test(r.why)));
});

test('REPLAY 10.13 to 10.19, nothing decided (as it really went): the 15-waiting hold stops Monday 10.19, Patty and Google Business still run', async () => {
  const store = createMemoryStore({ lint });
  const ran = [];
  let waiting = 0;
  for (const ymd of WEEK) {
    const rows = await P.runDay({ ymd, store, maxCardsOf, runOne: replayRunner(ymd, ran), draftsWaiting: async () => waiting });
    waiting += rows.reduce((n, r) => n + r.cards, 0);
  }
  const mon = store.producerRows.filter((r) => r.ymd === '2026-10-19');
  for (const a of ['seo', 'site-health', 'scout']) {
    const r = mon.find((x) => x.agent === a);
    assert.strictEqual(r.decision, 'held', a);
    assert.match(r.why, /drafts are waiting for review \(the hold starts at 15\)/);
  }
  assert.strictEqual(mon.find((x) => x.agent === 'pr-patty').decision, 'ran');
  assert.strictEqual(mon.find((x) => x.agent === 'gbp').decision, 'ran');
});

test('KNOWN-BAD: 16 waiting drafts hold Scout but run Patty', async () => {
  const store = createMemoryStore({ lint });
  for (let i = 0; i < 16; i++) await store.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'x', title: `draft ${i}`, body: 'x' });
  assert.strictEqual(await store.draftsWaiting(), 16);
  const ran = [];
  const rows = await P.runDay({ ymd: '2026-11-02', store, maxCardsOf, runOne: async (a) => { ran.push(a); return { ok: true, cards: [], unavailable: [] }; } });
  assert.ok(ran.includes('pr-patty'), 'Patty runs');
  assert.ok(!ran.includes('scout'), 'Scout is held');
  const scout = rows.find((r) => r.agent === 'scout');
  assert.strictEqual(scout.decision, 'held');
  assert.match(scout.why, /^16 drafts are waiting/);
  // A digest card is not a draft waiting on Katherine.
  await store.insert({ agent: 'digest', agent_name: 'Monday digest', job: 'x', title: 'digest', body: 'x' });
  assert.strictEqual(await store.draftsWaiting(), 16);
});

test('the weekly cap: a run that could pass 25 scheduled cards is held; exempt agents never are', () => {
  assert.strictEqual(P.decide({ agent: 'scout', waiting: 0, used: 24, maxCards: 1 }).run, true);
  const h = P.decide({ agent: 'citations', waiting: 0, used: 21, maxCards: 5 });
  assert.strictEqual(h.run, false);
  assert.match(h.why, /21 of 25 scheduled cards and this run could add 5/);
  assert.strictEqual(P.decide({ agent: 'pr-patty', waiting: 90, used: 40, maxCards: 2 }).run, true);
  assert.strictEqual(P.decide({ agent: 'gbp', waiting: 90, used: 40, maxCards: 4 }).run, true);
});

test('the board shows Paid Ads waiting on the ads export Sheet since 10.13', () => {
  const pa = loadAgent('paid-ads');
  const history = new Map([['paid-ads', [
    { started_at: new Date('2026-11-02T12:05:00Z'), status: 'blocked', cards: 0, unavailable: [{ label: 'Google + Meta ads export Sheet' }] },
    { started_at: new Date('2026-10-11T12:08:00Z'), status: 'done', cards: 1, unavailable: [{ label: 'Google + Meta ads export Sheet' }] },
  ]]]);
  const b = P.board({ ymd: '2026-11-03', defs: [pa], history });
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].state, 'waiting');
  assert.strictEqual(b[0].line, 'waiting on Google + Meta ads export Sheet since 10.13');
  assert.doesNotMatch(b[0].line, /#\d/, 'no order numbers in what Katherine sees');
});

test('the board: one line per team member; held, ran today, paused, failed, on request', () => {
  const def = (slug) => ({ ...loadAgent(slug) });
  const history = new Map([
    ['gbp', [{ started_at: new Date('2026-11-03T12:01:00Z'), status: 'done', cards: 3, unavailable: [] }]],
    ['pinterest-paul', [{ started_at: new Date('2026-10-28T15:00:00Z'), status: 'failed', cards: 1, unavailable: [] }]],
  ]);
  const settings = new Map([['site-health', { enabled: false, edited_by: 'khowe@infinityhospitality.net' }]]);
  const today = [{ agent: 'scout', decision: 'held', why: '16 drafts are waiting for review (the hold starts at 15)' }];
  const b = P.board({ ymd: '2026-11-03', defs: ['gbp', 'pinterest-paul', 'site-health', 'scout', 'copywriter'].map(def), history, settings, today });
  const line = (s) => b.find((x) => x.slug === s);
  assert.strictEqual(line('gbp').line, 'ran today, 3 cards');
  assert.strictEqual(line('pinterest-paul').line, 'last run failed 10.28');
  assert.match(line('site-health').line, /^paused on the Agents page by khowe@/);
  assert.match(line('scout').line, /^held today: 16 drafts/);
  assert.strictEqual(line('copywriter').line, 'ready when asked');
  // Without a declared date the board counts the streak of runs that missed it.
  const seo = { slug: 'seo', name: 'SEO', sources: [{ type: 'search_console', required: true, label: 'Search Console' }] };
  const h2 = new Map([['seo', [
    { started_at: new Date('2026-11-02T12:00:00Z'), status: 'done', cards: 1, unavailable: [{ label: 'Search Console' }] },
    { started_at: new Date('2026-10-26T12:00:00Z'), status: 'done', cards: 1, unavailable: [{ label: 'Search Console' }] },
    { started_at: new Date('2026-10-19T12:00:00Z'), status: 'done', cards: 1, unavailable: [{ label: 'Search Console' }] },
  ]]]);
  assert.strictEqual(P.board({ ymd: '2026-11-03', defs: [seo], history: h2 })[0].line, 'waiting on Search Console since 10.19');
});

test('the calendar: Katherine moves a weekly day (logged); daily and monthly do not move; a bad day is refused', async () => {
  assert.match(P.checkMove('pr-patty', ['mon']).error, /daily/);
  assert.match(P.checkMove('citations', ['mon']).error, /monthly/);
  assert.match(P.checkMove('scout', ['funday']).error, /not a day/);
  assert.match(P.checkMove('scout', []).error, /one to three/);
  assert.match(P.checkMove('bloggy-bob', ['wed']).error, /not on the calendar/);
  const ok = P.checkMove('scout', ['Wednesday']);
  assert.deepStrictEqual(ok.days, ['wed']);
  const store = createMemoryStore({ lint });
  assert.match((await store.setCalendarDays('scout', ok.days, null)).error, /no person/);
  await store.setCalendarDays('scout', ok.days, 'khowe@infinityhospitality.net');
  assert.strictEqual(store.calendarLogRows.length, 1);
  assert.strictEqual(store.calendarLogRows[0].changed_by, 'khowe@infinityhospitality.net');
  const cal = P.calendar(await store.calendarRows());
  assert.ok(!P.dueOn('2026-11-02', cal).includes('scout'), 'not Monday any more');
  assert.ok(P.dueOn('2026-11-04', cal).includes('scout'), 'Wednesday now');
  // A saved move for a daily agent is ignored, never applied.
  const bad = P.calendar([{ agent: 'pr-patty', days: ['mon'] }]);
  assert.deepStrictEqual(bad.find((e) => e.agent === 'pr-patty').days, ['daily']);
});

test('the default week: exempt agents first; monthly on the 3rd and the 15th', () => {
  assert.deepStrictEqual(P.dueOn('2026-11-02'), ['pr-patty', 'gbp', 'seo', 'site-health', 'scout']);
  assert.deepStrictEqual(P.dueOn('2026-11-03'), ['pr-patty', 'gbp', 'convention-connector', 'monthly-report', 'email']);
  assert.ok(P.dueOn('2026-11-15').includes('citations'));
  assert.strictEqual(P.weekStart('2026-11-03'), '2026-11-02');
  assert.strictEqual(P.weekStart('2026-11-08'), '2026-11-02');
  assert.strictEqual(P.weekStart('2026-11-09'), '2026-11-09');
});

test('FEATURE FLAG: PRODUCER_CALENDAR default OFF; dueAgents() is unchanged while it is off', () => {
  assert.strictEqual(P.producerOn({}), false);
  assert.strictEqual(P.producerOn({ PRODUCER_CALENDAR: '' }), false);
  assert.strictEqual(P.producerOn({ PRODUCER_CALENDAR: 'off' }), false);
  assert.strictEqual(P.producerOn({ PRODUCER_CALENDAR: 'on' }), true);
  assert.deepStrictEqual(dueAgents('2026-11-02'), ['gbp', 'pr-patty', 'site-health', 'paid-ads', 'scout', 'seo', 'convention-connector']);
});

const blockedDef = { slug: 'paid-ads', name: 'Paid Ads Auditor', job: 'weekly ads audit', skill: '# x', max_cards: 1,
  sources: [{ type: 'pending', required: true, label: 'Google + Meta ads export Sheet', why: 'not shared yet' }] };

test('runner: under the Producer a missing required source is a board line, not a "could not run" card', async () => {
  const store = createMemoryStore({ lint });
  const r = await runAgent({ slug: 'paid-ads', def: blockedDef, store, llm: null, scheduled: true, blockedToBoard: true });
  assert.deepStrictEqual(r.blocked, ['Google + Meta ads export Sheet']);
  assert.strictEqual(store.cards.length, 0, 'no card in Review');
  assert.strictEqual(store.runList[0].status, 'blocked');
  assert.match(store.runList[0].note, /^waiting on: Google \+ Meta ads export Sheet/);
});

test('runner: with the flag off (or on a Run now) the "could not run" card is still written, as before', async () => {
  const store = createMemoryStore({ lint });
  await runAgent({ slug: 'paid-ads', def: blockedDef, store, llm: null, scheduled: true });
  assert.strictEqual(store.cards.length, 1);
  assert.match(store.cards[0].title, /could not run: a required source is missing/);
  const s2 = createMemoryStore({ lint });
  await runAgent({ slug: 'paid-ads', def: blockedDef, store: s2, llm: null, scheduled: false, blockedToBoard: true });
  assert.strictEqual(s2.cards.length, 1, 'a person asked; they get the card');
});
