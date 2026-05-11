const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- HubSpot Rate-Limited Queue ----
// HubSpot CRM Search allows ~4 req/sec; queue ensures we stay under
const HS_DELAY_MS = 350; // ms between HubSpot calls
let hsQueue = Promise.resolve();

function enqueueHubSpot(fn) {
  const p = hsQueue.then(() => fn()).then(
    result => { return new Promise(r => setTimeout(() => r(result), HS_DELAY_MS)); },
    err   => { return new Promise((_, rj) => setTimeout(() => rj(err), HS_DELAY_MS)); }
  );
  hsQueue = p.catch(() => {}); // prevent unhandled rejection chain breakage
  return p;
}

async function hubspotFetch(objectType, body, retries = 2) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (r.status === 429 && retries > 0) {
    const wait = parseInt(r.headers.get('retry-after') || '2', 10) * 1000;
    console.log(`[HubSpot] 429 rate-limited, retrying in ${wait}ms (${retries} left)`);
    await new Promise(resolve => setTimeout(resolve, wait));
    return hubspotFetch(objectType, body, retries - 1);
  }
  return r;
}

// ---- HubSpot CRM Search Proxy ----
app.post('/api/hubspot/search', async (req, res) => {
  const { objectType, ...body } = req.body;
  if (!['deals', 'contacts'].includes(objectType)) {
    return res.status(400).json({ error: 'Invalid objectType — must be deals or contacts' });
  }
  try {
    const r = await enqueueHubSpot(() => hubspotFetch(objectType, body));
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    console.error('[HubSpot proxy]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- AI Narrative Proxy (Anthropic) ----
app.post('/api/ai/narrative', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(501).json({ error: 'AI narrative not configured' });

  const { prompt, data } = req.body;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: prompt + '\n\nData: ' + JSON.stringify(data)
        }]
      })
    });
    const result = await r.json();
    res.json({ text: result.content?.[0]?.text || 'No analysis available.' });
  } catch (e) {
    console.error('[AI narrative]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- Spend data endpoint (from Katherine's spreadsheet) ----
app.get('/api/spend', (req, res) => {
  res.json(SPEND_2026);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IHG Marketing Dashboard running on port ${PORT}`));

// ============================================================
// 2026 Marketing Spend Data (from Katherine's IHG MARKETING SPEND INPUT)
// Update this when Katherine updates her spend sheet
// ============================================================
const SPEND_2026 = {
  months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
  // Per-channel per-venue spend (monthly arrays, index 0=Jan ... 11=Dec)
  channels: {
    'Google Ads': {
      TBB: [1500,1500,1500,2000,1500,1500,1500,1500,1500,1500,1500,1500],
      TBT: [1500,1500,1500,2000,1500,1500,1500,1500,1500,1500,1500,1500],
      ECD: [1800,1800,1800,1800,1800,1800,1800,1800,1800,1800,1800,1800],
      SWF: [1500,1500,1500,1500,1500,1500,1500,1500,1500,1500,1500,1500]
    },
    'TikTok': {
      TBB: [0,750,750,0,0,0,0,0,0,0,0,0],
      TBT: [0,750,750,0,0,0,0,0,0,0,0,0],
      ECD: [0,750,750,350,0,0,0,0,0,0,0,0],
      SWF: [0,750,750,350,0,0,0,0,0,0,0,0]
    },
    'Here Comes the Guide': {
      TBB: [153,153,153,153,153,153,153,153,153,153,153,153],
      TBT: [85.5,85.5,85.5,85.5,85.5,85.5,85.5,85.5,85.5,85.5,85.5,85.5],
      ECD: [85.5,85.5,85.5,85.5,85.5,85.5,85.5,85.5,85.5,85.5,85.5,85.5],
      SWF: [153,153,153,153,153,153,153,153,153,153,153,153]
    },
    'WedSociety': {
      TBB: [375,375,375,375,375,375,375,375,375,375,375,375],
      TBT: [375,375,375,375,375,375,375,375,375,375,375,375],
      ECD: [375,375,375,375,375,375,375,375,375,375,375,375],
      SWF: [375,375,375,375,375,375,375,375,375,375,375,375]
    },
    'Zola': {
      TBB: [160,160,160,160,160,160,160,160,160,160,160,160],
      TBT: [0,0,0,0,0,0,0,0,0,0,0,0],
      ECD: [0,0,0,0,0,0,0,0,0,0,0,0],
      SWF: [120,120,120,120,120,120,120,120,120,120,120,120]
    },
    'CVent': {
      TBB: [541.42,541.42,541.42,541.42,541.42,541.42,541.42,541.42,541.42,541.42,541.42,541.42],
      TBT: [541.42,541.42,541.42,541.42,541.42,541.42,541.42,541.42,541.42,541.42,541.42,541.42],
      ECD: [0,0,0,0,0,0,0,0,0,0,0,0],
      SWF: [0,0,0,0,0,0,0,0,0,0,0,0]
    },
    'The Knot': {
      TBB: [1550.08,1550.08,1550.08,1550.08,1550.08,1550.08,1550.08,1550.08,1550.08,1550.08,1550.08,1550.08],
      TBT: [605,605,605,605,605,605,605,605,605,605,605,605],
      ECD: [1480.25,1480.25,1480.25,1480.25,1480.25,1480.25,1480.25,1480.25,1480.25,1480.25,1480.25,1480.25],
      SWF: [1650.33,1650.33,1650.33,1650.33,1650.33,1650.33,1650.33,1650.33,1650.33,1650.33,1650.33,1650.33]
    },
    'WeddingWire': {
      TBB: [1561.17,1561.17,1561.17,1561.17,1561.17,1561.17,1561.17,1561.17,1561.17,1561.17,1561.17,1561.17],
      TBT: [605,605,605,605,605,605,605,605,605,605,605,605],
      ECD: [677.08,677.08,677.08,677.08,677.08,677.08,677.08,677.08,677.08,677.08,677.08,677.08],
      SWF: [1650.25,1650.25,1650.25,1650.25,1650.25,1650.25,1650.25,1650.25,1650.25,1650.25,1650.25,1650.25]
    }
  },
  // Fixed costs (not per-venue)
  fixed: {
    'Marketing Labor': [6200,6200,6200,6200,6200,6200,6200,6200,6200,6200,6200,6200],
    'K+M Agency':       [15000,15000,15000,15000,15000,15000,15000,15000,15000,15000,15000,15000],
    'Content Creator':  [0,0,3750,3000,3000,0,0,0,0,0,0,0],
    'Software & Tools': [1245,1421,1301,1268,1532,0,0,0,0,0,0,0],
    'Website':          [902,902,902,3074,902,902,902,902,902,902,902,902]
  },
  // Pre-computed totals per month (for quick reference)
  totalAdSpend:     [19419,22419,22419,21119,19419,19419,19419,19419,19419,19419,19419,19419],
  totalFullyLoaded: [42766,45942,49572,49661,46053,41521,41521,41521,41521,41521,41521,41521],
  perVenueAdSpend: {
    TBB: [5840.67,6590.67,6590.67,6340.67,5840.67,5840.67,5840.67,5840.67,5840.67,5840.67,5840.67,5840.67],
    TBT: [3711.92,4461.92,4461.92,4211.92,3711.92,3711.92,3711.92,3711.92,3711.92,3711.92,3711.92,3711.92],
    ECD: [4417.83,5167.83,5167.83,4767.83,4417.83,4417.83,4417.83,4417.83,4417.83,4417.83,4417.83,4417.83],
    SWF: [5448.58,6198.58,6198.58,5798.58,5448.58,5448.58,5448.58,5448.58,5448.58,5448.58,5448.58,5448.58]
  }
};
