'use strict';
// ORDER #1664: Katherine names each agent and gives it a portrait. Cosmetic:
// saves at once, no exec approval, logged, shown on Review and the digest, and
// the instructions (the fence) are untouched.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const { pageGate } = require('../middleware/page-gate');
const { createAgentsRouter } = require('../routes/agents');
const { createReviewRouter } = require('../routes/review');
const { createMemoryStore } = require('../lib/agent-store');
const { checkName, checkPortrait } = require('../lib/agent-profile');
const { writeDigest } = require('../lib/agent-digest');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');

function serve(a, t) {
  return new Promise((resolve) => { const s = http.createServer(a).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
}
function call(server, urlPath, { headers = {}, method = 'GET', body, raw, type } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw || (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const h = { ...headers, ...(payload ? { 'Content-Type': type || 'application/json', 'Content-Length': payload.length } : {}) };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString()); } catch (_) {} resolve({ status: res.statusCode, buf, json, headers: res.headers }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
const as = (email) => ({ Cookie: `mkt_session=${jwt.sign({ role: 'sso', email, mkt_access: true }, process.env.JWT_SECRET)}` });
function app(store) {
  const a = express(); a.use(express.json({ limit: '2mb' })); a.use(pageGate);
  a.use(createReviewRouter({ store })); a.use(createAgentsRouter({ store })); return a;
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const K = 'khowe@infinityhospitality.net';

test('checks: names trimmed, tags stripped, 40 max, blank means default; portraits typed by their bytes', () => {
  assert.deepStrictEqual(checkName('  Bob   the  <b>Blogger</b> '), { name: 'Bob the bBlogger/b' });
  assert.deepStrictEqual(checkName(''), { name: null });
  assert.deepStrictEqual(checkName(null), { name: null });
  assert.ok(checkName('x'.repeat(41)).error);
  assert.ok(checkName(5).error);
  assert.strictEqual(checkPortrait(PNG).type, 'image/png');
  assert.strictEqual(checkPortrait(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])).type, 'image/jpeg');
  assert.ok(checkPortrait(Buffer.from('<svg onload=alert(1)>')).error, 'an SVG or HTML file is refused');
  assert.ok(checkPortrait(Buffer.alloc(0)).error);
  assert.ok(checkPortrait(Buffer.concat([PNG, Buffer.alloc(1.6 * 1024 * 1024)])).error, 'over 1.5 MB refused');
});

test('routes: signed out refused; Katherine renames with no approval step, it shows on the roster and is logged', async (t) => {
  const store = createMemoryStore({ lint });
  const s = await serve(app(store), t);
  assert.strictEqual((await call(s, '/api/agents/bloggy-bob/name', { method: 'POST', body: { name: 'Bob' } })).status, 401);
  const r = await call(s, '/api/agents/bloggy-bob/name', { headers: as(K), method: 'POST', body: { name: 'Robert the Writer' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.name, 'Robert the Writer');
  const list = await call(s, '/api/agents', { headers: as(K) });
  const bob = list.json.agents.find((a) => a.slug === 'bloggy-bob');
  assert.strictEqual(bob.name, 'Robert the Writer');
  assert.strictEqual(bob.default_name, 'Bloggy Bob');
  assert.strictEqual(bob.named_by, K);
  assert.strictEqual(bob.current, null, 'renaming never creates an instructions version');
  assert.strictEqual(list.json.agents.find((a) => a.slug === 'gbp').name, loadAgent('gbp').name, 'others untouched');
  assert.strictEqual((await call(s, '/api/agents/bloggy-bob/name', { headers: as(K), method: 'POST', body: { name: 'x'.repeat(41) } })).status, 400);
  assert.strictEqual((await call(s, '/api/agents/nobody/name', { headers: as(K), method: 'POST', body: { name: 'x' } })).status, 404);
  const back = await call(s, '/api/agents/bloggy-bob/name', { headers: as(K), method: 'POST', body: { name: '' } });
  assert.strictEqual(back.json.name, 'Bloggy Bob', 'blank puts the default back');
  const log = await call(s, '/api/agents/bloggy-bob/profile-log', { headers: as(K) });
  assert.strictEqual(log.json.changes.length, 2);
  assert.strictEqual(log.json.changes[1].new_value, 'Robert the Writer');
  assert.strictEqual(log.json.changes[0].old_value, 'Robert the Writer');
  assert.strictEqual(log.json.changes[0].changed_by, K);
});

test('routes: portrait upload, served back with its real type, refused when not a picture, removable', async (t) => {
  const store = createMemoryStore({ lint });
  const s = await serve(app(store), t);
  assert.strictEqual((await call(s, '/api/agents/listings/portrait', { headers: as(K) })).status, 404);
  assert.strictEqual((await call(s, '/api/agents/listings/portrait', { method: 'PUT', raw: PNG, type: 'image/png' })).status, 401);
  const up = await call(s, '/api/agents/listings/portrait', { headers: as(K), method: 'PUT', raw: PNG, type: 'image/jpeg' });
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.json.profile.portrait_type, 'image/png', 'type from the bytes, not the header');
  const got = await call(s, '/api/agents/listings/portrait', { headers: as(K) });
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.headers['content-type'], 'image/png');
  assert.strictEqual(got.headers['x-content-type-options'], 'nosniff');
  assert.ok(got.buf.equals(PNG));
  const a = (await call(s, '/api/agents', { headers: as(K) })).json.agents.find((x) => x.slug === 'listings');
  assert.match(a.portrait, /^\/api\/agents\/listings\/portrait\?v=\d+$/);
  const bad = await call(s, '/api/agents/listings/portrait', { headers: as(K), method: 'PUT', raw: Buffer.from('<html>'), type: 'image/png' });
  assert.strictEqual(bad.status, 400);
  assert.ok((await call(s, '/api/agents/listings/portrait', { headers: as(K) })).buf.equals(PNG), 'a refused upload keeps the old one');
  assert.strictEqual((await call(s, '/api/agents/listings/portrait', { headers: as(K), method: 'DELETE' })).status, 200);
  assert.strictEqual((await call(s, '/api/agents/listings/portrait', { headers: as(K) })).status, 404);
  assert.strictEqual((await call(s, '/api/agents', { headers: as(K) })).json.agents.find((x) => x.slug === 'listings').portrait, null);
});

test('everywhere: Review shows the new name on old cards; new cards and the digest carry it; the fence is unchanged', async (t) => {
  const store = createMemoryStore({ lint });
  await store.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'blog draft', title: 'Old card', body: 'x' });
  await store.setName('bloggy-bob', 'Robert', K);
  const s = await serve(app(store), t);
  const cards = (await call(s, '/api/review/cards', { headers: as(K) })).json.cards;
  assert.strictEqual(cards[0].agent_name, 'Robert');

  const calls = [];
  const llm = { model: 'fake', async complete(q) { calls.push(q); return JSON.stringify({ cards: [{ title: 'A post', body: 'Fine.' }] }); } };
  const def = { ...loadAgent('bloggy-bob'), sources: [{ type: 'request', label: 'the request' }] };
  await runAgent({ def, store, llm, ask: 'go' });
  const fresh = store.cards[store.cards.length - 1];
  assert.strictEqual(fresh.agent_name, 'Robert');
  assert.match(calls[0].system, /THE FENCE/);

  const d = await writeDigest({ store });
  assert.match(d.body, /\| Robert \|/);
});
