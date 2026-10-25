'use strict';
// ORDER #2335: the home "2026 Monthly Trend" chart made 40+ HubSpot searches
// from the browser on every load (10 months x lead count, 2 booking pipelines,
// revenue), one month after another through the proxy's one-at-a-time queue,
// holding up every other tile. Now the server sums it once, caches it 15
// minutes, and the page reads one answer.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('fs');
const path = require('path');

const TR = require('../lib/trend');
const { createTrendRouter } = require('../routes/trend');
const { FLEET_READ_PREFIXES } = require('../middleware/page-gate');

const NOW = new Date('2026-10-24T20:15:00Z'); // Sat 10.24.2026 15:15 CT
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ---- THE OLD METHOD, verbatim from public/index.html on main cfcf3e8 ----
// loadTrend()'s queries and math, with the helpers it called (callHs,
// countContacts, fetchAll, fetchUniqueBookings and theirs). The only changes:
// callHs goes to the fake HubSpot instead of fetch(), `now` is passed in, and
// the series are returned instead of drawn. It is the oracle the server sum
// must match, month for month.
function oldPage(callHs, now) {
  const IHG_VENUES = ['TBB', 'TBT', 'ECD', 'SWF', 'OS'];
  const SALES_PIPELINE = '746391920';
  const EVENT_PIPELINE_DEFAULT = 'default';
  const BOOKED_DATE_FIELD = 'contract_signed_date';
  const REVENUE_NET_MULTIPLIER = 0.95;
  function monthRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));
    return { start: start.toISOString(), end: end.toISOString(), label: start.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) };
  }
  function toEpochMs(d) { const x = new Date(d); return String(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())); }
  function normalizeDealName(name) {
    return (name || '')
      .replace(/\(Sales Deal\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
  async function countContacts(filters) { return (await callHs({ objectType: 'contacts', filterGroups: [{ filters }], limit: 1 })).total || 0; }
  async function fetchAll(objectType, filterGroups, properties, maxPages = 60) {
    const out = []; let after;
    for (let i = 0; i < maxPages; i++) {
      const body = { objectType, filterGroups, properties, limit: 200 };
      if (after) body.after = after;
      const data = await callHs(body);
      const batch = data.results || []; out.push(...batch);
      after = data.paging && data.paging.next && data.paging.next.after;
      if (!after || batch.length < 200) break;
    }
    return out;
  }
  function isCancelledBooking(d) {
    const v = String(d.properties?.booked_cancelled__reporting_use_only_ || '').trim().toLowerCase();
    return v === 'cancelled' || v === 'canceled' || v === 'true' || v === 'yes';
  }
  function splitCancelled(result, everyDeal) {
    const cancelledKeys = new Set(everyDeal.filter(isCancelledBooking).map(d => normalizeDealName(d.properties?.dealname)));
    const live = result.all.filter(d => !cancelledKeys.has(normalizeDealName(d.properties?.dealname)));
    const cancelled = result.all.filter(d => cancelledKeys.has(normalizeDealName(d.properties?.dealname)));
    return { ...result, all: live, cancelled };
  }
  async function fetchUniqueBookings(period) {
    const filtersFor = (pl) => [
      { propertyName: 'pipeline', operator: 'EQ', value: pl },
      { propertyName: BOOKED_DATE_FIELD, operator: 'GTE', value: toEpochMs(period.start) },
      { propertyName: BOOKED_DATE_FIELD, operator: 'LT', value: toEpochMs(period.end) }
    ];
    const props = ['venue', BOOKED_DATE_FIELD, 'event_type_sales', 'dealname', 'pipeline', 'booked_cancelled__reporting_use_only_'];
    const [salesBookings, eventBookings] = await Promise.all([
      fetchAll('deals', [{ filters: filtersFor(SALES_PIPELINE) }], props),
      fetchAll('deals', [{ filters: filtersFor(EVENT_PIPELINE_DEFAULT) }], props)
    ]);
    const salesKeys = new Set(salesBookings.map(d => normalizeDealName(d.properties?.dealname)));
    const eventOnly = eventBookings.filter(d => !salesKeys.has(normalizeDealName(d.properties?.dealname)));
    salesBookings.forEach(d => d._origin = 'sales');
    eventOnly.forEach(d => d._origin = 'event-only');
    return splitCancelled({ all: [...salesBookings, ...eventOnly], salesCount: salesBookings.length, eventOnlyCount: eventOnly.length }, [...salesBookings, ...eventBookings]);
  }
  return async function loadTrend() {
    const endMonth = now.getUTCFullYear() >= 2026 ? (now.getUTCFullYear() > 2026 ? 12 : now.getUTCMonth() + 1) : 0;
    const months = [];
    for (let i = 0; i < endMonth; i++) months.push(`2026-${String(i + 1).padStart(2, '0')}`);
    const labels = months.map(m => monthRange(m).label);
    const leadCounts = [], bookingCounts = [], cancelledCounts = [], revenues = [];
    for (const ym of months) {
      const { start, end } = monthRange(ym);
      const monthPeriod = { start, end };
      const [l, bookingsResult, revDeals] = await Promise.all([
        countContacts([
          { propertyName: 'venue_s_', operator: 'IN', values: IHG_VENUES },
          { propertyName: 'createdate', operator: 'GTE', value: start },
          { propertyName: 'createdate', operator: 'LT', value: end }
        ]),
        fetchUniqueBookings(monthPeriod),
        fetchAll('deals', [{ filters: [
          { propertyName: 'pipeline', operator: 'IN', values: [SALES_PIPELINE, EVENT_PIPELINE_DEFAULT] },
          { propertyName: 'final_event_total_accounting', operator: 'HAS_PROPERTY' },
          { propertyName: 'actual_event_date', operator: 'GTE', value: toEpochMs(start) },
          { propertyName: 'actual_event_date', operator: 'LT', value: toEpochMs(end) }
        ]}], ['final_event_total_accounting'], 3)
      ]);
      leadCounts.push(l);
      bookingCounts.push(bookingsResult.all.length);
      cancelledCounts.push(bookingsResult.cancelled.length);
      revenues.push(revDeals.reduce((a, d) => a + (parseFloat(d.properties?.final_event_total_accounting || '0') || 0), 0) * REVENUE_NET_MULTIPLIER);
    }
    return { labels, leadCounts, bookingCounts, cancelledCounts, revenues };
  };
}

// ---- A fake HubSpot search that applies the filters and cursor-pages ----
const asMs = (v) => (/^\d+$/.test(String(v)) ? Number(v) : Date.parse(v));
function matches(rec, f) {
  const v = rec.properties[f.propertyName];
  switch (f.operator) {
    case 'HAS_PROPERTY': return v != null && v !== '';
    case 'EQ': return v === f.value;
    case 'IN': return v != null && String(v).split(';').some((x) => f.values.includes(x.trim()));
    case 'GTE': return v != null && v !== '' && asMs(v) >= asMs(f.value);
    case 'LT': return v != null && v !== '' && asMs(v) < asMs(f.value);
    default: throw new Error('fake HubSpot: no operator ' + f.operator);
  }
}
function fakeHubSpot(db, calls = []) {
  return async (type, body) => {
    calls.push({ type, body });
    const hits = db[type].filter((r) => body.filterGroups.some((g) => g.filters.every((f) => matches(r, f))));
    const start = body.after ? Number(body.after) : 0;
    const results = hits.slice(start, start + body.limit).map((r) => ({ id: r.id, properties: { ...r.properties } }));
    const paging = start + body.limit < hits.length ? { next: { after: String(start + body.limit) } } : undefined;
    return { total: hits.length, results, paging };
  };
}

// Contacts and deals across 2026 with month edges (UTC midnight, and late
// evening CT that is already the next month in UTC), multi-venue and non-IHG
// leads, Sales/Event twins, cancellations, date-only and datetime event dates,
// blank and junk amounts, and one month big enough to page (and to hit the
// revenue read's 3-page cap).
function fakeDb() {
  const contacts = [], deals = [];
  const venues = ['TBB', 'TBT', 'ECD', 'SWF', 'OS', 'TBB;ECD', 'ZZZ', ''];
  for (let i = 0; i < 900; i++) {
    const m = (i % 12) + 1, d = (i % 28) + 1;
    contacts.push({ id: 'c' + i, properties: { venue_s_: venues[i % venues.length], createdate: `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:30:00.000Z` } });
  }
  // Month edges: 23:59:59.999Z on the last day, 00:00Z on the first, and 03:00Z on the first (still the previous month in CT).
  contacts.push({ id: 'edge1', properties: { venue_s_: 'TBB', createdate: '2026-03-31T23:59:59.999Z' } });
  contacts.push({ id: 'edge2', properties: { venue_s_: 'TBT', createdate: '2026-04-01T00:00:00.000Z' } });
  contacts.push({ id: 'edge3', properties: { venue_s_: 'SWF', createdate: '2026-05-01T03:00:00.000Z' } });
  const flags = ['Booked', 'Cancelled', '', 'canceled', 'Booked', 'yes'];
  for (let i = 0; i < 700; i++) {
    const m = i < 260 ? 6 : (i % 12) + 1, d = (i % 28) + 1;
    const date = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const signed = i % 4 === 0 ? `${date}T00:00:00Z` : date;
    const name = `Couple ${i % 300}` + (i % 2 ? ' (Sales Deal)' : '');
    deals.push({ id: 'b' + i, properties: { pipeline: i % 3 ? '746391920' : 'default', contract_signed_date: signed, dealname: name, venue: venues[i % 5], booked_cancelled__reporting_use_only_: flags[i % flags.length] } });
  }
  deals.push({ id: 'bedge', properties: { pipeline: '746391920', contract_signed_date: '2026-08-01', dealname: 'Edge Couple', venue: 'ECD' } });
  for (let i = 0; i < 1000; i++) {
    const m = i < 650 ? 3 : (i % 12) + 1, d = (i % 28) + 1;
    const date = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const actual = i % 3 === 0 ? `${date}T00:00:00Z` : date;
    const amount = i % 17 === 0 ? '' : i % 23 === 0 ? 'n/a' : i % 29 === 0 ? '12abc' : String(1000 + i * 37.5);
    deals.push({ id: 'r' + i, properties: { pipeline: i % 2 ? '746391920' : 'default', actual_event_date: actual, final_event_total_accounting: amount } });
  }
  deals.push({ id: 'redge', properties: { pipeline: 'default', actual_event_date: '2026-09-30', final_event_total_accounting: '4321.5' } });
  deals.push({ id: 'rother', properties: { pipeline: '999', actual_event_date: '2026-09-10', final_event_total_accounting: '9999' } });
  return { contacts, deals };
}
// The page's callHs sends objectType in the body; the proxy strips it.
const asCallHs = (search) => ({ objectType, ...body }) => search(objectType, body);

test('months: the page\'s own window, before, during and after 2026', () => {
  for (const d of ['2025-12-31T23:00:00Z', '2026-01-01T00:00:00Z', '2026-10-24T20:15:00Z', '2026-12-31T23:59:00Z', '2027-02-01T00:00:00Z']) {
    const now = new Date(d);
    const endMonth = now.getUTCFullYear() >= 2026 ? (now.getUTCFullYear() > 2026 ? 12 : now.getUTCMonth() + 1) : 0;
    assert.strictEqual(TR.trendMonths(now).length, endMonth, d);
  }
  assert.deepStrictEqual(TR.trendMonths(NOW).slice(0, 2), ['2026-01', '2026-02']);
});

test('the server sum matches the old page method, month for month, every series', async () => {
  const db = fakeDb();
  const oldCalls = [], newCalls = [];
  const old = await oldPage(asCallHs(fakeHubSpot(db, oldCalls)), NOW)();
  const out = await TR.computeTrend({ search: fakeHubSpot(db, newCalls), now: NOW });
  assert.deepStrictEqual(out.labels, old.labels);
  assert.deepStrictEqual(out.leads, old.leadCounts);
  assert.deepStrictEqual(out.bookings, old.bookingCounts);
  assert.deepStrictEqual(out.cancelled, old.cancelledCounts);
  assert.deepStrictEqual(out.revenue, old.revenues);
  assert.strictEqual(out.labels.length, 10);
  assert.ok(out.leads.every((n) => n > 0) && out.bookings.some((n) => n > 0) && out.cancelled.some((n) => n > 0) && out.revenue.some((n) => n > 0), 'the fixture exercises every series');
  // Same HubSpot searches, the same bodies, the same count.
  const norm = (c) => JSON.stringify([c.type, c.body]);
  assert.deepStrictEqual(newCalls.map(norm).sort(), oldCalls.map(norm).sort());
  assert.strictEqual(out.hubspot_calls, newCalls.length);
  assert.ok(newCalls.length >= 40, `at least 4 searches a month, was ${newCalls.length}`);
  // The revenue read keeps the page's 3-page cap (March has 650 finalized deals).
  assert.strictEqual(newCalls.filter((c) => c.body.properties && c.body.properties[0] === 'final_event_total_accounting' && c.body.properties.length === 1 && c.body.filterGroups[0].filters[2].value === String(Date.UTC(2026, 2, 1))).length, 3);
  assert.strictEqual(out.as_of, NOW.toISOString());
  assert.strictEqual(out.as_of_ct, '15:15 CT');
  assert.strictEqual(out.view, '2026-ytd');
});

test('cache: keyed by view, 15 minutes, one HubSpot read for callers at once, refresh on demand', async () => {
  let n = 0, t = NOW.getTime();
  const search = async () => { n++; await new Promise((r) => setTimeout(r, 5)); return { total: 0, results: [] }; };
  const cache = TR.createTrendCache({ search, now: () => new Date(t) });
  const [a, b] = await Promise.all([cache.get(), cache.get({ view: '2026-ytd' })]);
  const perRead = n;
  assert.strictEqual(perRead, 40, 'one read is 4 searches x 10 months');
  assert.strictEqual(a.cache, 'MISS'); assert.strictEqual(b.cache, 'MISS');
  assert.strictEqual((await cache.get()).cache, 'HIT');
  t += TR.CACHE_MS - 1000;
  assert.strictEqual((await cache.get()).cache, 'HIT');
  assert.strictEqual(n, perRead);
  t += 2000;
  assert.strictEqual((await cache.get()).cache, 'MISS', 'expired after 15 minutes');
  assert.strictEqual(n, 2 * perRead);
  assert.strictEqual((await cache.get({ refresh: true })).cache, 'MISS');
  assert.strictEqual(n, 3 * perRead, 'refresh reads HubSpot now');
  await assert.rejects(cache.get({ view: '2025-ytd' }), /unknown trend view/);
  assert.strictEqual(TR.CACHE_MS, 15 * 60 * 1000);
  assert.deepStrictEqual(TR.VIEWS, ['2026-ytd']);
});

test('route: warm cache answers under 2 seconds with 400 ms pages, ?refresh=1 rereads, failure is a 502 sentence', async (t) => {
  const db = fakeDb();
  const calls = [];
  const fake = fakeHubSpot(db, calls);
  const search = async (type, body) => { await new Promise((r) => setTimeout(r, 400)); return fake(type, body); };
  const cache = TR.createTrendCache({ search, now: () => NOW });
  const a = express(); a.use(createTrendRouter({ cache }));
  const bad = express(); bad.use(createTrendRouter({ cache: TR.createTrendCache({ search: async () => { throw new Error('HubSpot answered 500'); }, now: () => NOW }) }));
  const serve = (app) => new Promise((r) => { const s = http.createServer(app).listen(0, () => { t.after(() => new Promise((x) => s.close(x))); r(s); }); });
  const get = (s, p) => new Promise((res) => http.get({ host: '127.0.0.1', port: s.address().port, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, json: JSON.parse(b), cache: r.headers['x-cache'] })); }));
  const s = await serve(a);
  await cache.warm(); // what the server does at boot and every 15 minutes
  const readCalls = calls.length;
  const t0 = Date.now();
  const warm = await get(s, '/api/trend');
  const ms = Date.now() - t0;
  assert.strictEqual(warm.status, 200);
  assert.strictEqual(warm.cache, 'HIT');
  assert.ok(ms < 2000, `warm answer took ${ms} ms`);
  const old = await oldPage(asCallHs(fakeHubSpot(db)), NOW)();
  assert.deepStrictEqual(warm.json.leads, old.leadCounts);
  assert.deepStrictEqual(warm.json.revenue, old.revenues);
  assert.match(warm.json.as_of_ct, /^\d\d:\d\d CT$/);
  assert.strictEqual(calls.length, readCalls, 'a warm answer reads nothing');
  assert.strictEqual((await get(s, '/api/trend?view=2026-ytd')).cache, 'HIT');
  assert.strictEqual((await get(s, '/api/trend?view=1999')).status, 400);
  const e = await get(await serve(bad), '/api/trend');
  assert.strictEqual(e.status, 502);
  assert.match(e.json.error, /HubSpot read failed/);
  const re = await get(s, '/api/trend?refresh=1');
  assert.strictEqual(re.cache, 'MISS');
  assert.strictEqual(calls.length, 2 * readCalls);
});

test('page: the chart makes one call to /api/trend, never pages HubSpot, loading state and "?" on failure, look unchanged', () => {
  const fn = HTML.slice(HTML.indexOf('async function loadTrend'), HTML.indexOf('async function generateNarrative'));
  assert.strictEqual((fn.match(/fetch\(/g) || []).length, 1);
  assert.match(fn, /fetch\('\/api\/trend'\)/);
  assert.doesNotMatch(fn, /fetchAll\(|callHs\(|countContacts\(|fetchUniqueBookings\(|\/api\/hubspot\/search/);
  assert.match(fn, /trend-status/);
  assert.match(fn, /'\?'/);
  assert.match(HTML, /<div class="status" id="trend-status">Loading&hellip;<\/div>\s*<div class="chart-wrap"><canvas id="trend-chart"><\/canvas><\/div>/);
  // The chart itself is drawn exactly as before.
  for (const ds of [
    "{ type: 'bar', label: 'Leads', data: leadCounts, backgroundColor: C.leads, borderRadius: 4, maxBarThickness: 36, yAxisID: 'y' }",
    "{ type: 'line', label: 'Bookings', data: bookingCounts, borderColor: C.bookings, backgroundColor: C.bookings, yAxisID: 'y2', tension: 0.2, pointRadius: 4 }",
    "{ type: 'line', label: 'Cancelled', data: cancelledCounts, borderColor: C.cancelled, backgroundColor: C.cancelled, yAxisID: 'y2', tension: 0.2, pointRadius: 3 }",
    "{ type: 'line', label: 'Revenue ($)', data: revenues, borderColor: C.revenue, backgroundColor: C.revenue, yAxisID: 'y3', tension: 0.2, pointRadius: 4, borderDash: [5, 3] }",
  ]) assert.ok(fn.includes(ds), ds);
  assert.strictEqual((HTML.match(/loadTrend\(\)\.catch/g) || []).length, 1, 'asked once at boot');
  assert.ok(HTML.indexOf('loadTrend().catch') <HTML.indexOf("await loadPeriod(resolvePeriod('ytd'))"), 'asked before the period load, not behind it');
});

test('a revenue series: not readable by a fleet key', () => {
  assert.ok(!FLEET_READ_PREFIXES.some((p) => '/api/trend'.startsWith(p)));
});

test('server.js mounts the route, warms it at boot and every 15 minutes, through the test-deal filter and the queue', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.slice(src.indexOf('ORDER #2335'), src.indexOf('// ---- AI Narrative Proxy'));
  assert.match(block, /createTrendRouter\(\{ cache \}\)/);
  assert.match(block, /excludeTestDeals\(objectType, body\)/);
  assert.match(block, /enqueueHubSpot\(/);
  assert.match(block, /setInterval\(cache\.warm, CACHE_MS\)/);
  assert.ok(src.indexOf('ORDER #2335') > src.indexOf('app.use(pageGate)'), 'below the sign-in gate');
});
