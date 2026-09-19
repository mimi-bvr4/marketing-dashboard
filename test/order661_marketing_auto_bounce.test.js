'use strict';
// ORDER #661 — KNOWN-BADS FOR THE AUTOMATIC BOUNCE.
//
// WHAT MIMI SAW, and it is the only acceptance test that matters: signed in to
// dispatch, clicked Marketing in the Hub, landed on a wall telling her to use
// the Hub button she had just used. Her ruling: "it should go straight to the
// marketing." So these checks are mostly about what a PERSON sees, driven
// through the REAL middleware on a real Express app -- not a re-implementation
// of it, which is how REPLY #657 §5's test came to grade its own copy.
//
// The order names four (item 4), each seen failing:
//   1. an anonymous page GET redirects to dispatch with the right return_to
//      and next
//   2. /api/* still 401s and never redirects
//   3. a refused return does not re-bounce -- the wall is shown once
//   4. the sign-in page itself never redirects
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const { pageGate, OPEN_PATHS, SIGN_IN_PAGE } = require('../middleware/page-gate');
const sso = require('../lib/sso');

// One app, the real gate, one route behind it that says "you got through".
function app() {
  const a = express();
  a.use(pageGate);
  a.use((req, res) => res.status(200).send('BEHIND THE GATE'));
  return a;
}

// Drive it without a socket: express apps are (req,res) handlers, but the gate
// needs express's res.redirect/res.type, so a real listener is simplest.
const http = require('node:http');
// The server is closed via the test context, NOT by a trailing s.close():
// a failing assertion throws past that line, the handle stays open, and
// `node --test` waits forever. Found while mutation-testing this very file --
// the first mutation run produced no output at all because a deliberately
// broken guard left a listener behind. A test harness that hangs on failure
// reports nothing, which is indistinguishable from every guard holding.
function serve(a, t) {
  return new Promise(resolve => {
    const s = http.createServer(a).listen(0, () => {
      if (t && t.after) t.after(() => new Promise(r => s.close(r)));
      resolve(s);
    });
  });
}
async function get(server, urlPath, headers = {}, method = 'GET') {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- KNOWN-BAD 1: the anonymous page GET goes straight to dispatch --------
test('KNOWN-BAD 1: an anonymous page GET is redirected to dispatch, not walled', async (t) => {
  const s = await serve(app(), t);
  const r = await get(s, '/');
  assert.strictEqual(r.status, 302, 'a person still saw a wall instead of being bounced');
  assert.ok(r.headers.location.startsWith('https://dispatch.infinityhospitalitygroup.com/api/auth/google?return_to='),
            'the redirect does not point at dispatch: ' + r.headers.location);
});

test('…the return_to is THIS app pinned, never the requested host (ORDER #634)', async (t) => {
  const s = await serve(app(), t);
  const r = await get(s, '/', { host: 'marketing-dashboard-production-6a39.up.railway.app' });
  const returnTo = decodeURIComponent(new URL(r.headers.location).searchParams.get('return_to'));
  assert.ok(returnTo.startsWith('https://marketing.infinityhospitalitygroup.com/sso-complete.html'), returnTo);
  assert.ok(!returnTo.includes('railway.app'), 'the return_to took the host off the request');
});

test('KNOWN-BAD 1b: the page they asked for is carried as `next`', async (t) => {
  const s = await serve(app(), t);
  const r = await get(s, '/reports?range=30d');
  const returnTo = decodeURIComponent(new URL(r.headers.location).searchParams.get('return_to'));
  const next = decodeURIComponent(new URL(returnTo).searchParams.get('next'));
  assert.strictEqual(next, '/reports?range=30d', 'the person would land on the root, not their page');
});

test('…and an off-origin `next` is dropped rather than carried', () => {
  assert.strictEqual(sso.isSameOriginPath('//evil.example/x'), false);
  assert.strictEqual(sso.isSameOriginPath('https://evil.example/x'), false);
  assert.strictEqual(sso.isSameOriginPath('/ok'), true);
  assert.ok(!sso.ssoBounceUrl('//evil.example/x').includes('evil.example'));
});

// ---- KNOWN-BAD 2: /api/* still 401s, never redirects ---------------------
test('KNOWN-BAD 2: an anonymous /api/* call still 401s as JSON and never redirects', async (t) => {
  const s = await serve(app(), t);
  for (const p of ['/api/spend', '/api/ga4/summary', '/api/hubspot/search']) {
    const r = await get(s, p);
    assert.strictEqual(r.status, 401, p + ' did not 401');
    assert.strictEqual(r.headers.location, undefined, p + ' was redirected — an XHR cannot follow that');
    assert.ok(r.body.includes('Not authenticated'));
  }
});

// ---- KNOWN-BAD 3: a refused return does not re-bounce --------------------
test('KNOWN-BAD 3: the second cold arrival in a row gets the wall, not a loop', async (t) => {
  const s = await serve(app(), t);
  const first = await get(s, '/');
  assert.strictEqual(first.status, 302);
  const setCookie = String(first.headers['set-cookie']);
  assert.ok(setCookie.includes(sso.BOUNCE_MARKER), 'no marker was set, so the next arrival loops');
  const second = await get(s, '/', { cookie: sso.BOUNCE_MARKER + '=1' });
  assert.strictEqual(second.status, 401, 'it bounced again — this is the infinite redirect');
  assert.ok(second.body.includes('Marketing Dashboard'));
});

test('…and the marker is read off the RAW Cookie header (this app mounts no parser)', () => {
  assert.strictEqual(sso.hasBounceMarker({ headers: { cookie: 'a=1; mkt_sso_tried=1; b=2' } }), true);
  assert.strictEqual(sso.hasBounceMarker({ headers: { cookie: 'a=1; b=2' } }), false);
  assert.strictEqual(sso.hasBounceMarker({ headers: {} }), false);
  assert.strictEqual(sso.hasBounceMarker({}), false);
});

test('…and the SSO success path EXPIRES the marker, so the guard is self-healing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'fleet.js'), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(/BOUNCE_MARKER \+ '=; Path=\/; Max-Age=0/.test(src),
            'nothing clears the marker; one refused sign-in walls the person for its whole lifetime');
});

// ---- KNOWN-BAD 4: the sign-in page and the SSO pages never redirect ------
test('KNOWN-BAD 4: an open path is never redirected', async (t) => {
  const s = await serve(app(), t);
  for (const p of ['/sso-complete.html', '/api/auth/sso-url', '/api/login', '/health']) {
    const r = await get(s, p);
    assert.strictEqual(r.headers.location, undefined, p + ' was redirected mid-sign-in');
    assert.strictEqual(r.status, 200, p + ' did not reach the app');
  }
});

test('…and a non-GET is never redirected — a redirect would silently drop the body', async (t) => {
  const s = await serve(app(), t);
  const r = await get(s, '/some-form', {}, 'POST');
  assert.strictEqual(r.headers.location, undefined);
  assert.strictEqual(r.status, 401);
});

// ---- the gate still does what #654 built it for -------------------------
test('a valid session still gets through, by cookie and by bearer', async (t) => {
  const s = await serve(app(), t);
  const tok = jwt.sign({ role: 'sso', email: 'x@y.z' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const byCookie = await get(s, '/', { cookie: 'mkt_session=' + encodeURIComponent(tok) });
  assert.strictEqual(byCookie.status, 200);
  assert.strictEqual(byCookie.body, 'BEHIND THE GATE');
  const byBearer = await get(s, '/', { authorization: 'Bearer ' + tok });
  assert.strictEqual(byBearer.status, 200);
});

test('a FORGED session is still refused — and now it bounces rather than walls', async (t) => {
  const s = await serve(app(), t);
  const forged = jwt.sign({ role: 'sso' }, 'not-the-secret', { expiresIn: '1h' });
  const r = await get(s, '/', { cookie: 'mkt_session=' + encodeURIComponent(forged) });
  assert.strictEqual(r.status, 302);
  assert.ok(r.headers.location.includes('/api/auth/google'));
});

test('the gate is still mounted ABOVE express.static — the property #654 exists for', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  const gateAt = src.indexOf('app.use(pageGate)');
  const staticAt = src.indexOf('express.static');
  assert.ok(gateAt > -1 && staticAt > -1);
  assert.ok(gateAt < staticAt, 'express.static would serve index.html before any check ran');
});

// ---- ORDER #661 item 3: the copy ----------------------------------------
test('item 3: the wall no longer tells people to use the Hub button, and has no em dash', () => {
  assert.ok(!SIGN_IN_PAGE.includes('Hub button'),
            'the wall still tells a person to do the thing that just failed');
  assert.ok(!SIGN_IN_PAGE.includes('—'), 'the wall still carries an em dash');
  assert.ok(SIGN_IN_PAGE.includes('Continue with Infinity'), 'the button itself must stay');
});

test('there is ONE bounce builder, and the route uses it rather than its own string', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'fleet.js'), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(/ssoBounceUrl\(req\.query\.next\)/.test(src));
  assert.ok(!/api\/auth\/google\?return_to=/.test(src),
            'fleet.js builds its own bounce string again — that is a second scheme');
});
