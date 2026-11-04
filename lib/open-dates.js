// Open Date Filler: which Friday, Saturday and Sunday dates are still open at
// each of our 7 venues, so Katherine can push them and sales can pitch them.
//
// Mimi's rulings 10.12.2026:
//   - the 7 venues only: TBB, TBT, ECD, SWF, COR, EST, STE. OS (off site) and
//     MOBILE are not venues for this;
//   - "open" means nothing booked. At The Bridge Building a date is open only
//     when no space there is booked (a booking anywhere at TBB takes the date).
//
// "Booked" = a deal at that venue with an actual_event_date on the day that
// either has a contract_signed_date (any pipeline) OR sits in an Event
// Planning pipeline (IHG EP "default", Elle EP 916011843), and is not
// Cancelled. ORDER #1681, Mimi 10.13.2026 popup: "EP deal = booked". The
// Elle EP deals imported from HoneyBook carry no contract_signed_date, so
// every Saturday at COR/EST/STE read open (COR Evans 11.07 and COR Thompson
// 12.05 among them).
// Not Cancelled
// (booked_cancelled__reporting_use_only_ on the deal or on a same-name deal,
// the dashboard funnel's own rule, lib/funnel-defs.js). Test deals are
// excluded by the caller's search. Counts and dates only: no names, no money.
'use strict';

const { fetchAll, normalizeDealName, toEpochMs } = require('./funnel-defs');

const VENUES = ['TBB', 'TBT', 'ECD', 'SWF', 'COR', 'EST', 'STE'];
const NAMES = { TBB: 'The Bridge Building', TBT: 'The Bell Tower', ECD: 'The Estate at Cherokee Dock', SWF: 'Saddle Woods Farm',
  COR: 'The Cordelle', EST: 'Estelle', STE: 'Saint Elle' };
const PRIME = [5, 6, 0]; // Friday, Saturday, Sunday
const EP_PIPELINES = ['default', '916011843']; // IHG EP, Elle EP (ORDER #1681)
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_MONTHS = 18;

const ymd = (d) => d.toISOString().slice(0, 10);
const mmddyyyy = (s) => `${s.slice(5, 7)}.${s.slice(8, 10)}.${s.slice(0, 4)}`;

// Nashville "today" as a UTC-midnight date.
function todayCT(now = new Date()) {
  return new Date(now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) + 'T00:00:00Z');
}

// #2904 (Mimi 11.03.2026, ruling 3): the agents may offer ANY open date, not
// only weekends. `all` = every day of the week; the default stays Fri/Sat/Sun
// so the home band and the sales boards read exactly as before.
function primeDays(from, months, { all = false } = {}) {
  const end = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, from.getUTCDate()));
  const out = [];
  for (let d = new Date(from); d < end; d = new Date(d.getTime() + 86400000)) if (all || PRIME.includes(d.getUTCDay())) out.push(ymd(d));
  return { days: out, end: ymd(end) };
}

// deals -> Map("YYYY-MM-DD" -> Set(venue)) of booked venue-days.
function bookedDays(deals) {
  const cancelled = new Set(deals.filter((d) => /^cancel/i.test(String(d.properties?.booked_cancelled__reporting_use_only_ || '').trim()))
    .map((d) => normalizeDealName(d.properties?.dealname)));
  const map = new Map();
  for (const d of deals) {
    const p = d.properties || {};
    if (!p.actual_event_date) continue;
    if (!p.contract_signed_date && !EP_PIPELINES.includes(String(p.pipeline || ''))) continue;
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

async function computeOpenDates({ search, months = 6, now = new Date(), days: which = 'prime' }) {
  const m = Math.max(1, Math.min(MAX_MONTHS, Number(months) || 6));
  const all = which === 'all';
  const from = todayCT(now);
  const { days, end } = primeDays(from, m, { all });
  const deals = await fetchAll(search, 'deals', [{ filters: [
    { propertyName: 'actual_event_date', operator: 'GTE', value: toEpochMs(ymd(from)) },
    { propertyName: 'actual_event_date', operator: 'LT', value: toEpochMs(end) },
    { propertyName: 'venue', operator: 'HAS_PROPERTY' },
  ] }], ['venue', 'dealname', 'pipeline', 'contract_signed_date', 'actual_event_date', 'booked_cancelled__reporting_use_only_']);
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
  return { from: ymd(from), to: end, months: m, prime_days: days.length, days: all ? 'all' : 'prime', venues,
    source: 'HubSpot deals (venue, actual_event_date, contract_signed_date, pipeline, booked_cancelled__reporting_use_only_)',
    rule: `Open = no booked deal at that venue on that day (a signed contract, or an Event Planning deal; never a cancelled one). ${all ? 'Every day of the week' : 'Fridays, Saturdays and Sundays'}. At The Bridge Building any booked space takes the date.` };
}

// ---------------------------------------------------------------- #2904
// Open dates on agent cards (Convention Connector pitches, Google Business
// post ideas). The model never types our availability: it names the dates it
// wants to offer in the card's "open_dates" list, and this check keeps only the
// ones the measured source says are open at that venue. The card shows the
// kept dates, written by code, where the model put {{OPEN_DATES}}.

// The measured answer -> Map(venue code -> Set("YYYY-MM-DD") open).
function openIndex(measured) {
  const idx = new Map();
  for (const v of (measured && measured.venues) || []) idx.set(v.code, new Set((v.open || []).map((d) => d.date)));
  return idx;
}

const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function asYmd(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return null;
}

// asked: [{venue, date}] from the model. Returns { kept, dropped }.
function checkOffered(asked, measured) {
  const idx = openIndex(measured);
  const kept = []; const dropped = []; const seen = new Set();
  for (const a of Array.isArray(asked) ? asked : []) {
    const venue = String((a && a.venue) || '').trim().toUpperCase();
    const date = asYmd(a && a.date);
    const label = `${venue || '?'} ${a && a.date}`;
    if (!VENUES.includes(venue)) { dropped.push({ label, why: 'not one of our 7 venues' }); continue; }
    if (!date) { dropped.push({ label, why: 'not a date' }); continue; }
    if (seen.has(venue + date)) continue;
    if (!idx.has(venue) || !idx.get(venue).has(date)) {
      const inWindow = measured && date >= measured.from && date < measured.to;
      dropped.push({ label: `${NAMES[venue]} ${mmddyyyy(date)}`, why: inWindow ? 'booked in HubSpot' : 'outside the dates measured' });
      continue;
    }
    seen.add(venue + date);
    kept.push({ venue, date, line: `${NAMES[venue]}: ${DOW_LONG[new Date(date + 'T00:00:00Z').getUTCDay()]} ${mmddyyyy(date)}` });
  }
  return { kept, dropped };
}

const TOKEN = '{{OPEN_DATES}}';

// Puts the checked dates on the card where the model wrote {{OPEN_DATES}}, and
// adds a short section saying what was checked. A card with no list and no
// token is returned unchanged (a review reply, a convention with no pitch).
function fillOpenDates(body, asked, measured, at) {
  const b = String(body || '');
  const has = b.includes(TOKEN);
  if (!has && !(Array.isArray(asked) && asked.length)) return { body: b, kept: [], dropped: [] };
  const { kept, dropped } = checkOffered(asked, measured);
  const list = kept.length ? kept.map((k) => `- ${k.line}`).join('\n') : '(No open date to offer: ask sales for current availability.)';
  let out = has ? b.split(TOKEN).join(list) : b;
  const note = [`### Open dates checked (${at})`, '',
    `${kept.length} offered, each open at that venue in HubSpot when this ran. Open dates change: sales confirms before anyone holds a date. No prices.`]
    .concat(dropped.length ? ['', 'Taken off the card:', ...dropped.map((d) => `- ${d.label}: ${d.why}`)] : []).join('\n');
  out = out.trim() + '\n\n' + note;
  return { body: out, kept, dropped };
}

// The model's view of the source: compact, exact. Every day in the window is
// open at a venue except the booked days listed for it.
function sourceText(measured) {
  const lines = [
    `Open dates at our 7 venues, ${mmddyyyy(measured.from)} to ${mmddyyyy(measured.to)} (not including the last day), every day of the week.`,
    `Source: ${measured.source || 'HubSpot deals'}. ${measured.rule}`,
    'A date is OPEN at a venue unless it is listed as booked for that venue below. OS (off site) is not a venue.',
    `To offer dates on a card, write ${TOKEN} in the body where the list goes and add "open_dates":[{"venue":"<code>","date":"YYYY-MM-DD"}] to the card (at most 6). Never type an open date yourself, never a price. The Box checks each date and drops any that is booked.`,
    '',
  ];
  for (const v of measured.venues) {
    const open = new Set(v.open.map((d) => d.date));
    const { days } = primeDays(new Date(measured.from + 'T00:00:00Z'), measured.months, { all: measured.days === 'all' });
    const booked = days.filter((d) => !open.has(d)).map(mmddyyyy);
    lines.push(`${v.code} (${v.name}): ${v.open_count} open of ${days.length}. Booked: ${booked.length ? booked.join(', ') : 'none'}.`);
  }
  return lines.join('\n');
}

module.exports = { computeOpenDates, bookedDays, primeDays, todayCT, VENUES, NAMES, MAX_MONTHS, EP_PIPELINES,
  openIndex, checkOffered, fillOpenDates, sourceText, TOKEN };
