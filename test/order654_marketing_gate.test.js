'use strict';
// ORDER #654 — KNOWN-BADS FOR THE MARKETING DASHBOARD GATE. RED #1 of #653.
//
// Same discipline as #652: the tests that matter are the refusals, and the one
// that matters most is structural -- a route written next week is gated by
// default. Amendment A adds a second: a cold NAVIGATE to the page is refused,
// not just the API, because express.static served index.html before any gate
// could run.
//
// Nothing here touches the live service: an express app is built in memory with
// the same middleware ORDER and driven over loopback. No production, no real
// secret.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const SECRET = 'test-only-not-a-real-secret';
process.env.JWT_SECRET = SECRET;

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const FLEET_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'fleet.js'), 'utf8');

const SESSION_COOKIE = 'mkt_session';
const OPEN_PATHS = new Set(['/api/login', '/health', '/.well-known/agent-contract', '/api/contract']);

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
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch (e) { return null; }
}

let AI_CALLS = 0;

function build() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (/^Bearer\s+mkt_/.test(String(req.headers.authorization || ''))) req.fleetClient = { id: 1 };
    next();
  });
  app.post('/api/login', (req, res) => {
    if ((req.body || {}).password !== 'right') return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax');
    res.json({ token });
  });
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path)) return next();
    if (req.fleetClient) return next();
    if (sessionUser(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.status(401).type('html').send('<h1>sign in</h1>');
  });
  app.get('/', (req, res) => res.type('html').send('<h1>THE DASHBOARD</h1>'));
  app.get('/settings/api-tokens', (req, res) => res.type('html').send('<h1>token minter</h1>'));
  app.post('/api/ai/narrative', (req, res) => { AI_CALLS += 1; res.json({ ok: true }); });
  app.post('/api/hubspot/search', (req, res) => res.json({ ok: true }));
  app.get('/api/spend', (req, res) => res.json({ ok: true }));
  app.post('/api/a-route-added-next-week', (req, res) => res.json({ ok: true }));
  return app;
}

let server, base;
function req(method, p, o) {
  o = o || {};
  return new Promise((resolve) => {
    const u = new URL(base + p);
    const headers = {};
    if (o.cookie) headers.Cookie = o.cookie;
    if (o.auth) headers.Authorization = o.auth;
    if (o.body) headers['Content-Type'] = 'application/json';
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    if (o.body) r.write(JSON.stringify(o.body));
    r.end();
  });
}

test('setup', async () => {
  await new Promise((r) => { server = http.createServer(build()).listen(0, '127.0.0.1', () => {
    base = 'http://127.0.0.1:' + server.address().port; r();
  }); });
});

test('KNOWN-BAD: anonymous POST /api/ai/narrative is REFUSED (the money surface)', async () => {
  AI_CALLS = 0;
  const r = await req('POST', '/api/ai/narrative', { body: { prompt: 'hello' } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(AI_CALLS, 0, 'the AI call must never have run');
});

test('KNOWN-BAD: anonymous GET /settings/api-tokens is REFUSED (the token minter)', async () => {
  const r = await req('GET', '/settings/api-tokens');
  assert.strictEqual(r.status, 401);
  assert.ok(!/token minter/.test(r.body));
});

test('KNOWN-BAD (Amendment A): a cold NAVIGATE to the dashboard page is refused', async () => {
  const r = await req('GET', '/');
  assert.strictEqual(r.status, 401);
  assert.ok(!/THE DASHBOARD/.test(r.body), 'index.html must not reach an anonymous visitor');
  assert.ok(/sign in/i.test(r.body), 'and they land on a sign-in wall, not a bare error');
});

test('KNOWN-BAD: anonymous CRM search and spend are refused', async () => {
  assert.strictEqual((await req('POST', '/api/hubspot/search', { body: {} })).status, 401);
  assert.strictEqual((await req('GET', '/api/spend')).status, 401);
});

test('KNOWN-BAD: a route added next week, with no decorator, is gated anyway', async () => {
  assert.strictEqual((await req('POST', '/api/a-route-added-next-week', { body: {} })).status, 401);
});

test('KNOWN-BAD: a forged or expired token is refused', async () => {
  const forged = jwt.sign({ role: 'admin' }, 'a-different-secret');
  assert.strictEqual((await req('GET', '/api/spend', { auth: 'Bearer ' + forged })).status, 401);
  const expired = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: -10 });
  assert.strictEqual((await req('GET', '/api/spend', { cookie: SESSION_COOKIE + '=' + expired })).status, 401);
});

test('the login route is reachable anonymously -- gating the door locks everyone out', async () => {
  assert.strictEqual((await req('POST', '/api/login', { body: { password: 'wrong' } })).status, 401);
  const ok = await req('POST', '/api/login', { body: { password: 'right' } });
  assert.strictEqual(ok.status, 200);
  assert.ok(/mkt_session=/.test(String(ok.headers['set-cookie'])), 'login must set the session cookie');
});

test('a browser NAVIGATION works on the cookie alone -- it cannot send a header', async () => {
  const login = await req('POST', '/api/login', { body: { password: 'right' } });
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  const page = await req('GET', '/', { cookie });
  assert.strictEqual(page.status, 200);
  assert.ok(/THE DASHBOARD/.test(page.body));
});

test('the existing Bearer-header path still works, unchanged', async () => {
  const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '12h' });
  assert.strictEqual((await req('GET', '/api/spend', { auth: 'Bearer ' + token })).status, 200);
});

test('a validated fleet token still reads, per the Fleet Contract', async () => {
  assert.strictEqual((await req('GET', '/api/spend', { auth: 'Bearer mkt_abc' })).status, 200);
});

test('/health stays open for the platform probe', async () => {
  assert.strictEqual((await req('GET', '/health')).status, 200);
});

test('server.js mounts the gate ABOVE express.static -- the page, not just the API', () => {
  const gate = SRC.indexOf('ORDER #654');
  const st = SRC.indexOf("app.use(express.static(path.join(__dirname, 'public')))");
  assert.ok(gate !== -1 && st !== -1);
  assert.ok(gate < st, 'a gate below express.static would serve index.html to anyone');
});

test('server.js reads identity from a header OR a cookie', () => {
  assert.ok(/req\.headers\.authorization/.test(SRC) && /req\.headers\.cookie/.test(SRC));
});

test('the open-path list in server.js is the one tested here', () => {
  for (const p of OPEN_PATHS) assert.ok(SRC.includes("'" + p + "'"), p + ' must be open in server.js');
});

test('login sets the cookie in routes/fleet.js', () => {
  assert.ok(/mkt_session/.test(FLEET_SRC) && /HttpOnly|httpOnly/.test(FLEET_SRC));
});

test('no new dependency was added', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(!(pkg.dependencies || {})['cookie-parser'], 'the cookie is read off req.headers.cookie on purpose');
});

test('teardown', () => { server.close(); });
