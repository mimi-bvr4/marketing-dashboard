// ORDER #2332: GET /api/revenue-goal[?refresh=1]
// The 2026 YTD revenue-goal figure, summed on the server (lib/revenue-goal.js),
// cached 15 minutes, with its "as of HH:MM CT" stamp. ?refresh=1 reads HubSpot
// now. Signed-in exec/Katherine session only: not on the fleet-key list, since
// it is a money figure (#1390).
'use strict';

const express = require('express');

function createRevenueGoalRouter({ cache }) {
  const r = express.Router();
  r.get('/api/revenue-goal', async (req, res) => {
    try {
      const { body, cache: state } = await cache.get({ refresh: req.query.refresh === '1' });
      res.set('X-Cache', state);
      res.json(body);
    } catch (e) {
      console.error('[revenue goal]', e.message);
      res.status(502).json({ error: `HubSpot read failed: ${e.message}` });
    }
  });
  return r;
}

module.exports = { createRevenueGoalRouter };
