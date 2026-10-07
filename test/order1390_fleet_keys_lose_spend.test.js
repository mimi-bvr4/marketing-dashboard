'use strict';
// ORDER #1390: KNOWN-BADS FOR "FLEET KEYS KEEP TRAFFIC, LOSE /api/spend".
//
// Mimi ruled A on the #1370 fleet-keys record, 10.07.2026: keys stop reading
// /api/spend (the salary row) and any other spend or cost route; they keep
// reading website-traffic numbers. Person sessions (#1370) are unchanged.
//
// Driven through the REAL fleetGate and the REAL pageGate, in server.js's
// order, on an Express app with stand-in routes behind them (server.js listens
// on require, so it cannot be mounted here; #654 and #1370 make the same
// choice). The token store is a stand-in pool injected as ../db, so the real
// validateFleetToken runs its real hash lookup. No network, and no figure from
// the spend data appears in this file.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'marketing-test-secret-not-real';
process.env.DISPATCH_JWT_SECRET = 'dispatch-test-secret-not-real';
process.env.DISPATCH_BRIDGE_TOKEN = 'test-only-bridge-token';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
delete process.env.DATABASE_URL;

const { sha256 } = require('../lib/fleet-tokens');
const GOOD_KEY = 'mkt_test-only-good-key';
const REVOKED_KEY = 'mkt_test-only-revoked-key';
const TOKENS = {
  [sha256(GOOD_KEY)]: { id: 1, label: 'ARC read key', user_id: 'test', revoked_at: null },
  [sha256(REVOKED_KEY)]: { id: 2, label: 'old key', user_id: 'test', revoked_at: new Date() },
};
const fakePool = {
  query: async (sql, params) => {
    if (/^SELECT/i.test(sql)) return { rows: TOKENS[params[0]] ? [TOKENS[params[0]]] : [] };
    return { rows: [] };
  },
};
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: fakePool, hasDb: () => true, ensureTables: async () => {} } };

// Dispatch, faked: the exec is allowed at renewal; nothing else is called.
global.fetch = async () => ({ ok: true, status: 200,
  json: async () => ({ active: true, person_id: 'person_exec0001', rung: 3, bundle: 'Exec' }) });

const { fleetGate } = require('../middleware/auth');
const { pageGate } = require('../middleware/page-gate');

const SPEND_MARKER = 'SPEND-PAYLOAD-STAND-IN';
const TRAFFIC_MARKER = 'TRAFFIC-PAYLOAD-STAND-IN';

function app() {
  const a = express();
  a.use(express.json());
  a.use(fleetGate);
  a.use(pageGate);
  a.get('/health', (req, res) => res.json({ status: 'ok' }));
  a.get('/api/contract', (req, res) => res.json({ ok: true }));
  a.get('/api/spend', (req, res) => res.json({ marker: SPEND_MARKER }));
  a.get('/api/a-cost-route-added-next-week', (req, res) => res.json({ marker: SPEND_MARKER }));
  a.get('/api/ga4/summary', (req, res) => res.json({ marker: TRAFFIC_MARKER }));
  a.get('/api/ga4/sessions', (req, res) => res.json({ marker: TRAFFIC_MARKER }));
  a.get('/api/ga4/elle/summary', (req, res) => res.json({ marker: TRAFFIC_MARKER }));
  a.get('/api/ga4/elle/sessions', (req, res) => res.json({ marker: TRAFFIC_MARKER }));
  a.use((req, res) => res.status(200).send('THE DASHBOARD'));
  return a;
}
function serve(t) {
  return new Promise(resolve => {
    const s = http.createServer(app()).listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(r => s.close(r)));
      resolve(s);
    });
  });
}
function call(server, urlPath, headers = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}
const key = k => ({ authorization: 'Bearer ' + k });
const execCookie = () => ({ cookie: 'mkt_session=' + encodeURIComponent(jwt.sign(
  { role: 'sso', email: 'exec@infinityhospitality.net', mkt_access: true },
  process.env.JWT_SECRET, { expiresIn: '30d' })) });

// ---- KNOWN-BAD 1: the salary row --------------------------------------------
test('KNOWN-BAD: a fleet key on /api/spend gets 403 and no spend data (on main: 200)', async (t) => {
  const s = await serve(t);
  const r = await call(s, '/api/spend', key(GOOD_KEY));
  assert.strictEqual(r.status, 403);
  assert.ok(!r.body.includes(SPEND_MARKER), 'no spend payload reaches a key');
});

test('KNOWN-BAD: spelling tricks do not reach /api/spend with a key (Express routes ignore case)', async (t) => {
  const s = await serve(t);
  for (const p of ['/API/SPEND', '/api/Spend', '/api/spend/', '/api/spend?x=1']) {
    const r = await call(s, p, key(GOOD_KEY));
    assert.strictEqual(r.status, 403, p);
    assert.ok(!r.body.includes(SPEND_MARKER), p);
  }
});

// ---- KNOWN-BAD 2: any other spend or cost read, now or later ----------------
test('KNOWN-BAD: a key is refused a cost route added next week, and the dashboard page (on main: 200)', async (t) => {
  const s = await serve(t);
  const later = await call(s, '/api/a-cost-route-added-next-week', key(GOOD_KEY));
  assert.strictEqual(later.status, 403);
  assert.ok(!later.body.includes(SPEND_MARKER));
  const page = await call(s, '/', key(GOOD_KEY));
  assert.strictEqual(page.status, 403);
  assert.ok(!page.body.includes('THE DASHBOARD'));
});

// ---- Unchanged: traffic, discovery, revoked keys, people ---------------------
test('a fleet key still reads every website-traffic route', async (t) => {
  const s = await serve(t);
  for (const p of ['/api/ga4/summary', '/api/ga4/sessions', '/api/ga4/elle/summary', '/api/ga4/elle/sessions']) {
    const r = await call(s, p, key(GOOD_KEY));
    assert.strictEqual(r.status, 200, p);
    assert.ok(r.body.includes(TRAFFIC_MARKER), p);
  }
});

test('a fleet key still reaches the open discovery paths', async (t) => {
  const s = await serve(t);
  assert.strictEqual((await call(s, '/health', key(GOOD_KEY))).status, 200);
  assert.strictEqual((await call(s, '/api/contract', key(GOOD_KEY))).status, 200);
});

test('a revoked key reads nothing, traffic included', async (t) => {
  const s = await serve(t);
  assert.strictEqual((await call(s, '/api/ga4/summary', key(REVOKED_KEY))).status, 401);
  assert.strictEqual((await call(s, '/api/spend', key(REVOKED_KEY))).status, 401);
});

test('an exec session (#1370) still reads /api/spend and the page, unchanged', async (t) => {
  const s = await serve(t);
  const spend = await call(s, '/api/spend', execCookie());
  assert.strictEqual(spend.status, 200);
  assert.ok(spend.body.includes(SPEND_MARKER));
  assert.strictEqual((await call(s, '/', execCookie())).status, 200);
});

// ---- The published contract stops advertising spend to keys ---------------
test('the Fleet Contract no longer lists /api/spend as a key read', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'fleet.js'), 'utf8');
  const contract = src.slice(src.indexOf("router.get('/api/contract'"), src.indexOf('// simple admin login'));
  assert.ok(contract.length > 0);
  assert.ok(!contract.includes("path:'/api/spend'"), 'a key is not told it may read spend');
  assert.ok(contract.includes("path:'/api/ga4/summary'"), 'traffic is still advertised');
});
