// ORDER #1663 (Mimi's ruling 10.12.2026): "Monthly Report counts tours and
// bookings exactly as the marketing dashboard funnel does."
//
// These definitions are PORTED, not shared, from public/index.html (the
// "Conversion Funnel", "Full Funnel by Venue" and "Leads by Source x Venue"
// sections). The page's code is one inline IIFE on a live page; rewiring it to
// load this file was judged a riskier change than the job needs. Instead
// test/order1663_funnel_drift.test.js parses public/index.html and fails if any
// constant, filter builder or counting rule here stops matching the page. Edit
// both together or the suite goes red.
//
// COUNTS ONLY. No amount, revenue or money property is requested or returned.
'use strict';

const IHG_VENUES = ['TBB', 'TBT', 'ECD', 'SWF', 'OS'];
const SALES_PIPELINE = '746391920';
const EVENT_PIPELINE_DEFAULT = 'default';
const BOOKED_DATE_FIELD = 'contract_signed_date';
const TOUR_DATE_FIELD = 'initial_tour_date';

const LEAD_PROPS = ['venue_s_', 'lead_source', 'createdate'];
const TOUR_PROPS = ['venue', TOUR_DATE_FIELD, 'event_type_sales', 'dealname', 'pipeline'];
const BOOKING_PROPS = ['venue', BOOKED_DATE_FIELD, 'event_type_sales', 'dealname', 'pipeline', 'booked_cancelled__reporting_use_only_'];

// Verbatim from the page: UTC month boundaries.
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
function groupByVenue(records, key) {
  const out = { TBB: 0, TBT: 0, ECD: 0, SWF: 0, OS: 0 };
  for (const r of records) {
    const raw = r.properties?.[key] || '';
    const v = raw.split(';')[0].trim();
    if (out[v] !== undefined) out[v]++;
  }
  return out;
}

// Filter builders, same shape as the page's filtersTime / filtersFor.
const filtersTime = (period, p) => [
  { propertyName: p, operator: 'GTE', value: period.start },
  { propertyName: p, operator: 'LT', value: period.end }
];
function leadFilterGroups(period) {
  return [{ filters: [
    { propertyName: 'venue_s_', operator: 'IN', values: IHG_VENUES },
    ...filtersTime(period, 'createdate')
  ]}];
}
function dealDateFilters(period, field, pl) {
  return [
    { propertyName: 'pipeline', operator: 'EQ', value: pl },
    { propertyName: field, operator: 'GTE', value: toEpochMs(period.start) },
    { propertyName: field, operator: 'LT', value: toEpochMs(period.end) }
  ];
}
const tourFilters = (period, pl) => dealDateFilters(period, TOUR_DATE_FIELD, pl);
const bookingFilters = (period, pl) => dealDateFilters(period, BOOKED_DATE_FIELD, pl);

// The page's cross-pipeline dedupe: every Sales-pipeline deal counts; an Event
// Planning deal counts only when no Sales deal has the same normalized name.
function dedupe(salesDeals, eventDeals) {
  const salesKeys = new Set(salesDeals.map(d => normalizeDealName(d.properties?.dealname)));
  const eventOnly = eventDeals.filter(d => !salesKeys.has(normalizeDealName(d.properties?.dealname)));
  return { all: [...salesDeals, ...eventOnly], salesCount: salesDeals.length, eventOnlyCount: eventOnly.length };
}

// ORDER #1663 (Mimi, 10.12.2026: "we need cancelled in its own category,
// cancelled is an actual count"). booked_cancelled__reporting_use_only_ is a
// HubSpot enumeration, "Booked" or "Cancelled". Verbatim from the page.
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
// Bookings, as the page's fetchUniqueBookings: dedupe, then cancelled out into its own list.
function dedupeBookings(salesDeals, eventDeals) {
  return splitCancelled(dedupe(salesDeals, eventDeals), [...salesDeals, ...eventDeals]);
}

// "Leads by Source x Venue": first listed venue, blank source is "(none)",
// blank venue is OS; sorted by total, descending.
function leadsBySource(leads) {
  const venuesXT = ['TBB', 'TBT', 'ECD', 'SWF', 'OS'];
  const srcXT = {};
  for (const l of leads) {
    const s = l.properties?.lead_source || '(none)';
    const v = (l.properties?.venue_s_ || '').split(';')[0].trim() || 'OS';
    if (!srcXT[s]) srcXT[s] = { TBB: 0, TBT: 0, ECD: 0, SWF: 0, OS: 0, total: 0 };
    if (venuesXT.includes(v)) srcXT[s][v]++;
    srcXT[s].total++;
  }
  return Object.fromEntries(Object.entries(srcXT).sort((a, b) => b[1].total - a[1].total));
}

// The page's cursor pager (limit 200, up to 60 pages). `search(objectType, body)`
// resolves to HubSpot's JSON or throws.
async function fetchAll(search, objectType, filterGroups, properties, maxPages = 60) {
  const out = []; let after;
  for (let i = 0; i < maxPages; i++) {
    const body = { filterGroups, properties, limit: 200 };
    if (after) body.after = after;
    const data = await search(objectType, body);
    const batch = data.results || []; out.push(...batch);
    after = data.paging && data.paging.next && data.paging.next.after;
    if (!after || batch.length < 200) break;
  }
  return out;
}

// The previous calendar month in Nashville time, as YYYY-MM.
function previousMonthCT(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).formatToParts(now);
  let y = Number(parts.find(p => p.type === 'year').value);
  let m = Number(parts.find(p => p.type === 'month').value) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

async function computeMonthly({ month, search }) {
  const period = monthRange(month);
  const [leads, salesTours, eventTours, salesBookings, eventBookings] = await Promise.all([
    fetchAll(search, 'contacts', leadFilterGroups(period), LEAD_PROPS),
    fetchAll(search, 'deals', [{ filters: tourFilters(period, SALES_PIPELINE) }], TOUR_PROPS),
    fetchAll(search, 'deals', [{ filters: tourFilters(period, EVENT_PIPELINE_DEFAULT) }], TOUR_PROPS),
    fetchAll(search, 'deals', [{ filters: bookingFilters(period, SALES_PIPELINE) }], BOOKING_PROPS),
    fetchAll(search, 'deals', [{ filters: bookingFilters(period, EVENT_PIPELINE_DEFAULT) }], BOOKING_PROPS),
  ]);
  const tours = dedupe(salesTours, eventTours);
  const bookings = dedupeBookings(salesBookings, eventBookings);
  return {
    month,
    window: { start: period.start, end: period.end, label: period.label, boundaries: 'UTC month, as the dashboard page' },
    leads: { total: leads.length, by_venue: groupByVenue(leads, 'venue_s_'), by_source: leadsBySource(leads) },
    tours: { total: tours.all.length, by_venue: groupByVenue(tours.all, 'venue'), from_sales: tours.salesCount, event_only: tours.eventOnlyCount },
    bookings: { total: bookings.all.length, by_venue: groupByVenue(bookings.all, 'venue'), excludes: 'cancelled' },
    cancelled: { total: bookings.cancelled.length, by_venue: groupByVenue(bookings.cancelled, 'venue') },
    definitions: 'same as dashboard funnel',
  };
}

module.exports = {
  IHG_VENUES, SALES_PIPELINE, EVENT_PIPELINE_DEFAULT, BOOKED_DATE_FIELD, TOUR_DATE_FIELD,
  LEAD_PROPS, TOUR_PROPS, BOOKING_PROPS,
  monthRange, toEpochMs, normalizeDealName, groupByVenue, filtersTime, leadFilterGroups,
  tourFilters, bookingFilters, dedupe, isCancelledBooking, splitCancelled, dedupeBookings, leadsBySource, fetchAll, previousMonthCT, computeMonthly,
};
