'use strict';
// ORDER #3949 (Parts 2 and 3 of #3948): the marketing readiness board.
const test = require('node:test');
const assert = require('node:assert');
const RB = require('../lib/readiness-board');
const { listAgents, loadAgent } = require('../lib/agent-runner');

const ALL_ON = {
  MARKETING_RELAUNCH: '', GBP_POST_ON_APPROVE: 'on', BLOG_PUBLISH_ON_APPROVE: 'on', ADS_API_LIVE: 'on',
  PRODUCER_HANDOFFS: 'on', PRODUCER_QUEUE: 'on', CONVENTION_TO_HUBSPOT_PROD: 'on', INSTRUCTION_CHANGES_LIVE: 'on',
  META_ADS_READ_TOKEN: 'x', META_AD_ACCOUNT_IDS: '1,2', PINTEREST_PER_VENUE: 'on',
  AGENT_PLANNER_SCOUT: 'on', AGENT_GALA_SCOUT: 'on', AGENT_ENGAGEMENT_SLEUTH: 'on', AI_TELL_DETECTIVE: 'on', AGENT_KEYWORD_QUEEN: 'on',
};

function provenCards(slug) {
  const d = loadAgent(slug);
  const k = RB.actKind(d);
  if (k === 'report') return [{ id: 7, status: 'ready', decided_by: 'katherine@x', decided_at: '2026-11-20T15:00:00Z' }];
  return [{ id: 9, status: 'ready', decided_at: '2026-11-20T15:00:00Z', handoff: { ok: true, post_url: 'https://example.com/p' } }];
}
const greenAgents = () => listAgents().map((slug) => ({ slug, def: loadAgent(slug), needs: [], cards: provenCards(slug) }));
const PV = require('../lib/pinterest-venues');
const greenTeam = { pinterestRows: PV.CONNECTABLE.map((a) => ({ venue: a.code, connected: true })), codeMarks: { review_layout: true, report_brake: true }, katherineProof: { homework: 1, instructions: 1 } };

test('the board covers all 21 agents, one row each, three checks each', () => {
  const slugs = listAgents();
  assert.strictEqual(slugs.length, 21);
  const b = RB.board({ agents: greenAgents(), env: ALL_ON, ...greenTeam, pinterestAll: true });
  assert.strictEqual(b.agents.length, 21);
  for (const a of b.agents) for (const k of ['connected', 'acts', 'proven']) {
    assert.ok(['green', 'red', 'na'].includes(a[k].state), `${a.slug} ${k}`);
    assert.ok(a[k].line && a[k].line.length > 5, `${a.slug} ${k} has a sentence`);
  }
});

test('a need still failing turns Connected red, naming who acts', () => {
  const agents = greenAgents();
  const paul = agents.find((a) => a.slug === 'seo');
  paul.needs = ['Katherine: share the Search Console property (failing: none listed; last checked 11.28 10:00 CT)'];
  const b = RB.board({ agents, env: ALL_ON, ...greenTeam, pinterestAll: true });
  const row = b.agents.find((a) => a.slug === 'seo');
  assert.strictEqual(row.connected.state, 'red');
  assert.strictEqual(row.connected.owner, 'Katherine');
  assert.match(row.connected.line, /Search Console/);
  assert.strictEqual(row.ready, false);
});

test('Acts: Google Business is red while GBP_POST_ON_APPROVE is off, green when on', () => {
  const d = loadAgent('gbp');
  assert.strictEqual(RB.actsOf(d, {}).state, 'red');
  assert.match(RB.actsOf(d, {}).line, /GBP_POST_ON_APPROVE/);
  assert.strictEqual(RB.actsOf(d, { GBP_POST_ON_APPROVE: 'on' }).state, 'green');
});

test('Acts: an agent that ships OFF is red until its switch is on; a draft-only agent states its finished state', () => {
  const sleuth = loadAgent('engagement-sleuth');
  const off = RB.actsOf(sleuth, {});
  assert.strictEqual(off.state, 'red');
  assert.match(off.line, /AGENT_ENGAGEMENT_SLEUTH/);
  assert.strictEqual(off.owner, 'Mimi');
  const scout = RB.actsOf(loadAgent('scout'), {});
  assert.strictEqual(scout.state, 'na');
  assert.match(scout.line, /finished state/);
});

test('Acts: sales cards to the HubSpot sandbox only are red; the WordPress draft path is green', () => {
  const cc = loadAgent('convention-connector');
  assert.strictEqual(RB.actsOf(cc, { CONVENTION_TO_HUBSPOT: 'on' }).state, 'red');
  assert.match(RB.actsOf(cc, { CONVENTION_TO_HUBSPOT: 'on' }).line, /sandbox/);
  assert.strictEqual(RB.actsOf(loadAgent('bloggy-bob'), {}).state, 'green');
});

test('Proven: a handed-off card links its evidence; no proof is red', () => {
  const d = loadAgent('bloggy-bob');
  const p = RB.provenOf(d, [{ id: 41, status: 'ready', decided_at: '2026-11-01T15:00:00Z', handoff: { ok: true, edit_link: 'https://site/wp-admin/post.php?post=5' } }]);
  assert.strictEqual(p.state, 'green');
  assert.match(p.line, /#41/);
  assert.strictEqual(p.link, 'https://site/wp-admin/post.php?post=5');
  assert.strictEqual(RB.provenOf(d, [{ id: 42, status: 'ready', handoff: { ok: false, why: 'x' } }]).state, 'red');
  assert.strictEqual(RB.provenOf(d, []).state, 'red');
});

test('team rows: handoffs count 8 edges and say why the Scout to Bob one is off', () => {
  const t = RB.teamRows({ env: { PRODUCER_HANDOFFS: 'on' }, ...greenTeam });
  const h = t.find((r) => r.id === 'handoffs');
  assert.strictEqual(h.state, 'red');
  assert.match(h.line, /7 of 8/);
  assert.match(h.line, /PRODUCER_QUEUE/);
  assert.strictEqual(RB.teamRows({ env: ALL_ON, ...greenTeam }).find((r) => r.id === 'handoffs').state, 'green');
});

test('team rows: Meta shows with Katherine since 11.25.2026 until its token and accounts are set', () => {
  const m = RB.teamRows({ env: {}, ...greenTeam }).find((r) => r.id === 'meta');
  assert.strictEqual(m.state, 'red');
  assert.match(m.line, /with Katherine since 11\.25\.2026/);
  assert.strictEqual(m.owner, 'Katherine');
});

test('team rows: Pinterest counts connected accounts; the card hold reads card-hold status()', () => {
  const t = RB.teamRows({ env: {}, ...greenTeam, pinterestRows: [{ venue: 'TBB', connected: true }] });
  const p = t.find((r) => r.id === 'pinterest');
  assert.strictEqual(p.state, 'red');
  assert.match(p.line, /of 11/);
  const hold = t.find((r) => r.id === 'card-hold');
  assert.strictEqual(hold.state, 'na');
  assert.match(hold.line, /on hold/);
});

test('top line counts ready agents and lists blockers shortest fix first', () => {
  const b = RB.board({ agents: greenAgents(), env: {}, ...greenTeam });
  assert.match(b.top_line, /^\d+ of 21 agents ready/);
  const mins = b.blockers.map((x) => x.minutes);
  assert.deepStrictEqual(mins, mins.slice().sort((a, c) => a - c));
  assert.ok(b.blockers.every((x) => x.owner && x.line));
  assert.strictEqual(b.relaunch.ready, false);
  assert.strictEqual(b.relaunch.record, null);
});

test('Part 3: all green files the relaunch record text; no dollar figures, no em dashes', () => {
  const b = RB.board({ agents: greenAgents(), env: ALL_ON, ...greenTeam, pinterestAll: true });
  assert.strictEqual(b.ready_count, 21, JSON.stringify(b.blockers));
  assert.strictEqual(b.blockers.length, 0, JSON.stringify(b.blockers));
  assert.strictEqual(b.relaunch.ready, true);
  const rec = RB.relaunchRecord({ stamp: '11.30.2026 09:00 CT' });
  assert.match(rec, /^## \[PREFERENCE\]/);
  for (const f of ['**DO:**', "**WHY IT'S STUCK:**", '**HOW LONG:**', '**WHAT IT UNBLOCKS:**', '**AGE:**']) assert.ok(rec.includes(f), f);
  assert.match(rec, /MARKETING_RELAUNCH=on/);
  const note = RB.katherineNote();
  for (const s of [rec, note, JSON.stringify(b)]) { assert.ok(!/\$\d/.test(s)); assert.ok(!s.includes(String.fromCharCode(0x2014))); }
  assert.strictEqual((note.match(/^\d\. /gm) || []).length, 3);
});

test('route: /api/readiness is Exec only and answers the live board for 21 agents', async (t) => {
  process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://marketing.infinityhospitalitygroup.com';
  process.env.DISPATCH_BRIDGE_URL = process.env.DISPATCH_BRIDGE_URL || 'https://dispatch.infinityhospitalitygroup.com';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'marketing-test-secret-not-real';
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const http = require('node:http');
  const { pageGate } = require('../middleware/page-gate');
  const { createAgentsRouter } = require('../routes/agents');
  const { createMemoryStore } = require('../lib/agent-store');
  const identity = { lookup: async (email) => (email === 'mimi@infinityhospitality.net' ? { active: true, rung: 3 } : { active: true, rung: 2 }) };
  const a = express(); a.use(express.json()); a.use(pageGate); a.use(createAgentsRouter({ store: createMemoryStore({ lint: require('../lib/ai-tells').lint }), identity }));
  const s = await new Promise((resolve) => { const x = http.createServer(a).listen(0, '127.0.0.1', () => resolve(x)); });
  t.after(() => new Promise((r) => s.close(r)));
  const as = (email) => ({ Cookie: `mkt_session=${jwt.sign({ role: 'sso', email, mkt_access: true }, process.env.JWT_SECRET)}` });
  const get = (p, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.address().port, path: p, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(c).toString()); } catch (_) {} resolve({ status: res.statusCode, json }); });
    }); req.on('error', reject); req.end();
  });
  assert.strictEqual((await get('/api/readiness', as('khowe@infinityhospitality.net'))).status, 403);
  const ok = await get('/api/readiness', as('mimi@infinityhospitality.net'));
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.agents.length, 21);
  assert.match(ok.json.top_line, /of 21 agents ready/);
  assert.strictEqual((await get('/readiness', as('khowe@infinityhospitality.net'))).status, 403);
});

test('the board reads only: no store write is called', async () => {
  const calls = [];
  const store = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : async () => { calls.push(k); return []; }) });
  await RB.gather({ store, env: {} });
  for (const k of calls) assert.ok(RB.READS.includes(k), `unexpected store call ${k}`);
});
