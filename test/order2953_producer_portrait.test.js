'use strict';
// ORDER #2953: Mimi's headshots load as card portraits through setPortrait, and
// the Producer (profile key 'producer', #2900, no agents/ folder) shows its face
// too: its portrait is served by the same route and named in /api/producer.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const { pageGate } = require('../middleware/page-gate');
const { createAgentsRouter } = require('../routes/agents');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

function serve(a, t) {
  return new Promise((resolve) => { const s = http.createServer(a).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
}
function call(server, urlPath, { headers = {}, method = 'GET', raw, type } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers, ...(raw ? { 'Content-Type': type || 'image/png', 'Content-Length': raw.length } : {}) };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString()); } catch (_) {} resolve({ status: res.statusCode, buf, json }); });
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
const as = (email) => ({ Cookie: `mkt_session=${jwt.sign({ role: 'sso', email, mkt_access: true }, process.env.JWT_SECRET)}` });
function app(store) {
  const a = express(); a.use(express.json()); a.use(pageGate); a.use(createAgentsRouter({ store })); return a;
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 9)]);
const K = 'khowe@infinityhospitality.net';
const WHO = 'mimi (headshots 11.04)';

test('the Producer: no portrait means the drawn face; a stored one is served and named in /api/producer', async (t) => {
  const store = createMemoryStore({ lint });
  const s = await serve(app(store), t);
  assert.strictEqual((await call(s, '/api/producer', { headers: as(K) })).json.portrait, null);
  assert.strictEqual((await call(s, '/api/agents/producer/portrait', { headers: as(K) })).status, 404, 'no portrait yet');
  await store.setPortrait('producer', PNG, WHO);
  const p = (await call(s, '/api/producer', { headers: as(K) })).json;
  assert.match(p.portrait, /^\/api\/agents\/producer\/portrait\?v=\d+$/);
  const got = await call(s, '/api/agents/producer/portrait', { headers: as(K) });
  assert.strictEqual(got.status, 200);
  assert.ok(got.buf.equals(PNG));
  assert.strictEqual(p.name, 'The Producer', 'a portrait never changes the name');
});

test('the Producer portrait route is signed-in only, and an unknown slug is still 404', async (t) => {
  const s = await serve(app(createMemoryStore({ lint })), t);
  assert.strictEqual((await call(s, '/api/agents/producer/portrait', { method: 'PUT', raw: PNG })).status, 401);
  assert.strictEqual((await call(s, '/api/agents/producer/portrait', { headers: as(K), method: 'PUT', raw: PNG })).status, 200);
  assert.strictEqual((await call(s, '/api/agents/nobody/portrait', { headers: as(K) })).status, 404);
  assert.strictEqual((await call(s, '/api/agents/nobody/portrait', { headers: as(K), method: 'PUT', raw: PNG })).status, 404);
  assert.strictEqual((await call(s, '/api/agents/producer/name', { headers: as(K), method: 'POST' })).status, 404, 'only the portrait routes widen');
});

test('the headshot load: setPortrait on every card leaves names alone and records who', async () => {
  const store = createMemoryStore({ lint });
  await store.setName('bloggy-bob', 'Robert', K);
  for (const slug of ['bloggy-bob', 'gbp', 'producer']) assert.ok(!(await store.setPortrait(slug, PNG, WHO)).error);
  const rows = await store.profiles();
  assert.strictEqual(rows.find((r) => r.agent === 'bloggy-bob').display_name, 'Robert', 'name kept');
  assert.ok(rows.filter((r) => r.portrait_at).every((r) => r.updated_by === WHO));
  assert.strictEqual(rows.filter((r) => r.portrait_at).length, 3);
});

test('the page passes the Producer portrait to its face', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
  assert.match(html, /face\(\{ slug: 'producer', name: p\.name, portrait: p\.portrait \}/);
});
