// ORDER #2332: the "2026 revenue goal" figure, summed on the server.
//
// The page used to page every 2026 deal through /api/hubspot/search from the
// browser, AFTER the whole period load, behind the proxy's one-at-a-time
// HubSpot queue (350 ms between calls), so the home tile read "..." for about
// 30 seconds. Now one job sums it here, caches it for 15 minutes, and the page
// reads one small answer with its "as of HH:MM CT" stamp.
//
// The filters and the sum are PORTED VERBATIM from updateGoalBar() in
// public/index.html as it stood on main 3b6a455; test/order2332_revenue_goal_server_side.test.js
// runs the old page code and this file over the same deals and fails if the
// numbers ever differ. Test deals are excluded by the caller's search, exactly
// as the proxy excluded them (ORDER #1450).
'use strict';

const { fetchAll, toEpochMs, SALES_PIPELINE, EVENT_PIPELINE_DEFAULT } = require('./funnel-defs');

const IHG_GOAL_2026 = 19600000;
const REVENUE_NET_MULTIPLIER = 0.95;
const CACHE_MS = 15 * 60 * 1000;
const PROPS = ['final_event_total_accounting', 'venue', 'actual_event_date'];

function goalFilterGroups() {
  const yStart = new Date(Date.UTC(2026, 0, 1)).toISOString();
  const yEnd = new Date(Date.UTC(2027, 0, 1)).toISOString();
  return [{ filters: [
    { propertyName: 'pipeline', operator: 'IN', values: [SALES_PIPELINE, EVENT_PIPELINE_DEFAULT] },
    { propertyName: 'final_event_total_accounting', operator: 'HAS_PROPERTY' },
    { propertyName: 'actual_event_date', operator: 'GTE', value: toEpochMs(yStart) },
    { propertyName: 'actual_event_date', operator: 'LT', value: toEpochMs(yEnd) }
  ] }];
}

// Events on or before `now` count (the page's string compare, kept as is).
function sumYtd(deals, now) {
  const iso = now.toISOString();
  let ytd = 0, counted = 0;
  for (const d of deals) {
    if ((d.properties?.actual_event_date || '') <= iso) {
      ytd += (parseFloat(d.properties?.final_event_total_accounting || '0') || 0) * REVENUE_NET_MULTIPLIER;
      counted++;
    }
  }
  return { ytd, counted };
}

function stampCT(d) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d) + ' CT';
}

async function computeRevenueGoal({ search, now = new Date() }) {
  let pages = 0;
  const counting = (type, body) => { pages++; return search(type, body); };
  const deals = await fetchAll(counting, 'deals', goalFilterGroups(), PROPS);
  const { ytd, counted } = sumYtd(deals, now);
  return { ytd, goal: IHG_GOAL_2026, events: counted, hubspot_calls: pages, as_of: now.toISOString(), as_of_ct: stampCT(now) };
}

// One figure, one cache: fresh for `cacheMs`, one HubSpot read at a time
// (a second caller during a read waits for the same answer), refresh on demand.
function createRevenueGoalCache({ search, now = () => new Date(), cacheMs = CACHE_MS }) {
  let hit = null, inflight = null;
  const read = () => {
    if (!inflight) {
      inflight = computeRevenueGoal({ search, now: now() })
        .then((body) => { hit = { expires: now().getTime() + cacheMs, body }; return body; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  };
  return {
    async get({ refresh = false } = {}) {
      if (!refresh && hit && hit.expires > now().getTime()) return { body: hit.body, cache: 'HIT' };
      return { body: await read(), cache: 'MISS' };
    },
    warm: () => read().catch((e) => console.error('[revenue goal] warm:', e.message)),
  };
}

module.exports = { IHG_GOAL_2026, REVENUE_NET_MULTIPLIER, CACHE_MS, goalFilterGroups, sumYtd, stampCT, computeRevenueGoal, createRevenueGoalCache };
