'use strict';
// ORDER #2918 (#2898 steps 3 and 4): the marketing team's daily health check
// and the weekly improvement list for Mimi.
//
// Every morning, per agent: ran / missed a due run / blocked (a required source
// missing), the drafts waiting and the oldest one's age, and any ask older than
// 24h with no answer. Alerts: a missed due run, an ask stuck past 24h, or 15 or
// more drafts waiting. Read only, and only agent, status and time columns: never
// a card body, a source, a payload, a reason, or the text of an ask.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const H = require('../lib/team-health');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { createAgentsRouter } = require('../routes/agents');

const YMD = '2026-11-04'; // a Wednesday
const NOW = new Date('2026-11-04T13:00:00Z'); // 07:00 CST, after the 06:00 run
const K = 'katherine@infinityhospitality.net';
const DEFS = [
  { slug: 'gbp', name: 'Google Business', sources: [] },
  { slug: 'pr-patty', name: 'PR Patty', sources: [] },
  { slug: 'scout', name: 'Scout', sources: [] },
  { slug: 'seo', name: 'SEO', sources: [{ type: 'search_console', required: true, label: 'Search Console' }] },
  { slug: 'copywriter', name: 'Copywriter', sources: [{ type: 'request', required: true, label: 'the request' }] },
];
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3);

// A store whose clock the test moves, so every row has a known time.
function clocked() {
  let t = NOW;
  const store = createMemoryStore({ lint, now: () => t });
  return { store, at: (d) => { t = d; } };
}
async function run(s, agent, when, fin) { s.at(when); const id = await s.store.startRun(agent); await s.store.finishRun(id, fin); }

async function fixture() {
  const s = clocked();
  // gbp and patty are due today; gbp ran, patty did not.
  await run(s, 'gbp', new Date('2026-11-04T12:01:00Z'), { status: 'done', cards: 2, unavailable: [] });
  await run(s, 'pr-patty', new Date('2026-11-03T12:01:00Z'), { status: 'done', cards: 0, unavailable: [] });
  // SEO is not due on a Wednesday; its last run missed its required source.
  await run(s, 'seo', new Date('2026-11-02T12:00:00Z'), { status: 'done', cards: 1, unavailable: [{ label: 'Search Console', why: 'token expired secret=abc' }] });
  // Drafts: three of Scout's, the oldest 50 hours old.
  for (const h of [50, 10, 2]) { s.at(hoursAgo(h)); await s.store.insert({ agent: 'scout', agent_name: 'Scout', job: 'x', title: 'SECRET TITLE', body: 'SECRET BODY' }); }
  // Asks: one stuck 30h, one fresh 2h, one 40h old but answered (an order was filed).
  s.at(hoursAgo(30)); await s.store.createAsk('scout', 'PRIVATE ASK TEXT one', K);
  s.at(hoursAgo(2)); await s.store.createAsk('scout', 'PRIVATE ASK TEXT two', K);
  s.at(hoursAgo(40)); const b = await s.store.createAsk('gbp', 'PRIVATE ASK TEXT three', K);
  await s.store.updateAsk(b.ask.id, { status: 'building' });
  s.at(NOW);
  return s;
}

test('RED->GREEN: per agent, ran / missed a due run / blocked / not due, from the due list and the run history', async () => {
  const { store } = await fixture();
  const h = await H.teamHealth({ ymd: YMD, store, defs: DEFS, due: ['gbp', 'pr-patty'], now: NOW });
  const row = (slug) => h.agents.find((a) => a.slug === slug);
  assert.strictEqual(row('gbp').state, 'ran');
  assert.strictEqual(row('pr-patty').state, 'missed');
  assert.strictEqual(row('seo').state, 'blocked');
  assert.strictEqual(row('seo').blocked, true);
  assert.strictEqual(row('scout').state, 'not due');
  // An on-request agent's "the request" is not a missing source.
  assert.strictEqual(row('copywriter').blocked, false);
  assert.ok(h.alerts.some((a) => a.kind === 'missed' && a.slug === 'pr-patty'));
  assert.ok(!h.alerts.some((a) => a.kind === 'missed' && a.slug === 'gbp'));
});

test('drafts waiting per agent and the oldest one\'s age; 15 or more waiting is an alert, 14 is not', async () => {
  const { store } = await fixture();
  const h = await H.teamHealth({ ymd: YMD, store, defs: DEFS, due: [], now: NOW });
  const scout = h.agents.find((a) => a.slug === 'scout');
  assert.strictEqual(scout.drafts, 3);
  assert.strictEqual(scout.oldest_draft_hours, 50);
  assert.strictEqual(h.drafts_waiting, 3);
  assert.ok(!h.alerts.some((a) => a.kind === 'drafts'));
  for (let i = 0; i < 11; i++) await store.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'x', title: 't', body: 'b' });
  assert.ok(!(await H.teamHealth({ ymd: YMD, store, defs: DEFS, due: [], now: NOW })).alerts.some((a) => a.kind === 'drafts'), '14 waiting');
  await store.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'x', title: 't', body: 'b' });
  const h15 = await H.teamHealth({ ymd: YMD, store, defs: DEFS, due: [], now: NOW });
  assert.ok(h15.alerts.some((a) => a.kind === 'drafts' && /^15 drafts are waiting/.test(a.line)));
  // A Monday digest is not a draft waiting on Katherine.
  await store.insert({ agent: 'digest', agent_name: 'Monday digest', job: 'x', title: 'd', body: 'd' });
  assert.strictEqual((await H.teamHealth({ ymd: YMD, store, defs: DEFS, due: [], now: NOW })).drafts_waiting, 15);
});

test('an ask older than 24h with no answer is an alert; a fresh one or an answered one is not', async () => {
  const { store } = await fixture();
  const h = await H.teamHealth({ ymd: YMD, store, defs: DEFS, due: [], now: NOW });
  const asks = h.alerts.filter((a) => a.kind === 'ask');
  assert.strictEqual(asks.length, 1);
  assert.strictEqual(asks[0].slug, 'scout');
  assert.strictEqual(h.agents.find((a) => a.slug === 'scout').stuck_asks, 1);
  assert.strictEqual(h.agents.find((a) => a.slug === 'gbp').stuck_asks, 0, 'building = answered');
  assert.match(asks[0].line, /Scout has an ask waiting 30h with no answer/);
});

test('only the allowed columns: no card title or body, no ask text, no source, no reason', async () => {
  const { store } = await fixture();
  const h = await H.teamHealth({ ymd: YMD, store, defs: DEFS, due: ['gbp', 'pr-patty'], now: NOW });
  const s = JSON.stringify(h) + H.summaryLine(h);
  for (const bad of ['SECRET TITLE', 'SECRET BODY', 'PRIVATE ASK', 'Search Console', 'token expired', 'secret=']) assert.ok(!s.includes(bad), bad);
});

test('read only: the check calls nothing on the store but reads', async () => {
  const { store } = await fixture();
  const called = new Set();
  const spy = new Proxy(store, { get(o, k) { const v = o[k]; if (typeof v === 'function') called.add(k); return typeof v === 'function' ? v.bind(o) : v; } });
  await H.teamHealth({ ymd: YMD, store: spy, defs: DEFS, due: ['gbp'], now: NOW });
  for (const k of called) assert.ok(H.READS.includes(k), `called ${k}`);
});

test('under the Producer, a run it held or paused today is not a missed run', async () => {
  const { store } = await fixture();
  await store.producerLog({ ymd: YMD, week_start: '2026-11-02', agent: 'pr-patty', decision: 'held', why: 'x', cards: 0 });
  const h = await H.teamHealth({ ymd: YMD, store, defs: DEFS, due: ['gbp', 'pr-patty'], now: NOW });
  assert.strictEqual(h.agents.find((a) => a.slug === 'pr-patty').state, 'held');
  assert.ok(!h.alerts.some((a) => a.kind === 'missed'));
});

test('the one morning line for Mimi: alerts first, or all clear; no order numbers', async () => {
  const { store } = await fixture();
  const h = await H.teamHealth({ ymd: YMD, store, defs: DEFS, due: ['gbp', 'pr-patty'], now: NOW });
  const line = H.summaryLine(h);
  assert.match(line, /^Marketing team 11\.04: 2 alerts: PR Patty missed its due run; Scout has an ask waiting 30h with no answer\. 1 of 2 due runs ran, 1 blocked, 3 drafts waiting\.$/);
  assert.doesNotMatch(line, /#\d/);
  const clear = await H.teamHealth({ ymd: YMD, store: createMemoryStore({ lint, now: () => NOW }), defs: DEFS.slice(0, 1), due: [], now: NOW });
  assert.strictEqual(H.summaryLine(clear), 'Marketing team 11.04: all clear. 0 of 0 due runs ran, 0 drafts waiting.');
});

test('the due list defaults to the live schedule (dueAgents, or the Producer\'s calendar when it is on)', async () => {
  const store = createMemoryStore({ lint, now: () => NOW });
  const off = await H.teamHealth({ ymd: '2026-11-02', store, defs: DEFS, now: NOW, env: {} });
  assert.deepStrictEqual(off.due.slice().sort(), ['convention-connector', 'gbp', 'pr-patty', 'scout', 'seo', 'site-health']);
  const on = await H.teamHealth({ ymd: '2026-11-02', store, defs: DEFS, now: NOW, env: { PRODUCER_CALENDAR: 'on' } });
  assert.ok(!on.due.includes('convention-connector'), 'the Producer moved it to Tuesday');
});

// ---- the weekly list ------------------------------------------------------
function dayOf(ymd, agents) {
  return { ymd, agents: agents.map((a) => ({ stuck_asks: 0, oldest_ask_hours: null, drafts: 0, oldest_draft_hours: null, blocked: false, ...a })), alerts: [] };
}
const WEEKF = [
  dayOf('2026-11-02', [{ slug: 'scout', name: 'Scout', state: 'missed' }, { slug: 'seo', name: 'SEO', state: 'blocked', blocked: true }, { slug: 'gbp', name: 'Google Business', state: 'ran' }]),
  dayOf('2026-11-03', [{ slug: 'scout', name: 'Scout', state: 'not due', stuck_asks: 1, oldest_ask_hours: 30 }, { slug: 'seo', name: 'SEO', state: 'blocked', blocked: true }, { slug: 'gbp', name: 'Google Business', state: 'ran', drafts: 4, oldest_draft_hours: 200 }]),
  dayOf('2026-11-04', [{ slug: 'scout', name: 'Scout', state: 'not due', stuck_asks: 1, oldest_ask_hours: 54 }, { slug: 'gbp', name: 'Google Business', state: 'ran' }]),
];

test('weekly list: one line per character (which, what, why) from the week\'s checks', () => {
  const r = H.weeklyList({ weekStart: '2026-11-02', days: WEEKF });
  assert.deepStrictEqual(r.lines.map((l) => l.name), ['Scout', 'SEO', 'Google Business']);
  const scout = r.lines[0];
  assert.match(scout.what, /missed run/);
  assert.match(scout.why, /missed 1 due run/);
  assert.match(scout.why, /an ask waited 54h with no answer/);
  assert.match(r.lines[1].why, /blocked on 2 days/);
  assert.match(r.lines[2].why, /oldest draft waited 8 days/);
  // A healthy character is not on the list.
  const quiet = H.weeklyList({ weekStart: '2026-11-02', days: [dayOf('2026-11-02', [{ slug: 'gbp', name: 'Google Business', state: 'ran' }])] });
  assert.strictEqual(quiet.lines.length, 0);
});

test('weekly list: ONE _DROPS/awaiting record per week, in the five-field shape; a second write that week is refused', () => {
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'h2918-'));
  const r = H.writeWeekly({ inbox, weekStart: '2026-11-02', days: WEEKF, stamp: '11.09.2026 06:05 CT' });
  assert.ok(r.file.endsWith(path.join('_DROPS', 'awaiting', 'marketing_team_week_2026-11-02.md')));
  const md = fs.readFileSync(r.file, 'utf8');
  assert.match(md, /^## \[PREFERENCE\] 11\.09\.2026 06:05 CT, marketing team week of 11\.02/m);
  for (const f of ['**DO:**', '**WHY IT\'S STUCK:**', '**HOW LONG:**', '**WHAT IT UNBLOCKS:**', '**AGE:**']) assert.ok(md.includes(f), f);
  assert.match(md, /^- Scout: .+ \(why: .+\)$/m);
  assert.doesNotMatch(md, /#\d/);
  const again = H.writeWeekly({ inbox, weekStart: '2026-11-02', days: WEEKF, stamp: '11.09.2026 07:00 CT' });
  assert.strictEqual(again.skipped, 'this week already has its record');
  assert.strictEqual(fs.readdirSync(path.join(inbox, '_DROPS', 'awaiting')).length, 1);
  // Nothing to improve: no record at all.
  const none = H.writeWeekly({ inbox, weekStart: '2026-11-09', days: [], stamp: 'x' });
  assert.strictEqual(none.skipped, 'nothing to improve this week');
});

test('weekly list: the days come from the run history, not a new table (rebuilt for each day of the week)', async () => {
  const { store } = await fixture();
  const days = await H.weekDays({ weekStart: '2026-11-02', upTo: YMD, store, defs: DEFS, now: NOW, env: {} });
  assert.deepStrictEqual(days.map((d) => d.ymd), ['2026-11-02', '2026-11-03', '2026-11-04']);
});

// ---- the schedule: rides the 06:00 run ------------------------------------
test('schedule: agent_run --due ends with the health line (and on Sunday the weekly list), never in --dry', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'agent_run.js'), 'utf8');
  assert.match(src, /require\('\.\.\/lib\/team-health'\)\.dailyStep/);
  const { store } = await fixture();
  const lines = [];
  const out = await H.dailyStep({ ymd: YMD, store, defs: DEFS, due: ['gbp', 'pr-patty'], now: NOW, log: (l) => lines.push(l), inbox: null, env: {} });
  assert.ok(lines[0].startsWith('team health: Marketing team 11.04: 2 alerts'));
  assert.strictEqual(out.weekly, null, 'not a Sunday');
  // FEATURE FLAG: MARKETING_WEEKLY_LIST default OFF: on Sunday, off writes nothing.
  assert.strictEqual(H.weeklyOn({}), false);
  const off = await H.dailyStep({ ymd: '2026-11-08', store, defs: DEFS, due: [], now: NOW, log: (l) => lines.push(l), inbox: os.tmpdir(), env: {} });
  assert.strictEqual(off.weekly.skipped, 'MARKETING_WEEKLY_LIST is off');
  const sun = await H.dailyStep({ ymd: '2026-11-08', store, defs: DEFS, due: [], now: NOW, log: (l) => lines.push(l), inbox: null, env: { MARKETING_WEEKLY_LIST: 'on' } });
  assert.match(sun.weekly.skipped, /no project tree/);
});

// ---- the page --------------------------------------------------------------
function serve(a, t) {
  return new Promise((resolve) => {
    const srv = http.createServer(a).listen(0, () => {
      t.after(() => srv.close());
      resolve(async (url) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${url}`); return { status: r.status, json: await r.json() }; });
    });
  });
}
test('the Producer card carries the health check (GET /api/producer .health) and the page draws it', async (t) => {
  const { store } = await fixture();
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.mktUser = { email: K }; next(); });
  a.use(createAgentsRouter({ store, clock: () => NOW }));
  const get = await serve(a, t);
  const r = await get('/api/producer');
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.health && Array.isArray(r.json.health.agents) && Array.isArray(r.json.health.alerts));
  assert.strictEqual(r.json.health.ymd, YMD);
  assert.match(r.json.health.line, /^Marketing team 11\.04: /);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
  assert.match(html, /p\.health/);
  assert.match(html, /This morning's check/);
});
