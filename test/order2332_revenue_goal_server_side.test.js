'use strict';
// ORDER #2332: the home "2026 revenue goal" tile read "..." for about 30
// seconds because the page paged every 2026 deal through /api/hubspot/search
// after the whole period load. Now the server sums it once, caches it 15
// minutes, and the page reads one answer with an "as of HH:MM CT" stamp.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('fs');
const path = require('path');

const RG = require('../lib/revenue-goal');
const { createRevenueGoalRouter } = require('../routes/revenue-goal');
const { FLEET_READ_PREFIXES } = require('../middleware/page-gate');

const NOW = new Date('2026-10-24T20:15:00Z'); // Sat 10.24.2026 15:15 CT
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// THE OLD METHOD, verbatim from updateGoalBar() in public/index.html on main
// 3b6a455 (the page's own toEpochMs, filters and sum). It is the oracle the
// new server sum must match, deal for deal.
function oldToEpochMs(d) { const x = new Date(d); return String(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())); }
function oldFilters() {
  const yStart = new Date(Date.UTC(2026, 0, 1)).toISOString();
  const yEnd = new Date(Date.UTC(2027, 0, 1)).toISOString();
  return [{ filters: [
    { propertyName: 'pipeline', operator: 'IN', values: ['746391920', 'default'] },
    { propertyName: 'final_event_total_accounting', operator: 'HAS_PROPERTY' },
    { propertyName: 'actual_event_date', operator: 'GTE', value: oldToEpochMs(yStart) },
    { propertyName: 'actual_event_date', operator: 'LT', value: oldToEpochMs(yEnd) }
  ] }];
}
function oldSum(deals, today) {
  const now = today.toISOString();
  let ytd = 0;
  for (const d of deals) {
    if ((d.properties?.actual_event_date || '') <= now) {
      ytd += (parseFloat(d.properties?.final_event_total_accounting || '0') || 0) * 0.95;
    }
  }
  return ytd;
}

// 450 fake deals: three pages of HubSpot cursor paging, a mix of past, today,
// future, date-only and datetime values, blanks and junk amounts.
function fakeDeals() {
  const out = [];
  for (let i = 0; i < 450; i++) {
    const month = (i % 12) + 1, day = (i % 27) + 1;
    const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const actual = i % 3 === 0 ? `${date}T00:00:00Z` : date;
    const amount = i % 17 === 0 ? '' : i % 23 === 0 ? 'n/a' : String(1000 + i * 37.5);
    out.push({ id: String(i), properties: { actual_event_date: actual, final_event_total_accounting: amount, venue: ['TBB', 'TBT', 'ECD', 'SWF', 'OS'][i % 5] } });
  }
  out.push({ id: 'today', properties: { actual_event_date: '2026-10-24', final_event_total_accounting: '5000' } });
  out.push({ id: 'nodate', properties: { final_event_total_accounting: '7000' } });
  return out;
}
function pagedSearch(deals, calls = []) {
  return async (type, body) => {
    calls.push({ type, body });
    const start = body.after ? Number(body.after) : 0;
    const results = deals.slice(start, start + body.limit);
    const next = start + body.limit < deals.length ? { next: { after: String(start + body.limit) } } : undefined;
    return { total: deals.length, results, paging: next };
  };
}

test('filters are the page\'s own, unchanged', () => {
  assert.deepStrictEqual(RG.goalFilterGroups(), oldFilters());
  assert.strictEqual(RG.IHG_GOAL_2026, 19600000);
  assert.strictEqual(RG.REVENUE_NET_MULTIPLIER, 0.95);
  assert.match(HTML, /const IHG_GOAL_2026 = 19600000;/);
  assert.match(HTML, /const REVENUE_NET_MULTIPLIER = 0\.95;/);
});

test('the server sum matches the old page method on the same deals and the same minute', async () => {
  const deals = fakeDeals();
  const calls = [];
  const out = await RG.computeRevenueGoal({ search: pagedSearch(deals, calls), now: NOW });
  assert.strictEqual(out.ytd, oldSum(deals, NOW), 'matches');
  assert.strictEqual(out.hubspot_calls, 3, 'cursor-paged: 452 deals is 3 pages of 200');
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls[0].body.filterGroups, oldFilters());
  assert.deepStrictEqual(calls[0].body.properties, ['final_event_total_accounting', 'venue', 'actual_event_date']);
  assert.strictEqual(calls[1].body.after, '200');
  assert.strictEqual(out.as_of, NOW.toISOString());
  assert.strictEqual(out.as_of_ct, '15:15 CT');
  assert.ok(out.events > 0 && out.events < deals.length, 'future events are not counted');
});

test('the stamp is Nashville time, both sides of the 19:00 CT UTC rollover', () => {
  assert.strictEqual(RG.stampCT(new Date('2026-10-25T01:05:00Z')), '20:05 CT');
  assert.strictEqual(RG.stampCT(new Date('2026-10-24T05:00:00Z')), '00:00 CT');
});

test('cache: 15 minutes, one HubSpot read for callers at once, refresh on demand', async () => {
  let n = 0, t = NOW.getTime();
  const search = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return { results: [] }; };
  const cache = RG.createRevenueGoalCache({ search, now: () => new Date(t) });
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.strictEqual(n, 1, 'two callers during one read share it');
  assert.strictEqual(a.cache, 'MISS'); assert.strictEqual(b.cache, 'MISS');
  assert.strictEqual((await cache.get()).cache, 'HIT');
  t += RG.CACHE_MS - 1000;
  assert.strictEqual((await cache.get()).cache, 'HIT');
  assert.strictEqual(n, 1);
  t += 2000;
  assert.strictEqual((await cache.get()).cache, 'MISS', 'expired after 15 minutes');
  assert.strictEqual(n, 2);
  assert.strictEqual((await cache.get({ refresh: true })).cache, 'MISS');
  assert.strictEqual(n, 3, 'refresh reads HubSpot now');
  assert.strictEqual(RG.CACHE_MS, 15 * 60 * 1000);
});

test('route: warm cache answers under 2 seconds, ?refresh=1 rereads, HubSpot failure is a 502 sentence', async (t) => {
  const deals = fakeDeals();
  const calls = [];
  // Each HubSpot page costs 400 ms here, so a cold read is over a second and a warm one must skip it.
  const slow = pagedSearch(deals, calls);
  const search = async (type, body) => { await new Promise((r) => setTimeout(r, 400)); return slow(type, body); };
  const cache = RG.createRevenueGoalCache({ search, now: () => NOW });
  const a = express(); a.use(createRevenueGoalRouter({ cache }));
  const bad = express(); bad.use(createRevenueGoalRouter({ cache: RG.createRevenueGoalCache({ search: async () => { throw new Error('HubSpot answered 500'); } }) }));
  const serve = (app) => new Promise((r) => { const s = http.createServer(app).listen(0, () => { t.after(() => new Promise((x) => s.close(x))); r(s); }); });
  const get = (s, p) => new Promise((res) => http.get({ host: '127.0.0.1', port: s.address().port, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, json: JSON.parse(b), cache: r.headers['x-cache'] })); }));
  const s = await serve(a);
  await cache.warm(); // what the server does at boot and every 15 minutes
  const t0 = Date.now();
  const warm = await get(s, '/api/revenue-goal');
  const ms = Date.now() - t0;
  assert.strictEqual(warm.status, 200);
  assert.strictEqual(warm.cache, 'HIT');
  assert.ok(ms < 2000, `warm answer took ${ms} ms`);
  assert.strictEqual(warm.json.ytd, oldSum(deals, NOW), 'matches');
  assert.match(warm.json.as_of_ct, /^\d\d:\d\d CT$/);
  assert.strictEqual(calls.length, 3);
  const re = await get(s, '/api/revenue-goal?refresh=1');
  assert.strictEqual(re.cache, 'MISS');
  assert.strictEqual(calls.length, 6);
  const e = await get(await serve(bad), '/api/revenue-goal');
  assert.strictEqual(e.status, 502);
  assert.match(e.json.error, /HubSpot read failed/);
});

test('page: the goal bar reads /api/revenue-goal once at boot, never pages HubSpot, tile says Counting', () => {
  const fn = HTML.slice(HTML.indexOf('async function updateGoalBar'), HTML.indexOf('async function loadProjectedRevenue'));
  assert.match(fn, /fetch\('\/api\/revenue-goal'/);
  assert.doesNotMatch(fn, /fetchAll\(|callHs\(|\/api\/hubspot\/search/);
  assert.match(fn, /goal-asof/);
  const load = HTML.slice(HTML.indexOf('async function loadPeriod'), HTML.indexOf('// ---- CONVERSION FUNNEL RENDER'));
  assert.doesNotMatch(load, /updateGoalBar\(/, 'not re-run behind every period load');
  assert.strictEqual((HTML.match(/updateGoalBar\(\);/g) || []).length, 1, 'asked once at boot');
  assert.ok(HTML.indexOf('updateGoalBar();') < HTML.indexOf("await loadPeriod(resolvePeriod('ytd'))"), 'asked before the period load');
  assert.match(HTML, /id="home-goal">Counting&hellip;</);
  assert.match(HTML, /id="goal-refresh"/);
});

test('a money figure: not readable by a fleet key', () => {
  assert.ok(!FLEET_READ_PREFIXES.some((p) => '/api/revenue-goal'.startsWith(p)));
});

test('server.js mounts the route, warms it at boot and every 15 minutes, through the test-deal filter', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.slice(src.indexOf('ORDER #2332'), src.indexOf('// ---- AI Narrative Proxy'));
  assert.match(block, /createRevenueGoalRouter\(\{ cache \}\)/);
  assert.match(block, /excludeTestDeals\(objectType, body\)/);
  assert.match(block, /enqueueHubSpot\(/);
  assert.match(block, /setInterval\(cache\.warm, CACHE_MS\)/);
  assert.ok(src.indexOf('ORDER #2332') > src.indexOf('app.use(pageGate)'), 'below the sign-in gate');
});
