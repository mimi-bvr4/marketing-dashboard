// ORDER #2335: the home "2026 Monthly Trend" chart, summed on the server.
//
// The page used to make at least 40 HubSpot searches per load for this chart
// (each month: a lead count, two booking pipelines, a revenue read), one month
// after another, through the proxy's one-at-a-time HubSpot queue (350 ms
// between calls), holding up every other tile on the marketing home. Now one
// job sums it here, caches it for 15 minutes, and the page reads one answer.
//
// The queries and the math are PORTED VERBATIM from loadTrend() in
// public/index.html as it stood on main cfcf3e8 (bookings through
// lib/funnel-defs.js, the page's own fetchUniqueBookings, drift-tested by
// #1663); test/order2335_trend_server_side.test.js runs the old page code and
// this file over the same fake HubSpot and fails if any month differs. Test
// deals are excluded by the caller's search, exactly as the proxy excluded
// them (ORDER #1450).
'use strict';

const {
  IHG_VENUES, SALES_PIPELINE, EVENT_PIPELINE_DEFAULT, BOOKING_PROPS,
  monthRange, toEpochMs, bookingFilters, dedupeBookings, fetchAll,
} = require('./funnel-defs');
const { REVENUE_NET_MULTIPLIER, stampCT } = require('./revenue-goal');

const CACHE_MS = 15 * 60 * 1000;
const VIEWS = ['2026-ytd'];

// The page's window: Jan 2026 through the current UTC month (all of 2026 once it is over).
function trendMonths(now) {
  const endMonth = now.getUTCFullYear() >= 2026 ? (now.getUTCFullYear() > 2026 ? 12 : now.getUTCMonth() + 1) : 0;
  const months = [];
  for (let i = 0; i < endMonth; i++) months.push(`2026-${String(i + 1).padStart(2, '0')}`);
  return months;
}

async function computeTrend({ search, now = new Date(), view = '2026-ytd' }) {
  let pages = 0;
  const counting = (type, body) => { pages++; return search(type, body); };
  const countContacts = async (filters) => (await counting('contacts', { filterGroups: [{ filters }], limit: 1 })).total || 0;
  const months = trendMonths(now);
  const labels = months.map(m => monthRange(m).label);
  const leads = [], bookings = [], cancelled = [], revenue = [];
  for (const ym of months) {
    const { start, end } = monthRange(ym);
    const monthPeriod = { start, end };
    const [l, bookingsResult, revDeals] = await Promise.all([
      countContacts([
        { propertyName: 'venue_s_', operator: 'IN', values: IHG_VENUES },
        { propertyName: 'createdate', operator: 'GTE', value: start },
        { propertyName: 'createdate', operator: 'LT', value: end }
      ]),
      Promise.all([
        fetchAll(counting, 'deals', [{ filters: bookingFilters(monthPeriod, SALES_PIPELINE) }], BOOKING_PROPS),
        fetchAll(counting, 'deals', [{ filters: bookingFilters(monthPeriod, EVENT_PIPELINE_DEFAULT) }], BOOKING_PROPS)
      ]).then(([salesBookings, eventBookings]) => dedupeBookings(salesBookings, eventBookings)),
      fetchAll(counting, 'deals', [{ filters: [
        { propertyName: 'pipeline', operator: 'IN', values: [SALES_PIPELINE, EVENT_PIPELINE_DEFAULT] },
        { propertyName: 'final_event_total_accounting', operator: 'HAS_PROPERTY' },
        { propertyName: 'actual_event_date', operator: 'GTE', value: toEpochMs(start) },
        { propertyName: 'actual_event_date', operator: 'LT', value: toEpochMs(end) }
      ]}], ['final_event_total_accounting'], 3)
    ]);
    leads.push(l);
    bookings.push(bookingsResult.all.length);
    cancelled.push(bookingsResult.cancelled.length);
    revenue.push(revDeals.reduce((a, d) => a + (parseFloat(d.properties?.final_event_total_accounting || '0') || 0), 0) * REVENUE_NET_MULTIPLIER);
  }
  return { view, months, labels, leads, bookings, cancelled, revenue, hubspot_calls: pages, as_of: now.toISOString(), as_of_ct: stampCT(now) };
}

// One answer per view, one cache: fresh for `cacheMs`, one HubSpot read at a
// time per view (a second caller during a read waits for the same answer),
// refresh on demand.
function createTrendCache({ search, now = () => new Date(), cacheMs = CACHE_MS }) {
  const hits = new Map(), inflight = new Map();
  const read = (view) => {
    if (!inflight.has(view)) {
      inflight.set(view, computeTrend({ search, now: now(), view })
        .then((body) => { hits.set(view, { expires: now().getTime() + cacheMs, body }); return body; })
        .finally(() => { inflight.delete(view); }));
    }
    return inflight.get(view);
  };
  return {
    async get({ view = '2026-ytd', refresh = false } = {}) {
      if (!VIEWS.includes(view)) throw Object.assign(new Error(`unknown trend view "${view}"`), { status: 400 });
      const hit = hits.get(view);
      if (!refresh && hit && hit.expires > now().getTime()) return { body: hit.body, cache: 'HIT' };
      return { body: await read(view), cache: 'MISS' };
    },
    warm: () => read('2026-ytd').catch((e) => console.error('[trend] warm:', e.message)),
  };
}

module.exports = { CACHE_MS, VIEWS, trendMonths, computeTrend, createTrendCache };
