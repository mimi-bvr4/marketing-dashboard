// ORDER #1733: GET /api/funnel/email-stats?month=YYYY-MM, the HubSpot
// marketing-email totals for one month (sends, delivered, opens, clicks,
// unsubscribes, bounces), read through the fenced lib/hubspot-email-stats.js.
// Counts only: no email names, no contacts, no money. Default month: the
// previous calendar month in Nashville. Cached 1 hour, successes only.
//
// It sits under /api/funnel/ so the read-only fleet key the Email agent already
// uses can read it (middleware/page-gate.js, #1663) without widening the key's
// allow-list. A fail-closed reason ("scope missing: ...") answers 200 with
// { ok: false, why }, so the agent can quote it on its "could not run" card.
'use strict';

const express = require('express');

const CACHE_MS = 60 * 60 * 1000;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function createEmailStatsRouter({ stats, now = () => new Date(), cacheMs = CACHE_MS }) {
  const S = require('../lib/hubspot-email-stats');
  const r = express.Router();
  const cache = new Map(); // month -> { expires, body }

  r.get('/api/funnel/email-stats', async (req, res) => {
    let range = S.lastMonth(now());
    if (req.query.month) {
      const m = String(req.query.month).match(MONTH_RE);
      if (!m) return res.status(400).json({ error: 'month must be YYYY-MM' });
      // the month after the one asked for, at noon on the 1st, has that month as its "last month"
      const next = Number(m[2]) === 12 ? [Number(m[1]) + 1, 1] : [Number(m[1]), Number(m[2]) + 1];
      range = S.lastMonth(new Date(Date.UTC(next[0], next[1] - 1, 1, 18)));
    }
    const hit = cache.get(range.label);
    if (hit && hit.expires > now().getTime()) { res.set('X-Cache', 'HIT'); return res.json(hit.body); }
    const out = await stats({ range });
    const body = { ...out, fetched_at: now().toISOString() };
    if (out.ok) cache.set(range.label, { expires: now().getTime() + cacheMs, body });
    res.set('X-Cache', 'MISS');
    res.json(body);
  });
  return r;
}

module.exports = { createEmailStatsRouter, CACHE_MS };
