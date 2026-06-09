const express = require('express');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- GA4 Configuration ----
const GA4_PROPERTIES = {
  'TBB': '360515557',
  'TBT': '360552021',
  'ECD': '372413058',
  'SWF': '446541210'
};

let analyticsDataClient = null;
try {
  if (process.env.GA4_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GA4_CREDENTIALS_JSON);
    analyticsDataClient = new BetaAnalyticsDataClient({ credentials, projectId: credentials.project_id });
    console.log('[GA4] Client initialized for', credentials.client_email);
  }
} catch (e) {
  console.warn('[GA4] Init failed:', e.message);
}

const GA4_SOURCE_MAP = {
  'organic':'Organic Search','cpc':'Paid Search','paid_search':'Paid Search',
  'direct':'Direct','(direct)':'Direct','referral':'Referral',
  'google':'Organic Search','tiktok':'Social Media','facebook':'Social Media',
  'instagram':'Social Media','pinterest':'Social Media','email':'Email'
};

async function ga4Fetch(propertyId, dateRange, dimensions, metrics) {
  if (!analyticsDataClient) throw new Error('GA4 client not configured — set GA4_CREDENTIALS_JSON');
  const [response] = await analyticsDataClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [dateRange],
    dimensions, metrics,
    limit: 10000
  });
  return response;
}

function parseGA4Response(response, dimNames) {
  if (!response.rows) return [];
  return response.rows.map(row => {
    const item = {};
    row.dimensionValues.forEach((v, i) => { item[dimNames[i]] = v.value; });
    row.metricValues.forEach((v, i) => {
      const name = response.metricHeaders[i].name;
      item[name] = parseFloat(v.value) || 0;
    });
    return item;
  });
}

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

// ---- GA4 Sessions Endpoint ----
app.get('/api/ga4/sessions', async (req, res) => {
  const { venue, startDate, endDate } = req.query;
  if (!venue || !GA4_PROPERTIES[venue]) return res.status(400).json({ error: 'Invalid venue. Use: ' + Object.keys(GA4_PROPERTIES).join(', ') });
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });

  try {
    const response = await ga4Fetch(GA4_PROPERTIES[venue],
      { startDate, endDate },
      [{ name: 'sessionSource' }, { name: 'date' }],
      [{ name: 'sessions' }, { name: 'newUsers' }, { name: 'totalUsers' }, { name: 'screenPageViews' }, { name: 'bounceRate' }]
    );
    const data = parseGA4Response(response, ['sessionSource', 'date']);

    // Aggregate by HubSpot source
    const bySource = {};
    for (const row of data) {
      const src = GA4_SOURCE_MAP[(row.sessionSource || '(direct)').toLowerCase()] || 'Other';
      if (!bySource[src]) bySource[src] = { sessions: 0, newUsers: 0, totalUsers: 0, pageviews: 0, bounceRateSum: 0, count: 0 };
      bySource[src].sessions += row.sessions;
      bySource[src].newUsers += row.newUsers;
      bySource[src].totalUsers += row.totalUsers;
      bySource[src].pageviews += row.screenPageViews;
      bySource[src].bounceRateSum += row.bounceRate;
      bySource[src].count++;
    }
    // Average bounce rates
    for (const s of Object.values(bySource)) { s.bounceRate = s.count > 0 ? +(s.bounceRateSum / s.count).toFixed(2) : 0; delete s.bounceRateSum; delete s.count; }

    res.json({ venue, propertyId: GA4_PROPERTIES[venue], dateRange: { startDate, endDate }, totalSessions: data.reduce((s, r) => s + r.sessions, 0), bySource });
  } catch (e) {
    console.error('[GA4 sessions]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- GA4 All-Venue Summary ----
app.get('/api/ga4/summary', async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });

  try {
    const venues = {};
    await Promise.all(Object.entries(GA4_PROPERTIES).map(async ([v, pid]) => {
      try {
        const response = await ga4Fetch(pid, { startDate, endDate },
          [{ name: 'sessionDefaultChannelGroup' }],
          [{ name: 'sessions' }, { name: 'newUsers' }]
        );
        const data = parseGA4Response(response, ['sessionSource']);
        venues[v] = {
          propertyId: pid,
          totalSessions: data.reduce((s, r) => s + r.sessions, 0),
          newUsers: data.reduce((s, r) => s + r.newUsers, 0),
          bySource: data.map(r => ({ source: r.sessionSource || 'Direct', sessions: r.sessions, newUsers: r.newUsers }))
        };
      } catch (e) {
        venues[v] = { error: e.message };
      }
    }));
    res.json({ dateRange: { startDate, endDate }, venues });
  } catch (e) {
    console.error('[GA4 summary]', e.message);
    res.status(500).json({ error: e.message });
  }
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
