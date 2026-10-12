'use strict';
// ORDER #1663: lib/funnel-defs.js is a PORT of the dashboard page's funnel
// logic (public/index.html is one inline script on a live page, so it was not
// rewired to load the lib). This test is what keeps the two from drifting: it
// pulls the constants, filter builders, dedupe and counting code out of
// index.html, runs them in a sandbox, and requires the lib to give the same
// filters and the same counts. Change one without the other and this fails.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../lib/funnel-defs');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const squash = (s) => s.replace(/\s+/g, ' ').trim();

function constant(name) {
  const m = PAGE.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(m, `index.html no longer defines ${name}`);
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${m[1]})`))); // out of the sandbox realm
}
function fnSource(name) {
  const start = PAGE.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `index.html no longer defines function ${name}`);
  let depth = 0; let i = PAGE.indexOf('{', start);
  for (; i < PAGE.length; i++) { if (PAGE[i] === '{') depth++; else if (PAGE[i] === '}' && --depth === 0) break; }
  return PAGE.slice(start, i + 1);
}
// A sandbox holding the page's own constants and helpers.
function pageSandbox(extra = {}) {
  const ctx = vm.createContext({ ...extra });
  for (const c of ['IHG_VENUES', 'SALES_PIPELINE', 'EVENT_PIPELINE_DEFAULT', 'BOOKED_DATE_FIELD', 'TOUR_DATE_FIELD']) ctx[c] = constant(c);
  for (const f of ['monthRange', 'toEpochMs', 'normalizeDealName', 'groupByVenue', 'isCancelledBooking', 'splitCancelled', 'fetchUniqueTours', 'fetchUniqueBookings']) vm.runInContext(fnSource(f), ctx);
  return ctx;
}

const SEP = F.monthRange('2026-09');
const deal = (pipeline, dealname, venue, status) => ({ properties: { pipeline, dealname, venue, ...(status ? { booked_cancelled__reporting_use_only_: status } : {}) } });
const SALES = [deal(F.SALES_PIPELINE, 'Smith Wedding (Sales Deal)', 'TBB', 'Booked'), deal(F.SALES_PIPELINE, 'Lee  Gala', 'SWF;TBT'),
  deal(F.SALES_PIPELINE, 'Ray Party (Sales Deal)', 'TBT')];
const EVENT = [deal('default', 'smith wedding', 'TBB', 'Booked'), deal('default', 'Jones Party', 'ECD', 'Cancelled'), deal('default', 'lee gala', 'SWF'),
  deal('default', 'ray party', 'TBT', 'Cancelled')];   // cancelled only on the Event Planning twin

test('constants match the page', () => {
  for (const c of ['IHG_VENUES', 'SALES_PIPELINE', 'EVENT_PIPELINE_DEFAULT', 'BOOKED_DATE_FIELD', 'TOUR_DATE_FIELD']) {
    assert.deepStrictEqual(F[c], constant(c), c);
  }
});

test('helper functions are the page\'s, character for character (whitespace aside)', () => {
  for (const f of ['monthRange', 'toEpochMs', 'normalizeDealName', 'groupByVenue', 'isCancelledBooking', 'splitCancelled']) {
    assert.strictEqual(squash(F[f].toString()), squash(fnSource(f)), f);
  }
});

for (const [kind, pageFn, libFilters, libProps, libDedupe] of [
  ['tours', 'fetchUniqueTours', F.tourFilters, F.TOUR_PROPS, F.dedupe],
  ['bookings', 'fetchUniqueBookings', F.bookingFilters, F.BOOKING_PROPS, F.dedupeBookings],
]) {
  test(`${kind}: the page and the lib send the same searches and get the same deduped count`, async () => {
    const seen = [];
    const ctx = pageSandbox({ fetchAll: async (objectType, groups, props) => {
      seen.push({ objectType, groups, props });
      return JSON.parse(JSON.stringify(groups[0].filters[0].value === F.SALES_PIPELINE ? SALES : EVENT));
    } });
    const page = await vm.runInContext(`${pageFn}(${JSON.stringify(SEP)})`, ctx);
    assert.strictEqual(seen.length, 2);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(seen.map((s) => s.groups))), [[{ filters: libFilters(SEP, F.SALES_PIPELINE) }], [{ filters: libFilters(SEP, F.EVENT_PIPELINE_DEFAULT) }]]);
    for (const s of seen) { assert.strictEqual(s.objectType, 'deals'); assert.deepStrictEqual([...s.props], libProps); }
    const lib = libDedupe(SALES, EVENT);
    assert.strictEqual(lib.all.length, page.all.length);
    assert.strictEqual(lib.eventOnlyCount, page.eventOnlyCount);
    assert.deepStrictEqual(F.groupByVenue(lib.all, 'venue'), { ...vm.runInContext('groupByVenue', ctx)(page.all, 'venue') });
    if (kind === 'bookings') {
      assert.deepStrictEqual([lib.all.length, lib.cancelled.length], [2, 2]);        // Smith + Lee live; Jones + Ray cancelled
      assert.strictEqual(page.cancelled.length, 2);
      assert.deepStrictEqual(F.groupByVenue(lib.cancelled, 'venue'), { ...vm.runInContext('groupByVenue', ctx)(page.cancelled, 'venue') });
    } else {
      assert.strictEqual(page.cancelled, undefined, 'tours are never split');
    }
  });
}

test('leads: the page and the lib send the same contacts search', async () => {
  const lp = PAGE.match(/const leadsP = (fetchAll\('contacts',[\s\S]*?\]\);)/);
  const ft = PAGE.match(/const filtersTime = (p => \[[\s\S]*?\]);/);
  assert.ok(lp && ft, 'index.html leads query moved');
  let seen;
  const ctx = pageSandbox({ period: SEP, fetchAll: (o, groups, props) => { seen = { o, groups, props }; } });
  vm.runInContext(`const filtersTime = ${ft[1]}; ${lp[1]}`, ctx);
  assert.strictEqual(seen.o, 'contacts');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(seen.groups)), F.leadFilterGroups(SEP));
  assert.deepStrictEqual([...seen.props], F.LEAD_PROPS);
});

test('leads by venue and by source count the way the page does', () => {
  const leads = [
    { properties: { venue_s_: 'TBB;TBT', lead_source: 'The Knot' } }, { properties: { venue_s_: 'SWF', lead_source: 'Google' } },
    { properties: { venue_s_: '', lead_source: '' } }, { properties: { venue_s_: 'ECD', lead_source: 'Google' } },
  ];
  const block = PAGE.match(/(const venuesXT = [\s\S]*?const srcRows = [^;]+;)/);
  assert.ok(block, 'index.html source cross-tab moved');
  const ctx = vm.createContext({ leads });
  vm.runInContext(block[1] + '; this.out = Object.fromEntries(srcRows);', ctx);
  assert.deepStrictEqual(F.leadsBySource(leads), JSON.parse(JSON.stringify(ctx.out)));
  assert.ok(PAGE.includes("const leadsByV = groupByVenue(leads, 'venue_s_');"));
  assert.ok(PAGE.includes("const toursByV = groupByVenue(tours, 'venue');"));
  assert.ok(PAGE.includes("const bookingsByV = groupByVenue(bookings, 'venue');"));
});

test('paging: the page pages 200 at a time for up to 60 pages, as the lib does', () => {
  const pageFetchAll = squash(fnSource('fetchAll'));
  assert.ok(pageFetchAll.includes('maxPages = 60') && pageFetchAll.includes('limit: 200') && pageFetchAll.includes('batch.length < 200'));
  const lib = squash(F.fetchAll.toString());
  assert.ok(lib.includes('maxPages = 60') && lib.includes('limit: 200') && lib.includes('batch.length < 200'));
});

test('cancelled: same values count as cancelled on the page and in the lib; Booked and blank do not', () => {
  const ctx = pageSandbox();
  const pageIs = vm.runInContext('isCancelledBooking', ctx);
  for (const v of ['Cancelled', 'cancelled', ' CANCELLED ', 'Canceled', 'true', 'Yes', 'Booked', '', null, undefined, 'No']) {
    const d = { properties: { booked_cancelled__reporting_use_only_: v } };
    assert.strictEqual(F.isCancelledBooking(d), pageIs(d), String(v));
  }
  assert.strictEqual(F.isCancelledBooking({ properties: { booked_cancelled__reporting_use_only_: 'Booked' } }), false);
  assert.strictEqual(F.isCancelledBooking({ properties: { booked_cancelled__reporting_use_only_: 'Cancelled' } }), true);
  assert.ok(PAGE.includes("const cancelledByV = groupByVenue(cancelled, 'venue');"), 'page counts cancelled per venue');
  assert.ok(PAGE.includes('Bookings exclude cancellations, which are counted separately'), 'the help line is on the page');
});
