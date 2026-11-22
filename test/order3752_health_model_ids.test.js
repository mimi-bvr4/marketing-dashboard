'use strict';
// ORDER #3752 (closes ruling-3637 item 3 before 11.30.2026): the public /health
// carries the Claude model ids the code will really call, so one anonymous GET
// answers "is FAST_MODEL / AGENT_MODEL still a retiring id?" without anyone
// opening Railway. The ids come from the modules' own resolvers, never from a
// second read of process.env in routes/fleet.js.
//
// Driven through the REAL page gate and the REAL fleet router, signed out.
// No network, no database, no real secret: every env value below is a sentinel.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'marketing-test-secret-not-real';
delete process.env.DATABASE_URL;

const { pageGate } = require('../middleware/page-gate');
const fleet = require('../routes/fleet');
const { fastModel, FAST_MODEL } = require('../lib/fast-model');
const agentLlm = require('../lib/agent-llm');
const { PICK_MODEL } = require('../lib/photo-tagger');

function serve(t) {
  const a = express();
  a.use(pageGate);
  a.use('/', fleet);
  return new Promise(resolve => {
    const s = http.createServer(a).listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(r => s.close(r)));
      resolve(s);
    });
  });
}
function get(s, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: s.address().port, path: p }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw: body }));
    }).on('error', reject);
  });
}
async function health(s) {
  const r = await get(s, '/health');
  return { status: r.status, raw: r.raw, body: JSON.parse(r.raw) };
}
async function withEnv(vars, fn) {
  const before = {};
  for (const k of Object.keys(vars)) {
    before[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    }
  }
}

test('(a) models.fast, models.agent and models.pick are present and equal each module\'s resolved value', async t => {
  assert.strictEqual(typeof agentLlm.agentModel, 'function', 'lib/agent-llm.js exports agentModel()');
  const s = await serve(t);
  await withEnv({ FAST_MODEL: 'claude-test-fast', AGENT_MODEL: 'claude-test-agent' }, async () => {
    const r = await health(s);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.models, 'body carries a models object');
    assert.strictEqual(r.body.models.fast, fastModel());
    assert.strictEqual(r.body.models.fast, 'claude-test-fast');
    assert.strictEqual(r.body.models.agent, agentLlm.agentModel());
    assert.strictEqual(r.body.models.agent, 'claude-test-agent');
    assert.strictEqual(r.body.models.pick, PICK_MODEL);
  });
});

test('(a) the agent id /health reports is the id createTextClient really sends', async () => {
  await withEnv({ AGENT_MODEL: 'claude-test-agent' }, async () => {
    const c = agentLlm.createTextClient({ apiKey: 'sk-test-only', fetchImpl: async () => { throw new Error('network refused in test'); } });
    assert.strictEqual(c.model, agentLlm.agentModel());
  });
});

test('(b) unset or blank env values give the code defaults', async t => {
  const s = await serve(t);
  for (const v of [undefined, '']) {
    await withEnv({ FAST_MODEL: v, AGENT_MODEL: v }, async () => {
      const r = await health(s);
      assert.strictEqual(r.body.models.fast, FAST_MODEL);
      assert.strictEqual(r.body.models.fast, 'claude-haiku-5-5');
      assert.strictEqual(r.body.models.agent, agentLlm.DEFAULT_MODEL);
      assert.strictEqual(r.body.models.agent, 'claude-sonnet-5-5');
    });
  }
});

test('(c) no other env value, key, token or header appears in the body', async t => {
  const s = await serve(t);
  const SENTINELS = {
    ANTHROPIC_API_KEY: 'sk-ant-SENTINEL-3752-key',
    DISPATCH_JWT_SECRET: 'SENTINEL-3752-dispatch-secret',
    DISPATCH_BRIDGE_TOKEN: 'SENTINEL-3752-bridge-token',
    CITATIONS_OPENAI_MODEL: 'SENTINEL-3752-openai-model',
    PHOTO_MODEL_CACHE: '/SENTINEL-3752-cache',
    FAST_MODEL: 'claude-test-fast',
    AGENT_MODEL: 'claude-test-agent',
  };
  await withEnv(SENTINELS, async () => {
    const r = await health(s);
    for (const [k, v] of Object.entries(SENTINELS)) {
      if (k === 'FAST_MODEL' || k === 'AGENT_MODEL') continue;
      assert.ok(!r.raw.includes(v), `${k}'s value is not in /health`);
    }
    assert.ok(!r.raw.includes('marketing-test-secret-not-real'), 'JWT_SECRET is not in /health');
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['models', 'service', 'status', 'version']);
    assert.deepStrictEqual(Object.keys(r.body.models).sort(), ['agent', 'fast', 'pick']);
    for (const v of Object.values(r.body.models)) assert.strictEqual(typeof v, 'string');
  });
});

test('(c) routes/fleet.js reads no model variable from process.env itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'fleet.js'), 'utf8');
  assert.ok(!/process\.env\.[A-Z_]*MODEL/.test(src), 'fleet.js calls the resolvers, never process.env.*MODEL');
});

test('(d) status, service and version are unchanged', async t => {
  const s = await serve(t);
  await withEnv({ RAILWAY_GIT_COMMIT_SHA: 'abcdef0123456789' }, async () => {
    const r = await health(s);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'ok');
    assert.strictEqual(r.body.service, 'marketing-dashboard');
    assert.strictEqual(r.body.version, 'abcdef0');
  });
});

test('(e) /health answers signed out, and the signed-in routes stay closed', async t => {
  const s = await serve(t);
  assert.strictEqual((await get(s, '/health')).status, 200);
  for (const p of ['/api/tokens', '/settings/api-tokens', '/']) {
    const r = await get(s, p);
    assert.notStrictEqual(r.status, 200, `${p} still needs a sign-in`);
  }
});
