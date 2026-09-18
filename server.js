const express = require('express');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---- Fleet Contract v0 (ORDER #192): discovery, health, read-only tokens ----
const { fleetGate } = require('./middleware/auth');
app.use(fleetGate);

// ═══════════════════════════════════════════════════════════════════════════
// ORDER #654 — THE SINGLE CHOKE POINT. RED #1 of the #653 fleet audit.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT WAS OPEN: not one of nine routes named an auth middleware, and the only
// global middleware was fleetGate -- whose own comment says "No token /
// non-fleet token → pass through (existing open dashboard behavior
// preserved)". It constrains FLEET tokens; it authenticates nobody. So
// POST /api/ai/narrative (an AI call that spends money on attacker-supplied
// text), POST /api/hubspot/search (live CRM), /api/spend, four /api/ga4/* and
// the token-minting page were reachable by anyone on the internet.
//
// 🔴 express.static USED TO BE MOUNTED ABOVE THIS LINE, which is why gating
// only /api/* would have been a half fix: index.html was served by the static
// middleware before any gate could run. Amendment A is explicit -- "the gate
// covers the PAGE, not just /api/*" -- so the gate now sits ABOVE
// express.static and a cold navigate hits the sign-in wall.
//
// ONE GATE, NOT A PER-ROUTE SPRINKLE (the order's item 1, same shape as #652):
// app.use() before the route table means a route written next week is gated by
// default, with nobody remembering a decorator. There is a known-bad for it.
//
// IDENTITY: the JWT that POST /api/login already mints, presented EITHER as
// `Authorization: Bearer` (what the existing token-admin page does) OR in the
// `mkt_session` cookie (what a browser navigating to a PAGE can do -- a
// navigation cannot set a header, which is the whole reason the cookie exists).
// The cookie is read straight off req.headers.cookie: no cookie-parser, no new
// dependency, because safe_ff's dependency guard treats a package.json change
// as a real event (ORDER #581 item 3) and this fix should not need one.
//
// STILL OPEN, deliberately, each named:
//   * POST /api/login            -- the door itself
//   * /health, /.well-known/agent-contract, /api/contract -- the Fleet
//     Contract v0 discovery surface, public by its own design (ORDER #192)
//   * a validated fleet token    -- already constrained to GET/HEAD/OPTIONS by
//     fleetGate above; #653 classified it a legitimate read principal
const jwtLib = require('jsonwebtoken');
const SESSION_COOKIE = 'mkt_session';
const OPEN_PATHS = new Set([
  '/api/login', '/health', '/.well-known/agent-contract', '/api/contract',
  // ORDER #656: the cross-app SSO door. Both are part of getting a session, so
  // gating them would mean nobody arriving from the Hub could ever obtain one --
  // the same reason #652 left the Sales Brain's /sales/api/auth/sso open. The
  // verify route fails CLOSED (503) when DISPATCH_JWT_SECRET is unset, so an
  // open path here is not an open door.
  '/api/auth/sso-url', '/api/auth/sso', '/sso-complete.html',
]);

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function sessionUser(req) {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  const token = bearer || cookieToken(req);
  if (!token) return null;
  try { return jwtLib.verify(token, process.env.JWT_SECRET || 'dev-insecure-change-me'); }
  catch (e) { return null; }
}

const SIGN_IN_PAGE = `<!doctype html><meta charset="utf-8"><title>Marketing Dashboard — sign in</title>
<link rel="stylesheet" href="https://dispatch.infinityhospitalitygroup.com/ihg.css">
<body style="font-family:system-ui;max-width:420px;margin:12vh auto;padding:0 20px">
<h1 style="font-size:20px">Marketing Dashboard</h1>
<p style="color:#6D6E71;font-size:14px">Signed in to Infinity already? Use the Hub button — no second Google login.</p>
<p><button onclick="sso()" style="padding:10px 16px">Continue with Infinity</button></p>
<p style="color:#6D6E71;font-size:13px">or sign in with the marketing password:</p>
<form onsubmit="go(event)"><input id="pw" type="password" placeholder="Password" style="width:100%;padding:10px;font-size:15px">
<button style="margin-top:10px;padding:10px 16px">Sign in</button></form>
<p id="err" style="color:#b00;font-size:13px"></p>
<script>async function sso(){const r=await fetch('/api/auth/sso-url');if(!r.ok){document.getElementById('err').textContent='Single sign-on is not configured on this deploy.';return;}location.href=(await r.json()).url;}
async function go(e){e.preventDefault();
 const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
 if(r.ok){location.reload();}else{document.getElementById('err').textContent=(await r.json()).error||'Sign in failed';}}</script>`;

app.use((req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.fleetClient) return next();          // a validated, read-only fleet token
  if (sessionUser(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.status(401).type('html').send(SIGN_IN_PAGE);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/', require('./routes/fleet'));
app.get('/settings/api-tokens', (req, res) => res.sendFile(path.join(__dirname, 'public', 'api-tokens.html')));
const { ensureTables } = require('./db');
ensureTables().catch(e => console.error('[fleet] ensureTables:', e.message));

// ---- GA4 Configuration ----
const GA4_PROPERTIES = {
  'TBB': '360515557',
  'TBT': '360552021',
  'ECD': '372413058',
  'SWF': '446541210'
};

// ---- Elle venues (ACQUISITION — held DELIBERATELY SEPARATE from IHG) ----
// A SECOND map on purpose. GA4_PROPERTIES (above) is the ONLY map the IHG
// summary/funnel iterate, so nothing here can bleed into a validated Infinity number.
// The Elle dashboard tab reads ONLY /api/ga4/elle/*, which read ONLY this map.
// WHEN Elle revenue converts to IH: move these lines up into GA4_PROPERTIES,
// delete this block + the /api/ga4/elle/* routes, add STE/COR/EST to the front-end
// pickers. That single move "pulls Elle into the full mix."
// Property IDs verified via GA4 Data Streams (site each stream points to):
const GA4_ELLE_PROPERTIES = {
  'STE': '546276459',   // Saint Elle   — thesaintelle.com
  'COR': '397846080',   // The Cordelle — thecordelle.com
  'EST': '356513971'    // Estelle      — estellenashville.com
};
// True only once real numeric property IDs are present.
function elleConfigured() {
  return Object.values(GA4_ELLE_PROPERTIES).every(id => /^\d+$/.test(String(id)));
}

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

// ---- ORDER #182 step 2 (SPEED) — server-side cache, 10-min TTL per query shape.
// Keyed on the exact request body the client sends (objectType + filters/props/sorts),
// so every period ("ytd", a specific month, etc.) gets its own cache entry for free —
// no client change needed, since loadPeriod() always sends the same shape for the same
// period. Marketing's own staleness tolerance is hours (order's own words); 10 min is
// generous. A cache HIT skips the live HubSpot call (and the 350ms rate-limit queue)
// entirely — this is the load-latency fix, not just a nice-to-have.
const HS_CACHE_TTL_MS = 10 * 60 * 1000;
const hsCache = new Map(); // key -> { expires, status, data }

function hsCacheKey(objectType, body) {
  return objectType + '::' + JSON.stringify(body);
}

function hsCacheGet(key) {
  const hit = hsCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { hsCache.delete(key); return null; }
  return hit;
}

function hsCacheSet(key, status, data) {
  hsCache.set(key, { expires: Date.now() + HS_CACHE_TTL_MS, status, data });
  // Bound memory growth: opportunistically drop expired entries on write rather than
  // running a separate timer — the query-shape space here is small (a handful of
  // metrics x a handful of periods), so this is cheap and sufficient.
  if (hsCache.size > 500) {
    for (const [k, v] of hsCache) { if (Date.now() > v.expires) hsCache.delete(k); }
  }
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
  const key = hsCacheKey(objectType, body);
  const cached = hsCacheGet(key);
  if (cached) {
    res.set('X-Cache', 'HIT');
    return res.status(cached.status).json(cached.data);
  }
  try {
    const r = await enqueueHubSpot(() => hubspotFetch(objectType, body));
    const data = await r.json();
    if (r.status === 200) hsCacheSet(key, r.status, data); // only cache real success, never cache an error/retry state
    res.set('X-Cache', 'MISS');
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

// ============================================================
// ELLE (acquisition) GA4 endpoints — walled off from IHG.
// Read GA4_ELLE_PROPERTIES only. No IHG route touches that map and these touch no
// IHG map, so Elle can never appear in /api/ga4/summary or any IHG aggregate.
// Return { pending:true } (not a 500) until real property IDs are set.
// ============================================================
app.get('/api/ga4/elle/sessions', async (req, res) => {
  const { venue, startDate, endDate } = req.query;
  if (!venue || !GA4_ELLE_PROPERTIES[venue]) return res.status(400).json({ error: 'Invalid Elle venue. Use: ' + Object.keys(GA4_ELLE_PROPERTIES).join(', ') });
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });
  if (!elleConfigured()) return res.json({ pending: true, venue, reason: 'Elle GA4 property IDs not yet configured' });
  try {
    const response = await ga4Fetch(GA4_ELLE_PROPERTIES[venue],
      { startDate, endDate },
      [{ name: 'sessionSource' }, { name: 'date' }],
      [{ name: 'sessions' }, { name: 'newUsers' }, { name: 'totalUsers' }, { name: 'screenPageViews' }, { name: 'bounceRate' }]
    );
    const data = parseGA4Response(response, ['sessionSource', 'date']);
    res.json({ venue, propertyId: GA4_ELLE_PROPERTIES[venue], dateRange: { startDate, endDate }, totalSessions: data.reduce((s, r) => s + r.sessions, 0), rawData: data });
  } catch (e) {
    console.error('[GA4 elle sessions]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ga4/elle/summary', async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });
  if (!elleConfigured()) {
    return res.json({ pending: true, reason: 'Elle GA4 property IDs not yet configured',
      venues: Object.keys(GA4_ELLE_PROPERTIES).reduce((a, v) => (a[v] = { pending: true }, a), {}) });
  }
  try {
    const venues = {};
    await Promise.all(Object.entries(GA4_ELLE_PROPERTIES).map(async ([v, pid]) => {
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
          bySource: data.map(r => ({ sessionSource: r.sessionSource || 'Direct', sessions: r.sessions, newUsers: r.newUsers }))
        };
      } catch (e) {
        venues[v] = { error: e.message };
      }
    }));
    res.json({ scope: 'elle', dateRange: { startDate, endDate }, venues });
  } catch (e) {
    console.error('[GA4 elle summary]', e.message);
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
// Update this when Katherine updates her spend sheet.
//
// ORDER #182 rider ("Unify spend"): this used to be a SEPARATE, differently-shaped
// blob (month-index arrays, human-label keys) from the one public/index.html actually
// used to render the dashboard (month-string keys, snake_case keys) -- same real
// dollar figures, two divergent representations, a drift landmine per the order's
// own words. This is now written in the shape the CLIENT actually consumes (verified
// figure-for-figure against the prior array shape before deleting it), and the client
// fetches it from here via GET /api/spend instead of carrying its own inline copy.
// Jun-Dec reuse the same May channel mix + a flat baseline fixed-cost row, matching
// the exact generation the client used to do itself.
// ============================================================
const SPEND_MONTHS_2026 = {
  '2026-01': {
    channels: {
      google_ads: { TBB: 1500, TBT: 1500, ECD: 1800, SWF: 1500 },
      tiktok: { TBB: 0, TBT: 0, ECD: 0, SWF: 0 },
      hctg: { TBB: 153, TBT: 85.50, ECD: 85.50, SWF: 153 },
      wedsociety: { TBB: 375, TBT: 375, ECD: 375, SWF: 375 },
      zola: { TBB: 160, TBT: 0, ECD: 0, SWF: 120 },
      cvent: { TBB: 541.42, TBT: 541.42, ECD: 0, SWF: 0 },
      the_knot: { TBB: 1550.08, TBT: 605, ECD: 1480.25, SWF: 1650.33 },
      weddingwire: { TBB: 1561.17, TBT: 605, ECD: 677.08, SWF: 1650.25 }
    },
    fixed: { salary: 6200, kam_agency: 15000, content_creator: 0, software_tools: 1245, website: 902 }
  },
  '2026-02': {
    channels: {
      google_ads: { TBB: 1500, TBT: 1500, ECD: 1800, SWF: 1500 },
      tiktok: { TBB: 750, TBT: 750, ECD: 750, SWF: 750 },
      hctg: { TBB: 153, TBT: 85.50, ECD: 85.50, SWF: 153 },
      wedsociety: { TBB: 375, TBT: 375, ECD: 375, SWF: 375 },
      zola: { TBB: 160, TBT: 0, ECD: 0, SWF: 120 },
      cvent: { TBB: 541.42, TBT: 541.42, ECD: 0, SWF: 0 },
      the_knot: { TBB: 1550.08, TBT: 605, ECD: 1480.25, SWF: 1650.33 },
      weddingwire: { TBB: 1561.17, TBT: 605, ECD: 677.08, SWF: 1650.25 }
    },
    fixed: { salary: 6200, kam_agency: 15000, content_creator: 0, software_tools: 1421, website: 902 }
  },
  '2026-03': {
    channels: {
      google_ads: { TBB: 1500, TBT: 1500, ECD: 1800, SWF: 1500 },
      tiktok: { TBB: 750, TBT: 750, ECD: 750, SWF: 750 },
      hctg: { TBB: 153, TBT: 85.50, ECD: 85.50, SWF: 153 },
      wedsociety: { TBB: 375, TBT: 375, ECD: 375, SWF: 375 },
      zola: { TBB: 160, TBT: 0, ECD: 0, SWF: 120 },
      cvent: { TBB: 541.42, TBT: 541.42, ECD: 0, SWF: 0 },
      the_knot: { TBB: 1550.08, TBT: 605, ECD: 1480.25, SWF: 1650.33 },
      weddingwire: { TBB: 1561.17, TBT: 605, ECD: 677.08, SWF: 1650.25 }
    },
    fixed: { salary: 6200, kam_agency: 15000, content_creator: 3750, software_tools: 1301, website: 902 }
  },
  '2026-04': {
    channels: {
      google_ads: { TBB: 2000, TBT: 2000, ECD: 1800, SWF: 1500 },
      tiktok: { TBB: 0, TBT: 0, ECD: 750, SWF: 750 },
      hctg: { TBB: 153, TBT: 85.50, ECD: 85.50, SWF: 153 },
      wedsociety: { TBB: 375, TBT: 375, ECD: 375, SWF: 375 },
      zola: { TBB: 160, TBT: 0, ECD: 0, SWF: 120 },
      cvent: { TBB: 541.42, TBT: 541.42, ECD: 0, SWF: 0 },
      the_knot: { TBB: 1550.08, TBT: 605, ECD: 1480.25, SWF: 1650.33 },
      weddingwire: { TBB: 1561.17, TBT: 605, ECD: 677.08, SWF: 1650.25 }
    },
    fixed: { salary: 6200, kam_agency: 15000, content_creator: 3000, software_tools: 1268, website: 3074 }
  },
  '2026-05': {
    channels: {
      google_ads: { TBB: 1500, TBT: 1500, ECD: 1800, SWF: 1500 },
      tiktok: { TBB: 0, TBT: 0, ECD: 750, SWF: 750 },
      hctg: { TBB: 153, TBT: 85.50, ECD: 85.50, SWF: 153 },
      wedsociety: { TBB: 375, TBT: 375, ECD: 375, SWF: 375 },
      zola: { TBB: 160, TBT: 0, ECD: 0, SWF: 120 },
      cvent: { TBB: 541.42, TBT: 541.42, ECD: 0, SWF: 0 },
      the_knot: { TBB: 1550.08, TBT: 605, ECD: 1480.25, SWF: 1650.33 },
      weddingwire: { TBB: 1561.17, TBT: 605, ECD: 677.08, SWF: 1650.25 }
    },
    fixed: { salary: 6200, kam_agency: 15000, content_creator: 3000, software_tools: 1532, website: 902 }
  }
};
// Baseline template for remaining months (Jun-Dec): same channel mix as May, no content creator or software.
const SPEND_BASELINE_CHANNELS_2026 = SPEND_MONTHS_2026['2026-05'].channels;
const SPEND_BASELINE_FIXED_2026 = { salary: 6200, kam_agency: 15000, content_creator: 0, software_tools: 0, website: 902 };
['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'].forEach((ym) => {
  SPEND_MONTHS_2026[ym] = { channels: SPEND_BASELINE_CHANNELS_2026, fixed: SPEND_BASELINE_FIXED_2026 };
});
const SPEND_2026 = SPEND_MONTHS_2026;
