'use strict';
// ORDER #2979 routes: the change list Mimi sees on /agents, before/after, and
// Undo (exec only, rung 3). Nothing here sends anything.
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
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const K = 'katherine@infinityhospitality.net';
const MIMI = 'mimi@infinityhospitality.net';

function serve(a, t) { return new Promise((resolve) => { const s = http.createServer(a).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); }); }
function call(server, urlPath, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { const t = Buffer.concat(c).toString(); let json = null; try { json = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
const as = (email) => ({ Cookie: `mkt_session=${jwt.sign({ role: 'sso', email, mkt_access: true }, process.env.JWT_SECRET)}` });
const identity = { lookup: async (email) => (email === MIMI ? { active: true, rung: 3 } : { active: true, rung: 2 }) };
function app(store) { const a = express(); a.use(express.json()); a.use(pageGate); a.use(createAgentsRouter({ store, identity })); return a; }

test('ZZ_TEST routes: Katherine saves (live), Mimi sees the line and the diff, Katherine cannot undo, Mimi can, History shows all three', async (t) => {
  const store = createMemoryStore({ lint });
  const s = await serve(app(store), t);
  const k = as(K), m = as(MIMI);
  assert.strictEqual((await call(s, '/api/agents/changes')).status, 403, 'signed out');
  const saved = await call(s, '/api/agents/gbp', { headers: k, method: 'POST', body: { skill_md: '# GBP\nZZ_TEST shorter.', enabled: true, max_cards: 3, note: 'ZZ_TEST' } });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.json.settings.version, 1, 'live on save, no approval step');

  const listK = await call(s, '/api/agents/changes', { headers: k });
  assert.strictEqual(listK.json.exec, false);
  assert.strictEqual(listK.json.copy, 'Instruction changes go live on save. Mimi is notified and can undo.');
  const listM = await call(s, '/api/agents/changes', { headers: m });
  assert.strictEqual(listM.json.exec, true);
  assert.deepStrictEqual(listM.json.changes.map((c) => [c.agent, c.version, c.who, c.can_undo, c.link]), [['gbp', 1, K, true, '/agents#change-gbp-1']]);

  const diff = await call(s, '/api/agents/gbp/changes/1', { headers: m });
  assert.strictEqual(diff.json.before_version, 0, 'version 1 is compared with the default');
  assert.ok(diff.json.diff.some((x) => x.op === '+' && /ZZ_TEST shorter/.test(x.line)));

  assert.strictEqual((await call(s, '/api/agents/gbp/changes/1/undo', { headers: k, method: 'POST', body: {} })).status, 403);
  const undone = await call(s, '/api/agents/gbp/changes/1/undo', { headers: m, method: 'POST', body: {} });
  assert.strictEqual(undone.status, 200);
  assert.strictEqual(undone.json.settings.version, 2);
  assert.strictEqual(undone.json.settings.edited_by, MIMI);
  assert.match(undone.json.settings.note, /^Undo of version 1 by mimi@/);
  assert.strictEqual((await call(s, '/api/agents/gbp/changes/1/undo', { headers: m, method: 'POST', body: {} })).status, 409, 'once');

  const hist = await call(s, '/api/agents/gbp/history', { headers: m });
  assert.deepStrictEqual(hist.json.versions.map((v) => v.version), [2, 1]);
  const after = await call(s, '/api/agents/changes', { headers: m });
  assert.strictEqual(after.json.changes.find((c) => c.version === 1).undone_by, MIMI);
});

test('routes KNOWN-BAD: unknown agent 404, bad version 400, missing version 404', async (t) => {
  const store = createMemoryStore({ lint });
  const s = await serve(app(store), t);
  const m = as(MIMI);
  assert.strictEqual((await call(s, '/api/agents/nobody/changes/1', { headers: m })).status, 404);
  assert.strictEqual((await call(s, '/api/agents/gbp/changes/x', { headers: m })).status, 400);
  assert.strictEqual((await call(s, '/api/agents/gbp/changes/7', { headers: m })).status, 404);
  assert.strictEqual((await call(s, '/api/agents/gbp/changes/7/undo', { headers: m, method: 'POST', body: {} })).status, 404);
});
