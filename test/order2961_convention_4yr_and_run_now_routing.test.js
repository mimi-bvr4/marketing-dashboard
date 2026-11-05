// ORDER #2961 (carried by #2975): Convention Charles looks 4 years out, not 9
// months (Mimi's standing ruling, 11.04.2026), and a Run-now request that asks
// for a standing change says "this run only" and offers "Make this permanent",
// which files an Ask that the Box sorts and Mimi approves.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'marketing-test-secret-not-real';

const { gather } = require('../lib/agent-sources');
const { loadAgent } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { pageGate } = require('../middleware/page-gate');
const { createAgentsRouter } = require('../routes/agents');
const RN = require('../lib/run-now-note');

const NOW = new Date('2026-11-05T12:00:00Z');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');

async function conventionPrompts() {
  const src = loadAgent('convention-connector').sources.find((s) => s.type === 'web_trends');
  const prompts = [];
  const fetch = async (u, o) => { prompts.push(JSON.parse(o.body).messages[0].content); return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) }; };
  await gather([src], { env: { ANTHROPIC_API_KEY: 'k' }, fetch, now: () => NOW });
  return { src, prompts };
}

test('RED on main: the convention search window reaches today + 4 years, never 9 months', async () => {
  const { src, prompts } = await conventionPrompts();
  assert.ok(prompts.length >= 5);
  for (const p of prompts) {
    assert.match(p, /between today and 4 years from today/);
    assert.doesNotMatch(p, /between today and 9 months|in the next 9 months/);
    assert.match(p, /next 9 months first, then later events grouped by year/);
    assert.match(p, /Never list an item without a link you actually found/);
  }
  for (const q of src.queries) assert.doesNotMatch(q, /9 months/);
  assert.ok(src.queries.some((q) => /4 years/.test(q)), 'at least one query names the 4-year window');
  assert.ok(src.queries.some((q) => /2028|later years|years ahead/i.test(q)), 'one query reaches past next year');
});

test('the card copy, the instructions and the /agents line say 4 years; near-term first, then grouped by year, honest none-found', () => {
  const a = loadAgent('convention-connector');
  const does = a.character.does.join(' ');
  assert.match(does, /next 4 years/);
  assert.doesNotMatch(does, /9 months/);
  assert.doesNotMatch(a.skill, /1 to 9 months out|in the next 9 months/);
  assert.match(a.skill, /4 years/);
  assert.match(a.skill, /next 9 months first/i);
  assert.match(a.skill, /grouped by year/i);
  assert.match(a.skill, /none found/i);
});

test('Run-now note: the one-run sentence, and the standing-change words are recognised', () => {
  assert.strictEqual(RN.RUN_ONCE_NOTE, 'This applies to this run only. To change it for good, use Ask for a new ability.');
  for (const t of ['Change the next 9 months to 4 years out', 'always include the venue name', 'from now on skip Gaylord', 'list DMCs instead of hotels'])
    assert.strictEqual(RN.asksForStandingChange(t), true, t);
  for (const t of ['a winter-wedding post for The Bell Tower', '', null]) assert.strictEqual(RN.asksForStandingChange(t), false, String(t));
  const p = RN.permanentAsk('  Change the next 9 months to 4 years out ');
  assert.match(p, /^Make this permanent/);
  assert.match(p, /Change the next 9 months to 4 years out$/);
  assert.strictEqual(lint(p).fails.length, 0, 'no em dash in the filed text');
});

test('every Run-now request box carries the note and a Make this permanent button that files an Ask', () => {
  // The request box lives on each agent's profile (the roster card has no box).
  const at = HTML.indexOf('data-f="ask"');
  assert.ok(at > 0);
  assert.strictEqual(HTML.indexOf('data-f="ask"', at + 1), -1, 'one request-box template serves every agent card');
  const near = HTML.slice(at, at + 900);
  assert.ok(near.includes(RN.RUN_ONCE_NOTE), 'the exact one-run sentence sits under the box');
  assert.match(near, /data-a="permanent"/);
  assert.match(near, /Make this permanent/);
  assert.match(HTML, /b\.dataset\.a === 'permanent'[\s\S]{0,300}\/asks`[\s\S]{0,120}permanent: true/);
});

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
const identity = { lookup: async (email) => (email === 'mimi@infinityhospitality.net' ? { active: true, rung: 3 } : { active: true, rung: 2 }) };

test('ZZ_TEST: Make this permanent lands in the Asks list as a standing-change ask, waiting to be sorted (memory store, never the live list)', async (t) => {
  const store = createMemoryStore({ lint });
  const a = express(); a.use(express.json()); a.use(pageGate); a.use(createAgentsRouter({ store, identity }));
  const s = await serve(a, t);
  const k = as('khowe@infinityhospitality.net');
  const r = await call(s, '/api/agents/convention-connector/asks', { headers: k, method: 'POST', body: { ask: 'ZZ_TEST change the next 9 months to 4 years out', permanent: true } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.ask.status, 'new');
  assert.match(r.json.ask.ask, /^Make this permanent/);
  assert.match(r.json.ask.ask, /ZZ_TEST change the next 9 months to 4 years out/);
  const listed = await store.listAsks('convention-connector');
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].asked_by, 'khowe@infinityhospitality.net');
  const plain = await call(s, '/api/agents/convention-connector/asks', { headers: k, method: 'POST', body: { ask: 'ZZ_TEST add a FAQ' } });
  assert.doesNotMatch(plain.json.ask.ask, /^Make this permanent/, 'a plain ask is filed exactly as typed');
});
