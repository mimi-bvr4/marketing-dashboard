// ORDER #2335: GET /api/trend[?view=2026-ytd][&refresh=1]
// The home "2026 Monthly Trend" series (leads, bookings, cancelled, revenue per
// month), summed on the server (lib/trend.js), cached 15 minutes, with its
// "as of HH:MM CT" stamp. ?refresh=1 reads HubSpot now. Signed-in session
// only: not on the fleet-key list, since it carries revenue (#1390).
'use strict';

const express = require('express');

function createTrendRouter({ cache }) {
  const r = express.Router();
  r.get('/api/trend', async (req, res) => {
    try {
      const { body, cache: state } = await cache.get({ view: req.query.view || '2026-ytd', refresh: req.query.refresh === '1' });
      res.set('X-Cache', state);
      res.json(body);
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error('[trend]', e.message);
      res.status(502).json({ error: `HubSpot read failed: ${e.message}` });
    }
  });
  return r;
}

module.exports = { createTrendRouter };
