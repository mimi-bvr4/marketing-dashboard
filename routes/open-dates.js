// Open Date Filler: GET /api/open-dates?months=6
// Open Friday, Saturday and Sunday dates at the 7 venues (lib/open-dates.js).
// Dates and counts only: no client names, no money. Cached 30 minutes.
//
// Readable by a signed-in exec/Katherine session and by a read-only fleet key
// (middleware/page-gate.js allows /api/open-dates to keys, GET only), so the
// sales boards can show the same list.
'use strict';

const express = require('express');
const { computeOpenDates } = require('../lib/open-dates');

const CACHE_MS = 30 * 60 * 1000;

function createOpenDatesRouter({ search, now = () => new Date(), cacheMs = CACHE_MS }) {
  const r = express.Router();
  const cache = new Map();
  r.get('/api/open-dates', async (req, res) => {
    const months = Math.max(1, Math.min(18, parseInt(req.query.months, 10) || 6));
    const hit = cache.get(months);
    if (hit && hit.expires > now().getTime()) { res.set('X-Cache', 'HIT'); return res.json(hit.body); }
    try {
      const body = { ...(await computeOpenDates({ search, months, now: now() })), fetched_at: now().toISOString() };
      cache.set(months, { expires: now().getTime() + cacheMs, body });
      res.set('X-Cache', 'MISS');
      res.json(body);
    } catch (e) {
      console.error('[open dates]', e.message);
      res.status(502).json({ error: `HubSpot read failed: ${e.message}` });
    }
  });
  return r;
}

module.exports = { createOpenDatesRouter, CACHE_MS };
