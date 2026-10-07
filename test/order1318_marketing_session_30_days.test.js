'use strict';
// ORDER #1318: KNOWN-BADS FOR HOW LONG A MARKETING SIGN-IN LASTS (#933's shape).
//
// REPLY #1314: /api/auth/sso minted a fixed 12-hour mkt_session that nothing
// renewed, so the next morning was a Google round trip. Ruled 09.27.2026
// (#927): 30 days, renewing while used, refused once Dispatch marks the person
// inactive.
//
// Driven through the REAL gate and the REAL sign-in route on an Express app.
// Dispatch is never called: global.fetch is replaced, so there is no network.
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
delete process.env.DATABASE_URL;

const { pageGate } = require('../middleware/page-gate');
const fleet = require('../routes/fleet');

const SECRET = process.env.JWT_SECRET;
const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;

// ---- Dispatch, faked ------------------------------------------------------
const CALLS = [];
let ANSWER = { status: 200, body: { active: true }, throws: false };
global.fetch = async (url, opts) => {
  CALLS.push({ url: String(url), headers: (opts && opts.headers) || {} });
  if (ANSWER.throws) throw new Error('dispatch down (test)');
  return { ok: ANSWER.status === 200, status: ANSWER.status, json: async () => ANSWER.body };
};
function answer(a) { ANSWER = Object.assign({ status: 200, body: { active: true }, throws: false }, a || {}); CALLS.length = 0; }

function app() {
  const a = express();
  a.use(express.json());
  a.use(pageGate);
  a.use('/', fleet);
  a.use((req, res) => res.status(200).send('BEHIND THE GATE'));
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
// An SSO session that is `ageSec` old and still inside its own expiry.
// ORDER #1370: an SSO session is only ever minted after the exec/Katherine
// check, and carries mkt_access to say so. Dispatch's answers below carry
// rung 3 (exec) wherever the person is meant to be let in.
function ssoCookie(email, ageSec, role = 'sso') {
  const iat = Math.floor(Date.now() / 1000) - ageSec;
  const claims = { role, name: 'Some One', email, iat };
  if (role === 'sso') claims.mkt_access = true;
  const tok = jwt.sign(claims, SECRET, { expiresIn: 30 * DAY });
  return 'mkt_session=' + encodeURIComponent(tok);
}
const EXEC = { active: true, person_id: 'person_exec0001', rung: 3 };
const cookies = r => [].concat(r.headers['set-cookie'] || []);
const sessionSet = r => cookies(r).find(c => c.startsWith('mkt_session=') && !c.startsWith('mkt_session=;'));
const sessionCleared = r => cookies(r).some(c => c.startsWith('mkt_session=;') && /Max-Age=0/.test(c));
const bounced = r => r.status === 302 && String(r.headers.location || '').includes('/api/auth/google');

// ---- KNOWN-BAD 1: a sign-in lasts 30 days, not 12 hours -------------------
test('KNOWN-BAD: an Infinity sign-in lasts 30 days (on main: Max-Age=43200, 12 hours)', async (t) => {
  answer({ body: EXEC });
  const s = await serve(t);
  const tok = jwt.sign({ email: 'someone@infinityhospitality.net', name: 'Some One' }, process.env.DISPATCH_JWT_SECRET, { expiresIn: '2m' });
  const r = await call(s, '/api/auth/sso', { method: 'POST', body: { token: tok } });
  assert.strictEqual(r.status, 200);
  const c = sessionSet(r);
  assert.ok(c, 'no session cookie');
  assert.match(c, /Max-Age=2592000/, 'cookie life: ' + c);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  const claims = jwt.decode(decodeURIComponent(c.split(';')[0].slice('mkt_session='.length)));
  assert.strictEqual(claims.exp - claims.iat, 30 * DAY, 'the JWT and the cookie must agree');
  assert.strictEqual(claims.role, 'sso');
  // ORDER #1370: the sign-in now asks Dispatch once, for the access check.
  assert.strictEqual(CALLS.length, 1, 'the sign-in asks Dispatch exactly once');
  assert.ok(cookies(r).some(x => x.startsWith('mkt_sso_tried=;')), 'the bounce marker is still expired on success');
});

// ---- KNOWN-BAD 2: an inactive person's renewal is refused -----------------
test('KNOWN-BAD: an inactive person\'s 13-hour-old session goes back to Google (on main it opens)', async (t) => {
  answer({ body: { active: false, person_id: null } });
  const s = await serve(t);
  const r = await call(s, '/', { headers: { cookie: ssoCookie('left@infinityhospitality.net', 13 * HOUR) } });
  assert.ok(bounced(r), r.status + ' ' + r.headers.location);
  assert.ok(sessionCleared(r), 'the session cookie is cleared: ' + cookies(r).join(' | '));
  assert.ok(cookies(r).some(x => x.startsWith('mkt_sso_tried=1')), 'the loop guard still rides on the bounce');
  assert.strictEqual(CALLS.length, 1);
  assert.ok(CALLS[0].url.startsWith('https://dispatch.infinityhospitalitygroup.com/api/brain/portal/staff-identity?email=left%40infinityhospitality.net'), CALLS[0].url);
  assert.strictEqual(CALLS[0].headers.Authorization, 'Bearer test-only-bridge-token');
});

test('…and the same session is a 401 on the API, never a redirect', async (t) => {
  answer({ body: { active: false } });
  const s = await serve(t);
  const r = await call(s, '/api/ga4/summary', { headers: { cookie: ssoCookie('left@infinityhospitality.net', 13 * HOUR) } });
  assert.strictEqual(r.status, 401);
});

// ---- an active person renews with no Google step --------------------------
test('an active person\'s 2-day-old session opens and comes back renewed for 30 days', async (t) => {
  answer({ body: EXEC });
  const s = await serve(t);
  const r = await call(s, '/', { headers: { cookie: ssoCookie('someone@infinityhospitality.net', 2 * DAY) } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body, 'BEHIND THE GATE');
  assert.strictEqual(CALLS.length, 1);
  const c = sessionSet(r);
  assert.ok(c, 'no renewed cookie came back');
  assert.match(c, /Max-Age=2592000/);
  const claims = jwt.decode(decodeURIComponent(c.split(';')[0].slice('mkt_session='.length)));
  assert.strictEqual(claims.email, 'someone@infinityhospitality.net');
  assert.strictEqual(claims.role, 'sso');
  assert.ok(Date.now() / 1000 - claims.iat < 60, 'a fresh iat');
});

test('a session under 12 hours makes no Dispatch call and writes no cookie', async (t) => {
  answer();
  const s = await serve(t);
  const r = await call(s, '/', { headers: { cookie: ssoCookie('someone@infinityhospitality.net', 2 * HOUR) } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(CALLS.length, 0);
  assert.strictEqual(sessionSet(r), undefined);
});

test('Dispatch down or answering 500: kept, not renewed, not ended', async (t) => {
  const s = await serve(t);
  for (const a of [{ throws: true }, { status: 500, body: { error: 'bridge error' } }]) {
    answer(a);
    const r = await call(s, '/', { headers: { cookie: ssoCookie('someone@infinityhospitality.net', 2 * DAY) } });
    assert.strictEqual(r.status, 200, JSON.stringify(a));
    assert.strictEqual(sessionSet(r), undefined, 'not renewed');
    assert.ok(!sessionCleared(r), 'not ended');
  }
});

// ---- no bridge token: never 30 days unchecked ------------------------------
// ORDER #1370: with no bridge token the access check cannot run, so the
// sign-in mints nothing at all (it used to mint the 12 hours of main).
test('with no DISPATCH_BRIDGE_TOKEN a sign-in is refused and a 13-hour session ends', async (t) => {
  const saved = process.env.DISPATCH_BRIDGE_TOKEN;
  delete process.env.DISPATCH_BRIDGE_TOKEN;
  t.after(() => { process.env.DISPATCH_BRIDGE_TOKEN = saved; });
  answer();
  const s = await serve(t);
  const tok = jwt.sign({ email: 'someone@infinityhospitality.net' }, process.env.DISPATCH_JWT_SECRET, { expiresIn: '2m' });
  const r = await call(s, '/api/auth/sso', { method: 'POST', body: { token: tok } });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(sessionSet(r), undefined);
  const r2 = await call(s, '/', { headers: { cookie: ssoCookie('someone@infinityhospitality.net', 13 * HOUR) } });
  assert.ok(bounced(r2), r2.status + ' ' + r2.headers.location);
  assert.strictEqual(CALLS.length, 0, 'nothing is asked of Dispatch');
});

// ---- what is unchanged -----------------------------------------------------
test('a signed-out browser still goes to Google through Dispatch, with no staff check', async (t) => {
  answer();
  const s = await serve(t);
  const r = await call(s, '/');
  assert.ok(bounced(r));
  assert.strictEqual(CALLS.length, 0);
  const api = await call(s, '/api/ga4/summary');
  assert.strictEqual(api.status, 401);
});

// ORDER #1370 changed this one on purpose: the password session no longer
// opens anything, and a Bearer session is checked exactly like the cookie.
test('the marketing-password session is refused, and a Bearer session is renewal-checked like the cookie', async (t) => {
  answer({ body: { active: false } });
  const s = await serve(t);
  const pw = await call(s, '/', { headers: { cookie: ssoCookie(undefined, 2 * HOUR, 'admin') } });
  assert.ok(bounced(pw), pw.status + ' ' + pw.headers.location);
  assert.strictEqual(CALLS.length, 0, 'the password session is refused without asking Dispatch');
  const bearer = jwt.sign({ role: 'sso', email: 'someone@infinityhospitality.net', mkt_access: true, iat: Math.floor(Date.now() / 1000) - 13 * HOUR }, SECRET, { expiresIn: 30 * DAY });
  const b = await call(s, '/', { headers: { authorization: 'Bearer ' + bearer } });
  assert.ok(bounced(b), 'an inactive person\'s Bearer session ends too: ' + b.status);
  assert.strictEqual(CALLS.length, 1);
});

test('expired and forged sessions are refused before any check', async (t) => {
  answer();
  const s = await serve(t);
  const forged = jwt.sign({ role: 'sso', email: 'x@infinityhospitality.net' }, 'not-the-secret', { expiresIn: '1h' });
  const expired = jwt.sign({ role: 'sso', email: 'x@infinityhospitality.net' }, SECRET, { expiresIn: -10 });
  for (const tok of [forged, expired]) {
    const r = await call(s, '/', { headers: { cookie: 'mkt_session=' + encodeURIComponent(tok) } });
    assert.ok(bounced(r));
  }
  assert.strictEqual(CALLS.length, 0);
});
