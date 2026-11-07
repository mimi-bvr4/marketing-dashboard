'use strict';
// ORDER #3116 (Mimi, 11.07.2026, popup answers "Brief only" and "Percent only on home"):
// the home page is the morning brief only, it makes ZERO /api/hubspot/search
// calls, shows no dollar amount, lists failed agents first, never spins
// forever, and the Period dropdown is generated from today's date in Nashville.
//
//   node --test test/order3116_home_brief_only.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const HOME = read('index.html');
const NUMBERS = read('numbers.html');
const { periodOptions } = require('../public/period-options');
const TeamBrief = require('../public/team-brief');

// ---- Run the home page's own scripts in a sandbox and record every fetch. ----
function fakeEl() {
  return { textContent: '', innerHTML: '', classList: { add() {}, toggle() {} } };
}
const AGENTS = [
  { slug: 'ai-tell-detective', name: 'AI Slop Stopper', job: 'j', sources: [], last_run: { status: 'done', finished_at: '2026-11-07T12:00:00Z' } },
  { slug: 'bloggy-bob', name: 'Bloggy Bob', job: 'j', sources: [], last_run: { status: 'done', finished_at: '2026-11-07T12:00:00Z' } },
  { slug: 'paid-ads', name: 'Paid Ads', job: 'j', paused: 'until a source exists', sources: [], last_run: null },
  { slug: 'pinterest-paul', name: 'Pinterest Paul', job: 'j', sources: [], last_run: { status: 'failed', note: 'Pinterest answered 401\nsecond line' } },
  { slug: 'gbp', name: 'Concierge', job: 'j', sources: [{ label: 'GBP API', required: true, pending: true, why: 'Google review pending' }], last_run: { status: 'done' } },
  { slug: 'scout', name: 'Scout', job: 'j', sources: [], last_run: { status: 'failed', note: null } },
];
const ANSWERS = {
  '/api/review/cards?status=draft': { cards: [] },
  '/api/agents': { agents: AGENTS },
  '/api/open-dates?months=3': { venues: [{ code: 'TBB', name: 'The Bridge Building', open_saturdays: 2, open: [{ label: 'Sat 11.14.2026' }, { label: 'Fri 11.13.2026' }] }, { code: 'ECD', name: 'Event Center', open_saturdays: 1, open: [] }] },
  '/api/competitors': { competitors: [] },
  '/api/revenue-goal': { ytd: 14325328, goal: 19600000, as_of_ct: '10:45 CT' },
};
async function runHome({ answers = ANSWERS, hang = [] } = {}) {
  const els = {};
  const calls = [];
  const timers = [];
  const ctx = {
    console,
    document: { getElementById: (id) => (els[id] = els[id] || fakeEl()) },
    fetch: (u, opts) => {
      calls.push(String(u));
      if (hang.includes(u)) {
        return new Promise((_, rej) => { opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
      }
      const body = answers[u];
      return Promise.resolve({ ok: !!body, status: body ? 200 : 500, json: () => Promise.resolve(body || { error: 'nope' }) });
    },
    AbortController,
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    Date, Number, String, Math, Array, Promise, Error,
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('team-brief.js'), ctx);
  for (const m of HOME.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(m[1], ctx);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  return { els, calls, fireTimers: async () => { timers.splice(0).forEach((f) => f()); await settle(); } };
}

test('home issues no HubSpot search: zero /api/hubspot/search calls when its scripts run', async () => {
  const { calls } = await runHome();
  assert.strictEqual(calls.filter((u) => /hubspot/i.test(u)).length, 0, calls.join(', '));
  assert.deepStrictEqual(calls.slice().sort(), Object.keys(ANSWERS).sort(), 'one call per card, nothing else');
  // and nothing in the page source that could make one
  assert.doesNotMatch(HOME, /\/api\/hubspot\/search|callHs\(|fetchAll\(|loadPeriod\(/);
  assert.doesNotMatch(HOME, /chart\.js/, 'the trend chart moved with the numbers');
});

test('home page source has no "$" anywhere, and the goal tile is percent and pace only', async () => {
  assert.strictEqual(HOME.indexOf('$'), -1);
  const { els } = await runHome();
  assert.strictEqual(els['home-goal'].textContent, (14325328 / 19600000 * 100).toFixed(1) + '%');
  assert.match(els['home-goal-sub'].textContent, /^of goal · (on|behind) pace · as of 10:45 CT$/);
});

test('Katherine\'s team: failed first (with the stored reason), then waiting on a person, then one folded line', async () => {
  const { els } = await runHome();
  const h = els['home-team'].innerHTML;
  const at = (s) => h.indexOf(s);
  assert.ok(at('Pinterest Paul') >= 0 && at('Scout') >= 0 && at('Concierge') >= 0);
  assert.ok(at('Pinterest Paul') < at('Concierge') && at('Scout') < at('Concierge'), 'failed before waiting');
  assert.match(h, /Pinterest Paul<\/b><span class="why">Pinterest answered 401<\/span>/, 'one-line reason, first line only');
  assert.strictEqual((h.match(/last run failed/g) || []).length, 2);
  assert.match(h, /waiting on a person/);
  assert.doesNotMatch(h, /Bloggy Bob|Paid Ads|AI Slop Stopper/, 'the rest are folded, not listed');
  assert.match(h, /2 ran fine, 1 paused or not run yet · see the team/);
});

test('TeamBrief: a paused agent that never ran is folded, never on top; all-fine reads "N others ran fine"', () => {
  const b = TeamBrief.split([
    { name: 'A', sources: [], last_run: { status: 'done' } },
    { name: 'B', sources: [], last_run: { status: 'done' } },
  ]);
  assert.strictEqual(TeamBrief.othersLine(b), '2 others ran fine · see the team');
  const p = TeamBrief.split([{ name: 'P', paused: 'off', sources: [{ required: true, pending: true }], last_run: null }]);
  assert.strictEqual(p.waiting.length, 0, 'paused is not "waiting on a person"');
  assert.strictEqual(p.others.length, 1);
  const ask = TeamBrief.split([{ name: 'Q', sources: [], asks: [{ status: 'awaiting_exec' }], last_run: { status: 'done' } }]);
  assert.strictEqual(ask.waiting.length, 1);
});

test('Open Saturdays renders a number, and an honest reason instead of a forever spinner', async () => {
  const ok = await runHome();
  assert.strictEqual(ok.els['home-open-sat'].textContent, 3);
  const slow = await runHome({ hang: ['/api/open-dates?months=3'] });
  await slow.fireTimers();
  assert.strictEqual(slow.els['home-open-sat'].textContent, '?');
  assert.match(slow.els['home-open-sub'].textContent, /^could not load \(no answer in 15 seconds\)$/);
  assert.match(slow.els['home-open'].innerHTML, /Open dates could not load right now \(no answer in 15 seconds\)/);
  const bad = await runHome({ answers: { ...ANSWERS, '/api/open-dates?months=3': undefined } });
  assert.strictEqual(bad.els['home-open-sat'].textContent, '?');
  assert.match(bad.els['home-open-sub'].textContent, /could not load \(nope\)/);
});

test('the open-dates route can be read ahead (warm), so a cold home load is a cache hit', async () => {
  const { createOpenDatesRouter } = require('../routes/open-dates');
  let n = 0;
  const r = createOpenDatesRouter({ search: async () => { n++; return { results: [] }; }, now: () => new Date('2026-11-07T16:00:00Z') });
  await r.warm(3);
  assert.strictEqual(n, 1);
  const app = express(); app.use(r);
  const srv = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/open-dates?months=3`);
    assert.strictEqual(res.headers.get('x-cache'), 'HIT');
    assert.strictEqual(n, 1, 'no second HubSpot read');
  } finally { srv.close(); }
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /setTimeout\(\(\) => openDates\.warm\(3\), 5000\)/);
  assert.match(src, /setInterval\(\(\) => openDates\.warm\(3\), OPEN_DATES_CACHE_MS - 60 \* 1000\)/);
});

test('the Period list is generated from the date in Nashville, not hard-coded', () => {
  const nov = periodOptions(new Date('2026-11-07T17:00:00Z'));
  assert.deepStrictEqual(nov.map((o) => o.value), ['mtd', '2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01', 'ytd']);
  assert.strictEqual(nov[0].label, 'Nov 2026 MTD');
  assert.strictEqual(nov[1].label, 'Oct 2026');
  assert.strictEqual(nov.find((o) => o.selected).value, 'ytd');
  // 03.01.2027 03:00 UTC is still 02.28.2027 in Nashville: February, not March.
  const feb = periodOptions(new Date('2027-03-01T03:00:00Z'));
  assert.deepStrictEqual(feb.map((o) => o.label), ['Feb 2027 MTD', 'Jan 2027', '2027 YTD']);
  assert.strictEqual(periodOptions(new Date('2026-01-15T18:00:00Z')).length, 2, 'January: MTD and YTD only');
  // the numbers page builds its select from it; the old hard-coded list is gone
  assert.match(NUMBERS, /<select id="period"><\/select>/);
  assert.match(NUMBERS, /<script src="\/period-options\.js"><\/script>/);
  assert.doesNotMatch(NUMBERS, /<option value="2026-04">/);
});

test('every moved section is on Katherine\'s Numbers, and the home tab points there', () => {
  for (const id of ['numbers', 'goal-ytd', 'goal-pct', 'kpi-grid', 'ai-body', 'open-dates-body', 'funnel-content', 'funnel-body', 'source-body', 'type-body', 'channel-body', 'fixed-body', 'ceo-revenue-body', 'revenue-body', 'proj-month-body', 'proj-venue-body', 'trend-chart', 'panel-elle'].filter((x) => x !== 'kpi-grid')) {
    assert.ok(NUMBERS.includes(`id="${id}"`), 'numbers.html missing #' + id);
    assert.ok(!HOME.includes(`id="${id}"`), 'home still carries #' + id);
  }
  assert.match(HOME, /href="\/numbers">Katherine's Numbers<\/a>/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.get\('\/numbers', \(req, res\) => res\.sendFile\(path\.join\(__dirname, 'public', 'numbers\.html'\)\)\)/);
  assert.ok(src.indexOf("app.get('/numbers'") > src.indexOf('app.use(pageGate)'), 'below the sign-in gate');
  assert.ok(src.indexOf("app.get('/numbers'") < src.indexOf("app.get('*'"), 'above the SPA fallback');
});

test('home: the six brief parts, a true subtitle, no em dash, tab row on one line', () => {
  for (const s of ['id="home-hello"', 'class="home-tiles"', 'Needs a look', "Katherine's team", 'Open Saturdays to push', 'Competitor watch']) assert.ok(HOME.includes(s), s);
  assert.doesNotMatch(HOME, /Real-Time Marketing Dashboard|Live from HubSpot/);
  assert.match(HOME, /<span class="sub">Morning brief &middot; Katherine's team<\/span>/);
  assert.doesNotMatch(HOME, /—|&mdash;/);
  assert.match(HOME, /\.tab-nav\.home-nav \{ flex-wrap: nowrap;/);
  for (const href of ['/review', '/numbers', '/agents', '/competitors', '/cadet', '/web', '/photos']) assert.ok(HOME.includes(`href="${href}"`), href);
});
