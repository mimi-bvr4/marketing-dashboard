'use strict';

// ORDER #1202: KNOWN-BADS FOR THE HOST SPLIT.
//
// The hub and the gated dashboard share one process. That is safe only if the
// split is by HOST and is tested, so everything here drives THE REAL server.js
// (exported for this order), loaded fresh per env, over loopback. Nothing
// touches a live service.
//
//   1. On a public host, every internal route is 404: never 200, never a 302
//      to SSO, never JSON.
//   2. On the dashboard host, unauthenticated, /hub/* bounces to SSO and /api
//      401s, unchanged.
//   3. With VENUE_HUB_HOSTS unset the hub is off everywhere.
//   4. Every hub response carries noindex.
//   5. A thrown error in a hub route is a 500 for that request only.
//   6. The hub never reads sessions, staff tables or the GA4 credential.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { loadDashboard, serve, request } = require('./order1202_hub_helpers');
const { createHubRouter } = require('../hub/router');
const { THEMES } = require('../hub/data/themes');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const PUBLIC = 'nashvilleweddingvenue.com';
const DASH = 'marketing.infinityhospitalitygroup.com';
const ON = { VENUE_HUB_HOSTS: `${PUBLIC}, www.${PUBLIC}` };

// Every route the dashboard has today. OPEN_PATHS is read from the real gate so
// a door added there next week is swept here too.
function internalRoutes() {
  const { OPEN_PATHS } = require('../middleware/page-gate');
  const pages = ['/index.html', '/api-tokens.html', '/settings/api-tokens', '/sso-complete.html',
    '/favicon.ico', '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png',
    // the tab pages and #1008's /photos (on its branch today): the SPA fallback serves any of these
    '/photos', '/landing-pages', '/reports', '/elle', '/spend', '/split-tests'];
  const api = ['/api/spend', '/api/ga4/summary', '/api/ga4/sessions?venue=TBB', '/api/ga4/elle/summary',
    '/api/fleet/tokens', '/api/whoami'];
  return [...new Set([...OPEN_PATHS, ...pages, ...api])];
}

function sessionCookie() {
  const tok = jwt.sign({ role: 'sso', email: 'staff@infinityhospitality.net' }, 'marketing-test-secret-not-real', { expiresIn: '1h' });
  return `mkt_session=${encodeURIComponent(tok)}`;
}

function assertDead(r, label) {
  assert.equal(r.status, 404, `${label} answered ${r.status}`);
  assert.equal(r.headers.location, undefined, `${label} redirected to ${r.headers.location}`);
  assert.ok(!String(r.headers['content-type'] || '').includes('json'), `${label} answered JSON`);
  assert.ok(!r.body.includes('Marketing Dashboard'), `${label} leaked the dashboard`);
  assert.equal(r.headers['set-cookie'], undefined, `${label} set a cookie`);
}

// ---- KNOWN-BAD 1: a public host never reaches the dashboard -------------
test('KNOWN-BAD 1: on a public host every internal route is 404, never 200, 302 or JSON', async (t) => {
  const s = await serve(loadDashboard(ON), t);
  for (const host of [PUBLIC, `www.${PUBLIC}`, `${PUBLIC.toUpperCase()}:443`]) {
    for (const p of internalRoutes()) {
      assertDead(await request(s, p, { headers: { host } }), `${host} GET ${p}`);
    }
    for (const p of ['/api/login', '/api/hubspot/search', '/api/ai/narrative', '/api/auth/sso']) {
      assertDead(await request(s, p, { method: 'POST', headers: { host, 'content-type': 'application/json' }, body: '{}' }), `${host} POST ${p}`);
    }
  }
});

test('…even WITH a valid staff session: the public host never reads one', async (t) => {
  const s = await serve(loadDashboard(ON), t);
  for (const p of ['/api/spend', '/index.html', '/settings/api-tokens', '/photos']) {
    assertDead(await request(s, p, { headers: { host: PUBLIC, cookie: sessionCookie(), authorization: 'Bearer mkt_fleet_token' } }), p);
  }
});

test('…and an unknown slug or the dashboard path /hub is 404 on a public host, not a redirect', async (t) => {
  const s = await serve(loadDashboard(ON), t);
  for (const p of ['/nope', '/GARDEN', '/hub', '/hub/garden', '/inquire', '/health']) {
    assertDead(await request(s, p, { headers: { host: PUBLIC } }), p);
  }
});

test('the public host DOES serve the hub allow-list', async (t) => {
  const s = await serve(loadDashboard(ON), t);
  const home = await request(s, '/', { headers: { host: PUBLIC } });
  assert.equal(home.status, 200);
  assert.ok(home.body.includes('Seven distinctive venues'), 'the hub home');
  assert.ok(!home.body.includes('Marketing Dashboard'));
  for (const p of ['/garden/b', '/garden/c', '/robots.txt', '/sitemap.xml', '/thanks']) {
    assert.equal((await request(s, p, { headers: { host: PUBLIC } })).status, 200, p);
  }
  // a draft theme is the hub's own call: home, on the public host
  const draft = await request(s, '/industrial', { headers: { host: PUBLIC } });
  assert.equal(draft.status, 302);
  assert.equal(draft.headers.location, '/');
  // the sandbox form: with no portal set it sends nothing and says so
  const form = await request(s, '/inquire', { method: 'POST', headers: { host: PUBLIC, 'content-type': 'application/x-www-form-urlencoded' }, body: 'firstname=A&lastname=B&email=a%40b.co' });
  assert.equal(form.status, 503);
});

// ---- KNOWN-BAD 2: the dashboard host is unchanged -----------------------
test('KNOWN-BAD 2: on the dashboard host, unauthenticated, /hub/* bounces to SSO and /api 401s', async (t) => {
  const s = await serve(loadDashboard(ON), t);
  for (const p of ['/hub', '/hub/', '/hub/garden/b', '/hub/hub-assets/x.svg', '/']) {
    const r = await request(s, p, { headers: { host: DASH } });
    assert.equal(r.status, 302, `${p} was not bounced`);
    assert.ok(r.headers.location.startsWith('https://dispatch.infinityhospitalitygroup.com/api/auth/google?return_to='), p);
  }
  const post = await request(s, '/hub/inquire', { method: 'POST', headers: { host: DASH, 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
  assert.equal(post.status, 401, 'an anonymous POST into the preview got through');
  const api = await request(s, '/api/spend', { headers: { host: DASH } });
  assert.equal(api.status, 401);
  assert.match(api.body, /Not authenticated/);
});

test('…and signed in, the dashboard host serves the private preview at /hub with links inside /hub', async (t) => {
  const s = await serve(loadDashboard(ON), t);
  const r = await request(s, '/hub/garden/b', { headers: { host: DASH, cookie: sessionCookie() } });
  assert.equal(r.status, 200);
  assert.match(r.body, /action="\/hub\/inquire"/);
  assert.match(r.body, /Private preview/);
  const spend = await request(s, '/api/spend', { headers: { host: DASH, cookie: sessionCookie() } });
  assert.equal(spend.status, 200, 'the dashboard itself still works');
  assert.match(spend.headers['content-type'], /json/);
});

// ---- KNOWN-BAD 3: unset means off ---------------------------------------
test('KNOWN-BAD 3: with VENUE_HUB_HOSTS unset, a public-host request gets the existing gated behavior', async (t) => {
  for (const env of [{}, { VENUE_HUB_HOSTS: '' }, { VENUE_HUB_HOSTS: ' , ' }]) {
    const s = await serve(loadDashboard(env), t);
    const home = await request(s, '/', { headers: { host: PUBLIC } });
    assert.equal(home.status, 302, `${JSON.stringify(env)}: the hub answered with no hosts set`);
    assert.ok(home.headers.location.includes('/api/auth/google'));
    assert.ok(!home.body.includes('Seven distinctive venues'));
    const api = await request(s, '/api/spend', { headers: { host: PUBLIC } });
    assert.equal(api.status, 401);
    // and the private preview is off too: signed in, /hub is the dashboard's SPA, not the hub
    const hub = await request(s, '/hub/garden/b', { headers: { host: DASH, cookie: sessionCookie() } });
    assert.ok(!hub.body.includes('Private preview'), 'the hub preview ran with the hub off');
  }
});

// ---- KNOWN-BAD 4: noindex everywhere ------------------------------------
test('KNOWN-BAD 4: every hub response carries X-Robots-Tag noindex, including robots.txt and the 404s', async (t) => {
  const s = await serve(loadDashboard({ ...ON, VENUE_HUB_PREVIEW: '0' }), t);
  for (const p of ['/', '/garden/b', '/robots.txt', '/sitemap.xml', '/thanks', '/industrial', '/nope', '/api/spend']) {
    const r = await request(s, p, { headers: { host: PUBLIC } });
    assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow', p);
  }
  const prev = await request(s, '/hub/', { headers: { host: DASH, cookie: sessionCookie() } });
  assert.equal(prev.headers['x-robots-tag'], 'noindex, nofollow', 'the preview');
});

// ---- KNOWN-BAD 5: a hub error stays in the hub ---------------------------
test('KNOWN-BAD 5: a thrown hub error is a 500 for that request, and the next dashboard request succeeds', async (t) => {
  const themes = structuredClone(THEMES);
  Object.defineProperty(themes.find((x) => x.slug === 'garden'), 'promise', { get() { throw new Error('boom'); } });
  const logs = [];
  const hub = createHubRouter({ env: ON, appOpts: { themes }, log: (m) => logs.push(m) });
  const { pageGate } = require('../middleware/page-gate');
  const a = express();
  a.use(hub.publicHosts);
  a.use(pageGate);
  a.use('/hub', hub.preview);
  a.get('/api/ping', (req, res) => res.json({ ok: true }));
  const s = await serve(a, t);
  const bad = await request(s, '/garden/b', { headers: { host: PUBLIC } });
  assert.equal(bad.status, 500);
  assert.ok(!bad.body.includes('boom'), 'the error text reached the visitor');
  const badPrev = await request(s, '/hub/garden/b', { headers: { host: DASH, cookie: sessionCookie() } });
  assert.equal(badPrev.status, 500);
  const next = await request(s, '/api/ping', { headers: { host: DASH, cookie: sessionCookie() } });
  assert.equal(next.status, 200, 'the dashboard died with the hub');
  assert.equal((await request(s, '/', { headers: { host: PUBLIC } })).status, 200, 'one bad page took the hub home with it');
});

test('…and a hub that refuses to start (prod portal) leaves the hub OFF and the dashboard running', async (t) => {
  const logs = [];
  const hub = createHubRouter({ env: { ...ON, VENUE_HUB_HUBSPOT_PORTAL: '49701209' }, log: (m) => logs.push(m) });
  assert.equal(hub.enabled, false);
  assert.ok(logs.some((m) => /49701209 is refused/.test(m)));
  const s = await serve(loadDashboard({ ...ON, VENUE_HUB_HUBSPOT_PORTAL: '49701209' }), t);
  assertDead(await request(s, '/', { headers: { host: PUBLIC } }), 'public home with a refused hub');
  const spend = await request(s, '/api/spend', { headers: { host: DASH, cookie: sessionCookie() } });
  assert.equal(spend.status, 200, 'a bad hub env took the dashboard down');
});

// ---- KNOWN-BAD 6: isolation, structurally --------------------------------
test('KNOWN-BAD 6: the hub never reads sessions, staff tables, the DB or the GA4 credential', () => {
  const dir = path.join(__dirname, '..', 'hub');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js')) files.push(f);
    }
  };
  walk(dir);
  for (const f of files) {
    // Comments are stripped: they may NAME what is never read. A `//` after a
    // colon (a URL in a string) is kept.
    const src = fs.readFileSync(f, 'utf8').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const bad of [/require\([^)]*(db|page-gate|sso|fleet|auth|pg)['"]\)/, /GA4_CREDENTIALS_JSON/, /JWT_SECRET/, /DATABASE_URL/,
      /HUBSPOT_TOKEN/, /ANTHROPIC_API_KEY/, /mkt_session/, /sessionUser/, /\bstaff\b/i, /fleetClient/]) {
      assert.ok(!bad.test(src), `${path.relative(dir, f)} matches ${bad}`);
    }
  }
});

test('the public router is mounted FIRST in server.js, above fleetGate, express.json and pageGate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
  const pub = src.indexOf('app.use(hubRouter.publicHosts)');
  const prev = src.indexOf("app.use('/hub', hubRouter.preview)");
  for (const [name, at] of [['express.json', src.indexOf('app.use(express.json')], ['fleetGate', src.indexOf('app.use(fleetGate)')], ['pageGate', src.indexOf('app.use(pageGate)')]]) {
    assert.ok(pub > -1 && at > -1 && pub < at, `the public router sits below ${name}`);
  }
  assert.ok(prev > src.indexOf('app.use(pageGate)'), 'the preview sits above the gate');
  assert.ok(prev < src.indexOf('express.static'), 'the preview sits below express.static');
});
