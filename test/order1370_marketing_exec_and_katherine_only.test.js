'use strict';
// ORDER #1370: KNOWN-BADS FOR "EXEC ONLY AND KATHERINE".
//
// Mimi, 10.06.2026: "any signed in staff should not be able to reach the
// marketing dashboard, its exec only and katherine."
//
// Driven through the REAL gate and the REAL sign-in route on an Express app,
// with one stand-in route behind the gate per surface (server.js listens on
// require, so it cannot be mounted here; #654's test makes the same choice).
// Dispatch is never called: global.fetch is replaced, so there is no network.
// No figure from the spend data appears in this file.
//
// Requires only files that exist on main, so every known-bad below can be run
// against main and seen red there.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';
process.env.DISPATCH_JWT_SECRET = 'dispatch-test-secret-not-real';
process.env.DISPATCH_BRIDGE_TOKEN = 'test-only-bridge-token';
process.env.MARKETING_ADMIN_PASSWORD = 'test-only-password';
delete process.env.DATABASE_URL;

const { pageGate } = require('../middleware/page-gate');
const fleet = require('../routes/fleet');

const SECRET = process.env.JWT_SECRET;
const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const KATHERINE = 'person_57d0eb01e923';
const SPEND_MARKER = 'SPEND-PAYLOAD-STAND-IN';

// ---- Dispatch, faked: one answer per email --------------------------------
const PEOPLE = {
  'exec@infinityhospitality.net':      { active: true, person_id: 'person_exec0001', rung: 3, bundle: 'Exec' },
  'katherine@infinityhospitality.net': { active: true, person_id: KATHERINE, rung: 2, bundle: 'Marketing' },
  'marketing2@infinityhospitality.net': { active: true, person_id: 'person_mkt00002', rung: 2, bundle: 'Marketing' },
  'staff@infinityhospitality.net':     { active: true, person_id: 'person_staff001', rung: 1, bundle: null },
  'samename@infinityhospitality.net':  { active: true, person_id: 'person_other001', canonical_name: 'Katherine Howe', rung: 2 },
};
const CALLS = [];
let DOWN = false;
global.fetch = async (url) => {
  CALLS.push(String(url));
  if (DOWN) throw new Error('dispatch down (test)');
  const email = decodeURIComponent(String(url).split('email=')[1] || '');
  const body = PEOPLE[email] || { active: false, person_id: null, rung: null };
  return { ok: true, status: 200, json: async () => body };
};

function app() {
  const a = express();
  a.use(express.json());
  a.use(pageGate);
  a.use('/', fleet);
  a.get('/api/spend', (req, res) => res.json({ marker: SPEND_MARKER }));
  a.get('/api/ga4/summary', (req, res) => res.json({ marker: SPEND_MARKER }));
  a.use((req, res) => res.status(200).send('THE DASHBOARD'));
  return a;
}
function serve(t) {
  return new Promise(resolve => {
    const s = http.createServer(app()).listen(0, () => {
      t.after(() => new Promise(r => s.close(r)));
      resolve(s);
    });
  });
}
function call(server, urlPath, { method = 'GET', headers = {}, body } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {});
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const cookies = r => [].concat(r.headers['set-cookie'] || []);
const sessionSet = r => cookies(r).find(c => c.startsWith('mkt_session=') && !c.startsWith('mkt_session=;'));
const sessionCookieOf = r => sessionSet(r).split(';')[0];
function dispatchToken(email) {
  return jwt.sign({ email, name: email }, process.env.DISPATCH_JWT_SECRET, { expiresIn: '2m' });
}
async function signIn(s, email) {
  return call(s, '/api/auth/sso', { method: 'POST', body: { token: dispatchToken(email) } });
}
// A session this app minted at some point in the past, with whatever claims.
function oldSession(claims, ageSec) {
  const iat = Math.floor(Date.now() / 1000) - ageSec;
  return 'mkt_session=' + encodeURIComponent(jwt.sign(Object.assign({ iat }, claims), SECRET, { expiresIn: 30 * DAY }));
}
const noData = r => !r.body.includes(SPEND_MARKER) && !r.body.includes('THE DASHBOARD');

// ---- KNOWN-BAD 1: signed-in staff who are not exec or Katherine ----------------
test('KNOWN-BAD: a non-exec staffer\'s Infinity sign-in is refused, 403, no session (on main: 200 and a cookie)', async (t) => {
  const s = await serve(t);
  for (const email of ['staff@infinityhospitality.net', 'marketing2@infinityhospitality.net']) {
    const r = await signIn(s, email);
    assert.strictEqual(r.status, 403, email);
    assert.strictEqual(sessionSet(r), undefined, 'no session for ' + email);
    assert.match(r.body, /Marketing leadership/);
  }
});

test('KNOWN-BAD: a staffer\'s session from before #1370 gets no spend and no page (on main: 200)', async (t) => {
  const s = await serve(t);
  const legacy = oldSession({ role: 'sso', email: 'staff@infinityhospitality.net', name: 'Staff' }, 2 * HOUR);
  const api = await call(s, '/api/spend', { headers: { cookie: legacy } });
  assert.notStrictEqual(api.status, 200);
  assert.ok(noData(api), 'no spend data in the refusal');
  const page = await call(s, '/', { headers: { cookie: legacy } });
  assert.notStrictEqual(page.status, 200);
  assert.ok(noData(page), 'no dashboard in the refusal');
  // and the Bearer spelling of the same token is no different
  const tok = decodeURIComponent(legacy.slice('mkt_session='.length));
  const bearer = await call(s, '/api/spend', { headers: { authorization: 'Bearer ' + tok } });
  assert.notStrictEqual(bearer.status, 200);
  assert.ok(noData(bearer));
});

test('KNOWN-BAD: a staffer who is no longer exec is refused at renewal, 403 page and 403 API (on main: renewed)', async (t) => {
  const s = await serve(t);
  CALLS.length = 0;
  const demoted = oldSession({ role: 'sso', email: 'marketing2@infinityhospitality.net', name: 'M2', mkt_access: true }, 13 * HOUR);
  const api = await call(s, '/api/spend', { headers: { cookie: demoted } });
  assert.strictEqual(api.status, 403);
  assert.ok(noData(api));
  assert.ok(cookies(api).some(c => c.startsWith('mkt_session=;') && /Max-Age=0/.test(c)), 'the session is cleared');
  const page = await call(s, '/', { headers: { cookie: demoted } });
  assert.strictEqual(page.status, 403);
  assert.match(page.body, /This dashboard is for Marketing leadership/);
  assert.ok(noData(page));
  assert.ok(CALLS.length >= 2, 'Dispatch was asked');
});

// ---- KNOWN-BAD 2: the shared password -----------------------------------------
test('KNOWN-BAD: the marketing password mints nothing, right or wrong (on main: 200 and a cookie)', async (t) => {
  const s = await serve(t);
  for (const password of ['test-only-password', 'wrong']) {
    const r = await call(s, '/api/login', { method: 'POST', body: { password } });
    assert.strictEqual(r.status, 410);
    assert.strictEqual(sessionSet(r), undefined);
    assert.ok(!/"token"/.test(r.body), 'no token in the body either');
  }
});

test('KNOWN-BAD: a password session already in a browser opens nothing (on main: 200)', async (t) => {
  const s = await serve(t);
  const pw = oldSession({ role: 'admin', name: 'marketing-admin' }, 1 * HOUR);
  const api = await call(s, '/api/spend', { headers: { cookie: pw } });
  assert.strictEqual(api.status, 401);
  assert.ok(noData(api));
  const page = await call(s, '/', { headers: { cookie: pw } });
  assert.strictEqual(page.status, 302, 'sent back through Infinity sign-in');
  assert.ok(cookies(page).some(c => c.startsWith('mkt_session=;')), 'and the password cookie is cleared');
  const tok = decodeURIComponent(pw.slice('mkt_session='.length));
  assert.strictEqual((await call(s, '/api/spend', { headers: { authorization: 'Bearer ' + tok } })).status, 401);
});

test('the sign-in wall has no password box any more', async (t) => {
  const { SIGN_IN_PAGE } = require('../middleware/page-gate');
  assert.ok(!/type="password"/.test(SIGN_IN_PAGE));
  assert.ok(!/\/api\/login/.test(SIGN_IN_PAGE));
});

// ---- Katherine by person id, never by name -------------------------------------
test('KNOWN-BAD: someone else carrying Katherine\'s NAME is refused; only her person id opens it', async (t) => {
  const s = await serve(t);
  const r = await signIn(s, 'samename@infinityhospitality.net');
  assert.strictEqual(r.status, 403);
  assert.strictEqual(sessionSet(r), undefined);
});

// ---- the two who may ----------------------------------------------------------
test('Katherine and an exec sign in, and get the page and /api/spend (200)', async (t) => {
  const s = await serve(t);
  for (const email of ['katherine@infinityhospitality.net', 'exec@infinityhospitality.net']) {
    const r = await signIn(s, email);
    assert.strictEqual(r.status, 200, email);
    const cookie = sessionCookieOf(r);
    const claims = jwt.decode(decodeURIComponent(cookie.slice('mkt_session='.length)));
    assert.strictEqual(claims.mkt_access, true);
    const api = await call(s, '/api/spend', { headers: { cookie } });
    assert.strictEqual(api.status, 200, email + ' /api/spend');
    assert.ok(api.body.includes(SPEND_MARKER));
    const page = await call(s, '/', { headers: { cookie } });
    assert.strictEqual(page.status, 200, email + ' page');
  }
});

test('Katherine\'s and an exec\'s 2-day-old sessions are renewed, not refused', async (t) => {
  const s = await serve(t);
  for (const email of ['katherine@infinityhospitality.net', 'exec@infinityhospitality.net']) {
    const old = oldSession({ role: 'sso', email, name: email, mkt_access: true }, 2 * DAY);
    const r = await call(s, '/api/spend', { headers: { cookie: old } });
    assert.strictEqual(r.status, 200, email);
    assert.ok(sessionSet(r), 'renewed');
  }
});

// ---- fails CLOSED ----------------------------------------------------------------
test('KNOWN-BAD: Dispatch down at sign-in mints no session (503), it never guesses yes', async (t) => {
  const s = await serve(t);
  DOWN = true;
  t.after(() => { DOWN = false; });
  const r = await signIn(s, 'exec@infinityhospitality.net');
  assert.strictEqual(r.status, 503);
  assert.strictEqual(sessionSet(r), undefined);
});

test('KNOWN-BAD: with no DISPATCH_BRIDGE_TOKEN nobody gets a session (503)', async (t) => {
  const saved = process.env.DISPATCH_BRIDGE_TOKEN;
  delete process.env.DISPATCH_BRIDGE_TOKEN;
  t.after(() => { process.env.DISPATCH_BRIDGE_TOKEN = saved; });
  const s = await serve(t);
  const r = await signIn(s, 'exec@infinityhospitality.net');
  assert.strictEqual(r.status, 503);
  assert.strictEqual(sessionSet(r), undefined);
});

// ---- the token page signs in through Infinity like everything else ------------
test('the token page and its API answer an allowed person with no password step', async (t) => {
  const s = await serve(t);
  const cookie = sessionCookieOf(await signIn(s, 'exec@infinityhospitality.net'));
  // no DATABASE_URL here, so the token store answers 503; what matters is it
  // got PAST both gates (401/403 would mean it did not).
  const list = await call(s, '/api/tokens', { headers: { cookie } });
  assert.strictEqual(list.status, 503);
  const anon = await call(s, '/api/tokens');
  assert.strictEqual(anon.status, 401);
});
