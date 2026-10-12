// ORDER #1663: GET /api/funnel/monthly?month=YYYY-MM, read-only counts of
// leads, tours and bookings for one month, computed with the dashboard
// funnel's own definitions (lib/funnel-defs.js). Default month: the previous
// calendar month in Nashville time. Counts only, never money. Cached 1 hour.
//
// Readable by a signed-in exec/Katherine session and by a read-only fleet key
// (middleware/page-gate.js allows the /api/funnel/ prefix to keys, GET only).
'use strict';

const express = require('express');
const { computeMonthly, previousMonthCT } = require('../lib/funnel-defs');

const CACHE_MS = 60 * 60 * 1000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function createFunnelRouter({ search, now = () => new Date(), cacheMs = CACHE_MS }) {
  const r = express.Router();
  const cache = new Map(); // month -> { expires, body }

  r.get('/api/funnel/monthly', async (req, res) => {
    const month = req.query.month ? String(req.query.month) : previousMonthCT(now());
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    const hit = cache.get(month);
    if (hit && hit.expires > now().getTime()) { res.set('X-Cache', 'HIT'); return res.json(hit.body); }
    try {
      const body = { ...(await computeMonthly({ month, search })), fetched_at: now().toISOString() };
      cache.set(month, { expires: now().getTime() + cacheMs, body });
      res.set('X-Cache', 'MISS');
      res.json(body);
    } catch (e) {
      console.error('[funnel monthly]', e.message);
      res.status(502).json({ error: `HubSpot read failed: ${e.message}` });
    }
  });
  return r;
}

module.exports = { createFunnelRouter, CACHE_MS };
