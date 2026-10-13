'use strict';
// Open Date Filler: open Fri/Sat/Sun dates at the 7 venues, for marketing and
// the sales boards. Rulings 10.12.2026: 7 venues only (no OS); open = nothing
// booked; at TBB any booked space takes the date.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('fs');
const path = require('path');

const OD = require('../lib/open-dates');
const { createOpenDatesRouter } = require('../routes/open-dates');

const NOW = new Date('2026-10-13T15:00:00Z'); // Tue 10.13.2026 in Nashville
const deal = (venue, day, extra = {}) => ({ properties: { venue, dealname: `${day} ${venue} Test`, contract_signed_date: '2026-09-01', actual_event_date: day, ...extra } });

test('prime days are Fri/Sat/Sun from today, Nashville date', () => {
  const { days } = OD.primeDays(OD.todayCT(NOW), 1);
  assert.strictEqual(days[0], '2026-10-16'); // Fri
  assert.ok(days.every((d) => [5, 6, 0].includes(new Date(d + 'T00:00:00Z').getUTCDay())));
});

test('booked: signed contract only, cancelled (also via the paired name) never, OS/MOBILE ignored, multi-venue split', () => {
  const m = OD.bookedDays([
    deal('TBB', '2026-10-17'),
    deal('TBT', '2026-10-17', { contract_signed_date: null }),
    deal('ECD', '2026-10-17', { dealname: 'X Wedding' }),
    deal('ECD', '2026-10-17', { dealname: 'X Wedding (Sales Deal)', booked_cancelled__reporting_use_only_: 'Cancelled' }),
    deal('OS', '2026-10-17'),
    deal('COR;STE', '2026-10-18'),
  ]);
  assert.deepStrictEqual([...m.get('2026-10-17')], ['TBB']);
  assert.deepStrictEqual([...m.get('2026-10-18')].sort(), ['COR', 'STE']);
});

test('compute: 7 venues, open lists exclude booked days, Saturday counts and next open Saturday', async () => {
  const calls = [];
  const search = async (type, body) => { calls.push(body); return { results: [deal('TBB', '2026-10-17'), deal('TBB', '2026-10-24'), deal('SWF', '2026-10-16')] }; };
  const out = await OD.computeOpenDates({ search, months: 1, now: NOW });
  assert.deepStrictEqual(out.venues.map((v) => v.code), ['TBB', 'TBT', 'ECD', 'SWF', 'COR', 'EST', 'STE']);
  const tbb = out.venues[0];
  assert.ok(!tbb.open.some((d) => d.date === '2026-10-17'));
  assert.strictEqual(tbb.next_open_saturday, '10.31.2026');
  assert.strictEqual(out.venues.find((v) => v.code === 'TBT').next_open_saturday, '10.17.2026');
  assert.strictEqual(out.venues.find((v) => v.code === 'SWF').open[0].label, 'Sat 10.17.2026');
  assert.ok(out.venues.every((v) => v.open_count <= v.prime_days));
  assert.ok(calls[0].properties.every((p) => !/total|amount/.test(p)), 'never reads money');
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /Test/, 'no deal names in the answer');
});

test('route: cached, months clamped, HubSpot failure is a 502 sentence', async (t) => {
  let n = 0;
  const a = express();
  a.use(createOpenDatesRouter({ search: async () => { n++; return { results: [] }; }, now: () => NOW }));
  const bad = express();
  bad.use(createOpenDatesRouter({ search: async () => { throw new Error('HubSpot answered 500'); }, now: () => NOW }));
  const serve = (app) => new Promise((r) => { const s = http.createServer(app).listen(0, () => { t.after(() => new Promise((x) => s.close(x))); r(s); }); });
  const get = (s, p) => new Promise((res) => http.get({ host: '127.0.0.1', port: s.address().port, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, json: JSON.parse(b), cache: r.headers['x-cache'] })); }));
  const s = await serve(a);
  const one = await get(s, '/api/open-dates?months=99');
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.json.months, 18);
  assert.strictEqual((await get(s, '/api/open-dates?months=99')).cache, 'HIT');
  assert.strictEqual(n, 1);
  const b = await serve(bad);
  const e = await get(b, '/api/open-dates');
  assert.strictEqual(e.status, 502);
  assert.match(e.json.error, /HubSpot read failed/);
});

test('fleet keys may read open dates (sales boards), GET only, nothing else new', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'page-gate.js'), 'utf8');
  assert.match(src, /FLEET_READ_PREFIXES = \['\/api\/ga4\/', '\/api\/funnel\/', '\/api\/open-dates'\]/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="open-dates-body"/);
  assert.match(html, /fetch\('\/api\/open-dates\?months=6'/);
});
