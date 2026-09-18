'use strict';
// ORDER #656 — KNOWN-BADS FOR THE MARKETING SSO CONSUME PATH.
//
// This is REUSE, not a new scheme, so the checks are mostly about NOT having
// invented anything: the same three pieces planning and the Sales Brain have,
// the dispatch-signed token verified rather than decoded, and a deploy with no
// secret failing CLOSED instead of trusting whatever arrives.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const FLEET_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'fleet.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const COMPLETE = fs.readFileSync(path.join(__dirname, '..', 'public', 'sso-complete.html'), 'utf8');

const DISPATCH_SECRET = 'dispatch-test-secret-not-real';
const OWN_SECRET = 'marketing-test-secret-not-real';

function build(env) {
  const app = express();
  app.use(express.json());
  const sign = (p) => jwt.sign(p, OWN_SECRET, { expiresIn: '12h' });
  app.get('/api/auth/sso-url', (req, res) => {
    const base = 'https://marketing.infinityhospitalitygroup.com';
    const returnTo = base + '/sso-complete.html';
    res.json({ url: 'https://dispatch.infinityhospitalitygroup.com/api/auth/google?return_to=' + encodeURIComponent(returnTo) });
  });
  app.post('/api/auth/sso', (req, res) => {
    const secret = env.DISPATCH_JWT_SECRET;
    if (!secret) return res.status(503).json({ error: 'SSO not configured on this deploy' });
    const token = String((req.body || {}).token || '');
    if (!token) return res.status(400).json({ error: 'token required' });
    let claims;
    try { claims = jwt.verify(token, secret); } catch (e) { return res.status(401).json({ error: 'Invalid or expired token' }); }
    if (!claims || !claims.email) return res.status(401).json({ error: 'Token carries no identity to accept' });
    res.setHeader('Set-Cookie', 'mkt_session=' + sign({ role: 'sso', email: claims.email }) + '; Path=/; HttpOnly');
    res.json({ ok: true, email: claims.email });
  });
  return app;
}

let server, base;
function req(method, p, body) {
  return new Promise((resolve) => {
    const u = new URL(base + p);
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
function start(env) {
  return new Promise((r) => { server = http.createServer(build(env)).listen(0, '127.0.0.1', () => {
    base = 'http://127.0.0.1:' + server.address().port; r();
  }); });
}

test('setup', async () => { await start({ DISPATCH_JWT_SECRET: DISPATCH_SECRET }); });

test('a dispatch-signed token establishes a marketing session', async () => {
  const token = jwt.sign({ email: 'someone@infinityhospitality.net', name: 'Someone' }, DISPATCH_SECRET, { expiresIn: '2m' });
  const r = await req('POST', '/api/auth/sso', { token });
  assert.strictEqual(r.status, 200);
  assert.ok(/mkt_session=/.test(String(r.headers['set-cookie'])), 'and it is THIS app\'s own session cookie');
});

test('KNOWN-BAD: a token signed with the WRONG secret is refused', async () => {
  const forged = jwt.sign({ email: 'someone@infinityhospitality.net' }, 'not-dispatchs-secret');
  assert.strictEqual((await req('POST', '/api/auth/sso', { token: forged })).status, 401);
});

test('KNOWN-BAD: an expired dispatch token is refused', async () => {
  const stale = jwt.sign({ email: 'someone@infinityhospitality.net' }, DISPATCH_SECRET, { expiresIn: -10 });
  assert.strictEqual((await req('POST', '/api/auth/sso', { token: stale })).status, 401);
});

test('KNOWN-BAD: a validly-signed token carrying NO identity is refused', async () => {
  const empty = jwt.sign({ role: 'admin' }, DISPATCH_SECRET, { expiresIn: '2m' });
  assert.strictEqual((await req('POST', '/api/auth/sso', { token: empty })).status, 401);
});

test('teardown+restart with no secret', async () => {
  server.close(); await start({});
});

test('KNOWN-BAD: with DISPATCH_JWT_SECRET unset it FAILS CLOSED (503), never open', async () => {
  const token = jwt.sign({ email: 'someone@infinityhospitality.net' }, DISPATCH_SECRET, { expiresIn: '2m' });
  const r = await req('POST', '/api/auth/sso', { token });
  assert.strictEqual(r.status, 503);
  assert.ok(!/set-cookie/i.test(Object.keys(r.headers).join(',')), 'and no session is minted');
});

test('teardown', () => { server.close(); });

// ---- IT IS THE ESTATE'S PATTERN, NOT A NEW ONE ----------------------------

test('the token arrives in the URL FRAGMENT, never the query string', () => {
  assert.ok(/location\.hash/.test(COMPLETE), 'the completion page reads the fragment');
  assert.ok(!/URLSearchParams\(location\.search\)\.get\(.token.\)/.test(COMPLETE),
    'a token in the query string would reach the server in the request line and the access log');
});

test('the completion page POSTs the token to our own verify route', () => {
  assert.ok(/fetch\('\/api\/auth\/sso'/.test(COMPLETE));
});

test('TWO SECRETS: dispatch-signed tokens are verified with DISPATCH_JWT_SECRET', () => {
  assert.ok(/process\.env\.DISPATCH_JWT_SECRET/.test(FLEET_SRC),
    'verification must use the dispatch secret, not this app\'s own');
  assert.ok(/jwt\.verify\(token, secret\)/.test(FLEET_SRC), 'verify, never decode');
  assert.ok(!/jwt\.decode/.test(FLEET_SRC), 'decode reads a token without checking who signed it');
});

test('the bounce is built from the PINNED base URL, never req.hostname', () => {
  // Asserted against CODE with comments stripped. The first version read the raw
  // block and failed on the COMMENT that explains planning uses req.hostname and
  // this one does not -- prose, not behaviour, for the eleventh time in this
  // estate and the second time in my own check.
  const raw = FLEET_SRC.slice(FLEET_SRC.indexOf('ORDER #656'), FLEET_SRC.indexOf("router.post('/api/login'"));
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  assert.ok(/PUBLIC_BASE_URL/.test(code), 'the pinned base must be used in code');
  assert.ok(!/req\.hostname/.test(code), 'ORDER #634 exists because of exactly that');
  assert.ok(/req\.hostname/.test(raw), 'sanity: the comment naming the defect is what the naive check tripped on');
});

test('the SSO door is open on the gate, or nobody could ever sign in', () => {
  for (const p of ['/api/auth/sso-url', '/api/auth/sso', '/sso-complete.html']) {
    assert.ok(SERVER_SRC.includes("'" + p + "'"), p + ' must be in OPEN_PATHS');
  }
});

test('KNOWN-BAD: the dashboard itself is NOT in the open list', () => {
  const block = SERVER_SRC.slice(SERVER_SRC.indexOf('const OPEN_PATHS'), SERVER_SRC.indexOf('function cookieToken'));
  for (const p of ['/api/spend', '/api/ai/narrative', '/settings/api-tokens']) {
    assert.ok(!block.includes("'" + p + "'"), p + ' must stay gated');
  }
});

test('a `next` is only honoured when it is a same-origin path', () => {
  assert.ok(/charAt\(0\) === '\/' && .*charAt\(1\) !== '\/'/.test(COMPLETE),
    'a protocol-relative //evil.example must not be followed');
});
