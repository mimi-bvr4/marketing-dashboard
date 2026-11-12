'use strict';
// ORDER #3246: the Site Guardian card reads the Box watch's state file (as the
// Box publishes it into guardian_state). "Monitoring live" only when the state
// is fresher than 15 minutes; otherwise "Stale since <time>". Never a
// hard-coded live. The WP Engine Waiting line clears only on a live state.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const G = require('../lib/guardian-card');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { publish } = require('../jobs/guardian_publish');

const NOW = new Date('2026-11-12T01:00:00Z'); // 11.11.2026 19:00 CT
const at = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
const state = (min, extra = {}) => ({ generated_at: at(min), order: 3246, summary: { sites: 9, up: 9, down: 0, flagged: 1, warn: 0 },
  lines: ['FLAGGED: dailydishcatering.com administrator on gmail.com, owner not named yet (#2193 NEEDS YOU 3)'], ...extra });

test('a fresh state file reads Monitoring live', () => {
  const v = G.view({ generated_at: at(4), state: state(4) }, NOW);
  assert.strictEqual(v.live, true);
  assert.strictEqual(v.label, 'Monitoring live');
  assert.strictEqual(v.summary.sites, 9);
});

test('a stale state reads Stale since <time CT>, never live', () => {
  const v = G.view({ generated_at: at(16), state: state(16) }, NOW);
  assert.strictEqual(v.live, false);
  assert.match(v.label, /^Stale since 11\.11\.2026 18:44 CT$/);
});

test('a missing state reads Stale, never live', () => {
  for (const row of [null, undefined, {}, { generated_at: 'nonsense' }]) {
    const v = G.view(row, NOW);
    assert.strictEqual(v.live, false);
    assert.match(v.label, /^Stale/);
  }
});

test('the WP Engine Waiting line clears only when the state is live', () => {
  const needs = ["Mimi's decision: a WP Engine login for the Brain (a Full user with API access), for backups and patching", 'something else'];
  assert.deepStrictEqual(G.needs(needs, { live: true }), ['something else']);
  assert.deepStrictEqual(G.needs(needs, { live: false }), needs);
});

test('no hard-coded live anywhere: the page reads the label from the API', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
  assert.ok(!/['"]Monitoring live['"]/.test(html), 'agents.html must not hard-code Monitoring live');
  assert.match(html, /a\.guardian/);
  const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'site-guardian', 'agent.json'), 'utf8'));
  assert.ok(!/live/i.test(def.card_only), def.card_only);
});

test('publish: the state file goes into guardian_state; a stale or broken file is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3246-'));
  const store = createMemoryStore({ lint });
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify(state(1)));
  const r = await publish({ store, file, log: () => {} });
  assert.strictEqual(r, 0);
  const row = await store.guardianState();
  assert.strictEqual(row.state.order, 3246);
  assert.strictEqual(G.view(row, NOW).label, 'Monitoring live');
  fs.writeFileSync(file, '{not json');
  assert.strictEqual(await publish({ store, file, log: () => {} }), 2);
  assert.strictEqual(await publish({ store, file: path.join(dir, 'nope.json'), log: () => {} }), 2);
  // An older state never overwrites a newer one.
  fs.writeFileSync(file, JSON.stringify(state(30)));
  await publish({ store, file, log: () => {} });
  assert.strictEqual((await store.guardianState()).generated_at, at(1));
});

test('route: /api/agents carries the guardian view on the Site Guardian card only', async () => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const http = require('node:http');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'marketing-test-secret-not-real';
  const { pageGate } = require('../middleware/page-gate');
  const { createAgentsRouter } = require('../routes/agents');
  const store = createMemoryStore({ lint });
  await store.putGuardianState(state(3));
  const a = express(); a.use(express.json()); a.use(pageGate); a.use(createAgentsRouter({ store, clock: () => NOW }));
  const s = await new Promise((res) => { const x = http.createServer(a).listen(0, () => res(x)); });
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.address().port, path: '/api/agents', headers: {
        Cookie: `mkt_session=${jwt.sign({ role: 'sso', email: 'khowe@infinityhospitality.net', mkt_access: true }, process.env.JWT_SECRET)}` } }, (r) => {
        const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString())));
      });
      req.on('error', reject); req.end();
    });
    const sg = body.agents.find((x) => x.slug === 'site-guardian');
    assert.strictEqual(sg.guardian.label, 'Monitoring live');
    assert.ok(!sg.character.needs.some((n) => /WP Engine login/.test(n)), sg.character.needs);
    assert.ok(body.agents.filter((x) => x.slug !== 'site-guardian').every((x) => x.guardian == null));
  } finally { await new Promise((r) => s.close(r)); }
});
