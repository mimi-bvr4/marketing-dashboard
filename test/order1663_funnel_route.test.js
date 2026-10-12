'use strict';
// ORDER #1663 A: GET /api/funnel/monthly. Driven through the REAL fleetGate and
// REAL pageGate (server.js order) with the real funnel router behind them. The
// HubSpot side is a fake that EVALUATES the filters it is sent, so a wrong
// filter gives a wrong count here. No network.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.JWT_SECRET = 'marketing-test-secret-not-real';
process.env.DISPATCH_JWT_SECRET = 'dispatch-test-secret-not-real';
process.env.DISPATCH_BRIDGE_TOKEN = 'test-only-bridge-token';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
delete process.env.DATABASE_URL;

const { sha256 } = require('../lib/fleet-tokens');
const GOOD_KEY = 'mkt_test-only-funnel-key';
const TOKENS = { [sha256(GOOD_KEY)]: { id: 1, label: 'agent read key', user_id: 'test', revoked_at: null } };
const fakePool = { query: async (sql, params) => (/^SELECT/i.test(sql) ? { rows: TOKENS[params[0]] ? [TOKENS[params[0]]] : [] } : { rows: [] }) };
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool, hasDb: () => true, ensureTables: async () => {} } };
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ active: true, person_id: 'p1', rung: 3, bundle: 'Exec' }) });

const { fleetGate } = require('../middleware/auth');
const { pageGate } = require('../middleware/page-gate');
const { createFunnelRouter } = require('../routes/funnel');
const { previousMonthCT, SALES_PIPELINE } = require('../lib/funnel-defs');
const { excludeTestDeals } = require('../lib/test_deals');

// ---------------------------------------------------------------- fake HubSpot
const DATE_MS = /^\d{10,}$/;
function cmp(rec, val) {
  if (DATE_MS.test(String(val))) return Date.parse(String(rec).slice(0, 10) + 'T00:00:00Z') - Number(val);
  if (/^\d{4}-\d\d-\d\dT/.test(String(val))) return Date.parse(rec) - Date.parse(val);
  return String(rec).localeCompare(String(val));
}
function matches(rec, f) {
  const v = rec.properties[f.propertyName];
  switch (f.operator) {
    case 'EQ': return v != null && String(v) === String(f.value);
    case 'NEQ': return String(v == null ? '' : v) !== String(f.value);
    case 'IN': return v != null && String(v).split(';').some((x) => f.values.includes(x)); // multi-select: any value
    case 'HAS_PROPERTY': return v != null && v !== '';
    case 'GTE': return v != null && v !== '' && cmp(v, f.value) >= 0;
    case 'LT': return v != null && v !== '' && cmp(v, f.value) < 0;
    default: throw new Error('fake HubSpot: unknown operator ' + f.operator);
  }
}
function fakeHubSpot(data) {
  const calls = [];
  const search = async (objectType, rawBody) => {
    const body = excludeTestDeals(objectType, rawBody);   // as server.js does
    calls.push({ objectType, body });
    const all = data[objectType].filter((r) => body.filterGroups.some((g) => g.filters.every((f) => matches(r, f))));
    const start = Number(body.after || 0);
    const page = all.slice(start, start + body.limit);
    return { total: all.length, results: page.map((r) => ({ id: r.id, properties: Object.fromEntries(body.properties.map((p) => [p, r.properties[p] ?? null])) })),
      ...(start + body.limit < all.length ? { paging: { next: { after: String(start + body.limit) } } } : {}) };
  };
  return { search, calls };
}

let n = 0;
const C = (venue, source, createdate) => ({ id: 'c' + (++n), properties: { venue_s_: venue, lead_source: source, createdate } });
const D = (props) => ({ id: 'd' + (++n), properties: props });
const S = SALES_PIPELINE;
const DATA = {
  contacts: [
    C('TBB', 'The Knot', '2026-09-03T15:00:00.000Z'),
    C('TBB;TBT', 'The Knot', '2026-09-10T15:00:00.000Z'),      // first listed venue: TBB
    C('SWF', 'Google', '2026-09-29T23:59:00.000Z'),
    C('ECD', '', '2026-09-15T12:00:00.000Z'),                   // blank source: (none)
    C('OS', 'Google', '2026-09-20T12:00:00.000Z'),
    C('STE', 'Google', '2026-09-20T12:00:00.000Z'),            // not an IHG venue: not a lead
    C('TBB', 'Google', '2026-10-01T00:00:00.000Z'),            // next month
    C('TBB', 'Google', '2026-08-31T23:59:59.000Z'),            // previous month
  ],
  deals: [
    // tours
    D({ pipeline: S, dealname: 'Smith Wedding (Sales Deal)', venue: 'TBB', initial_tour_date: '2026-09-05' }),
    D({ pipeline: 'default', dealname: 'smith  wedding', venue: 'TBB', initial_tour_date: '2026-09-05' }),     // pair: collapses
    D({ pipeline: 'default', dealname: 'Jones Party', venue: 'ECD', initial_tour_date: '2026-09-30' }),       // event-only: counts
    D({ pipeline: S, dealname: 'Lee Gala', venue: 'SWF;TBT', initial_tour_date: '2026-09-12' }),
    D({ pipeline: S, dealname: 'Late Tour', venue: 'TBT', initial_tour_date: '2026-10-01' }),                 // next month
    D({ pipeline: '999', dealname: 'Other Pipe', venue: 'TBT', initial_tour_date: '2026-09-12' }),           // other pipeline
    D({ pipeline: S, dealname: 'Test Tour', venue: 'TBT', initial_tour_date: '2026-09-12', test_deal: 'true' }), // test deal
    // bookings
    D({ pipeline: S, dealname: 'Smith Wedding (Sales Deal)', venue: 'TBB', contract_signed_date: '2026-09-20', amount: '50000' }),
    D({ pipeline: 'default', dealname: 'Smith Wedding', venue: 'TBB', contract_signed_date: '2026-09-21', final_event_total_accounting: '42000' }),
    D({ pipeline: 'default', dealname: 'Cancelled One', venue: 'TBT', contract_signed_date: '2026-09-02', booked_cancelled__reporting_use_only_: 'Cancelled' }),
    D({ pipeline: S, dealname: 'Aug Booking', venue: 'TBT', contract_signed_date: '2026-08-31' }),
  ],
};

function app(search, now) {
  const a = express();
  a.use(fleetGate);
  a.use(pageGate);
  a.use(createFunnelRouter({ search, now }));
  return a;
}
function serve(t, a) {
  return new Promise((resolve) => { const s = http.createServer(a).listen(0, '127.0.0.1', () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
}
function call(server, urlPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}
const key = { authorization: 'Bearer ' + GOOD_KEY };
const execCookie = () => ({ cookie: 'mkt_session=' + encodeURIComponent(jwt.sign({ role: 'sso', email: 'exec@infinityhospitality.net', mkt_access: true }, process.env.JWT_SECRET, { expiresIn: '30d' })) });
const OCT = () => new Date('2026-10-12T15:00:00Z');

test('counts leads by venue and source, tours and bookings by venue, with the dashboard rules', async (t) => {
  const hs = fakeHubSpot(DATA);
  const s = await serve(t, app(hs.search, OCT));
  const r = await call(s, '/api/funnel/monthly?month=2026-09', key);
  assert.strictEqual(r.status, 200, r.body);
  const j = JSON.parse(r.body);
  assert.strictEqual(j.month, '2026-09');
  assert.strictEqual(j.window.start, '2026-09-01T00:00:00.000Z');
  assert.strictEqual(j.window.end, '2026-10-01T00:00:00.000Z');
  assert.strictEqual(j.definitions, 'same as dashboard funnel');
  assert.ok(j.fetched_at);
  assert.strictEqual(j.leads.total, 5);
  assert.deepStrictEqual(j.leads.by_venue, { TBB: 2, TBT: 0, ECD: 1, SWF: 1, OS: 1 });
  assert.deepStrictEqual(Object.keys(j.leads.by_source), ['The Knot', 'Google', '(none)']); // tie keeps first-seen order, as the page's stable sort
  assert.deepStrictEqual(j.leads.by_source['The Knot'], { TBB: 2, TBT: 0, ECD: 0, SWF: 0, OS: 0, total: 2 });
  assert.deepStrictEqual(j.leads.by_source.Google, { TBB: 0, TBT: 0, ECD: 0, SWF: 1, OS: 1, total: 2 });
  assert.strictEqual(j.tours.total, 3);                       // Smith (pair collapsed), Jones (event-only), Lee
  assert.deepStrictEqual(j.tours.by_venue, { TBB: 1, TBT: 0, ECD: 1, SWF: 1, OS: 0 });
  assert.strictEqual(j.tours.event_only, 1);
  assert.strictEqual(j.bookings.total, 2);                    // Smith collapsed; cancelled still counted, as the page does
  assert.deepStrictEqual(j.bookings.by_venue, { TBB: 1, TBT: 1, ECD: 0, SWF: 0, OS: 0 });
  // every deal search carried the test-deal exclusion
  for (const c of hs.calls.filter((x) => x.objectType === 'deals')) assert.ok(c.body.filterGroups.every((g) => g.filters.some((f) => f.propertyName === 'test_deal')));
});

test('COUNTS ONLY: no money key or money property anywhere in the response or the request', async (t) => {
  const hs = fakeHubSpot(DATA);
  const s = await serve(t, app(hs.search, OCT));
  const r = await call(s, '/api/funnel/monthly?month=2026-09', key);
  const MONEY = /amount|revenue|final_event_total|total_accounting|price|spend|cost|\$/i;
  const walk = (o, p = '') => { for (const [k, v] of Object.entries(o)) { if (p.includes('by_source')) continue; assert.ok(!MONEY.test(k), `money key ${p}${k}`); if (v && typeof v === 'object') walk(v, `${p}${k}.`); } };
  walk(JSON.parse(r.body));
  assert.ok(!/50000|42000/.test(r.body));
  for (const c of hs.calls) for (const p of c.body.properties) assert.ok(!/amount|total_accounting|revenue/i.test(p), `requested ${p}`);
});

test('default month is the previous calendar month in Nashville time', async (t) => {
  assert.strictEqual(previousMonthCT(new Date('2026-10-01T04:30:00Z')), '2026-08');  // still 09.30 11:30pm in Nashville
  assert.strictEqual(previousMonthCT(new Date('2026-10-01T05:30:00Z')), '2026-09');  // 10.01 12:30am CDT
  assert.strictEqual(previousMonthCT(new Date('2027-01-15T12:00:00Z')), '2026-12');
  const s = await serve(t, app(fakeHubSpot(DATA).search, OCT));
  const r = await call(s, '/api/funnel/monthly', key);
  assert.strictEqual(JSON.parse(r.body).month, '2026-09');
});

test('a fleet key can GET it; it cannot POST; no key and a bad month are refused; an exec session reads it', async (t) => {
  const s = await serve(t, app(fakeHubSpot(DATA).search, OCT));
  assert.strictEqual((await call(s, '/api/funnel/monthly?month=2026-09', key)).status, 200);
  assert.strictEqual((await call(s, '/api/funnel/monthly', key, 'POST')).status, 403);
  assert.strictEqual((await call(s, '/api/funnel/monthly')).status, 401);
  assert.strictEqual((await call(s, '/api/funnel/monthly?month=2026-13', key)).status, 400);
  assert.strictEqual((await call(s, '/api/funnel/monthly?month=2026-09', execCookie())).status, 200);
  // the allow list grew by one prefix only: spend stays closed to keys
  assert.strictEqual((await call(s, '/api/spend', key)).status, 403);
});

test('cached for an hour; a HubSpot failure is a 502 and is not cached', async (t) => {
  let clock = new Date('2026-10-12T15:00:00Z');
  const hs = fakeHubSpot(DATA);
  let fail = true;
  const search = async (o, b) => { if (fail) throw new Error('HubSpot answered 500'); return hs.search(o, b); };
  const s = await serve(t, app(search, () => clock));
  assert.strictEqual((await call(s, '/api/funnel/monthly?month=2026-09', key)).status, 502);
  fail = false;
  const a = await call(s, '/api/funnel/monthly?month=2026-09', key);
  assert.strictEqual(a.headers['x-cache'], 'MISS');
  const before = hs.calls.length;
  clock = new Date(clock.getTime() + 59 * 60 * 1000);
  assert.strictEqual((await call(s, '/api/funnel/monthly?month=2026-09', key)).headers['x-cache'], 'HIT');
  assert.strictEqual(hs.calls.length, before);
  clock = new Date(clock.getTime() + 2 * 60 * 1000);
  assert.strictEqual((await call(s, '/api/funnel/monthly?month=2026-09', key)).headers['x-cache'], 'MISS');
});

test('pages through results over 200 with the cursor, as the page does', async (t) => {
  const many = { contacts: Array.from({ length: 450 }, (_, i) => C('SWF', 'Google', `2026-09-0${1 + (i % 9)}T10:00:00.000Z`)), deals: [] };
  const s = await serve(t, app(fakeHubSpot(many).search, OCT));
  const j = JSON.parse((await call(s, '/api/funnel/monthly?month=2026-09', key)).body);
  assert.strictEqual(j.leads.total, 450);
  assert.strictEqual(j.leads.by_venue.SWF, 450);
});
