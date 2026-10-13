// Open Date Filler: which Friday, Saturday and Sunday dates are still open at
// each of our 7 venues, so Katherine can push them and sales can pitch them.
//
// Mimi's rulings 10.12.2026:
//   - the 7 venues only: TBB, TBT, ECD, SWF, COR, EST, STE. OS (off site) and
//     MOBILE are not venues for this;
//   - "open" means nothing booked. At The Bridge Building a date is open only
//     when no space there is booked (a booking anywhere at TBB takes the date).
//
// "Booked" = a deal at that venue with a contract_signed_date and an
// actual_event_date on the day, in any pipeline, and not Cancelled
// (booked_cancelled__reporting_use_only_ on the deal or on a same-name deal,
// the dashboard funnel's own rule, lib/funnel-defs.js). Test deals are
// excluded by the caller's search. Counts and dates only: no names, no money.
'use strict';

const { fetchAll, normalizeDealName, toEpochMs } = require('./funnel-defs');

const VENUES = ['TBB', 'TBT', 'ECD', 'SWF', 'COR', 'EST', 'STE'];
const NAMES = { TBB: 'The Bridge Building', TBT: 'The Bell Tower', ECD: 'The Estate at Cherokee Dock', SWF: 'Saddle Woods Farm',
  COR: 'The Cordelle', EST: 'Estelle', STE: 'Saint Elle' };
const PRIME = [5, 6, 0]; // Friday, Saturday, Sunday
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_MONTHS = 18;

const ymd = (d) => d.toISOString().slice(0, 10);
const mmddyyyy = (s) => `${s.slice(5, 7)}.${s.slice(8, 10)}.${s.slice(0, 4)}`;

// Nashville "today" as a UTC-midnight date.
function todayCT(now = new Date()) {
  return new Date(now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) + 'T00:00:00Z');
}

function primeDays(from, months) {
  const end = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, from.getUTCDate()));
  const out = [];
  for (let d = new Date(from); d < end; d = new Date(d.getTime() + 86400000)) if (PRIME.includes(d.getUTCDay())) out.push(ymd(d));
  return { days: out, end: ymd(end) };
}

// deals -> Map("YYYY-MM-DD" -> Set(venue)) of booked venue-days.
function bookedDays(deals) {
  const cancelled = new Set(deals.filter((d) => /^cancel/i.test(String(d.properties?.booked_cancelled__reporting_use_only_ || '').trim()))
    .map((d) => normalizeDealName(d.properties?.dealname)));
  const map = new Map();
  for (const d of deals) {
    const p = d.properties || {};
    if (!p.contract_signed_date || !p.actual_event_date) continue;
    if (cancelled.has(normalizeDealName(p.dealname))) continue;
    const day = String(p.actual_event_date).slice(0, 10);
    for (const v of String(p.venue || '').split(';').map((x) => x.trim().toUpperCase())) {
      if (!VENUES.includes(v)) continue;
      if (!map.has(day)) map.set(day, new Set());
      map.get(day).add(v);
    }
  }
  return map;
}

async function computeOpenDates({ search, months = 6, now = new Date() }) {
  const m = Math.max(1, Math.min(MAX_MONTHS, Number(months) || 6));
  const from = todayCT(now);
  const { days, end } = primeDays(from, m);
  const deals = await fetchAll(search, 'deals', [{ filters: [
    { propertyName: 'actual_event_date', operator: 'GTE', value: toEpochMs(ymd(from)) },
    { propertyName: 'actual_event_date', operator: 'LT', value: toEpochMs(end) },
    { propertyName: 'venue', operator: 'HAS_PROPERTY' },
  ] }], ['venue', 'dealname', 'contract_signed_date', 'actual_event_date', 'booked_cancelled__reporting_use_only_']);
  const booked = bookedDays(deals);
  const venues = VENUES.map((code) => {
    const open = days.filter((d) => !(booked.get(d) || new Set()).has(code));
    const sat = open.filter((d) => new Date(d + 'T00:00:00Z').getUTCDay() === 6);
    return {
      code, name: NAMES[code],
      open: open.map((d) => ({ date: d, label: `${DOW[new Date(d + 'T00:00:00Z').getUTCDay()]} ${mmddyyyy(d)}` })),
      open_count: open.length, open_saturdays: sat.length, prime_days: days.length,
      next_open_saturday: sat[0] ? mmddyyyy(sat[0]) : null,
    };
  });
  return { from: ymd(from), to: end, months: m, prime_days: days.length, venues,
    rule: 'Open = no deal at that venue with a signed contract on that day (not cancelled). Fridays, Saturdays and Sundays. At The Bridge Building any booked space takes the date.' };
}

module.exports = { computeOpenDates, bookedDays, primeDays, todayCT, VENUES, NAMES, MAX_MONTHS };
