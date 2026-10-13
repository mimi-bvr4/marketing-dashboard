'use strict';
// ORDER #1658 character cards: Katherine asks a bot for a new ability; the Box
// sorts it; an instruction change waits for an exec (Mimi, 10.11.2026).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const { pageGate } = require('../middleware/page-gate');
const { createAgentsRouter } = require('../routes/agents');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { loadAgent } = require('../lib/agent-runner');
const { triageAsk, fileBuildOrder, isBuilt, nextNumber } = require('../lib/agent-asks');
const { sortAsks } = require('../jobs/agent_asks');

const EM = '—';
const model = (answer) => ({ model: 'fake', calls: [], async complete(q) { this.calls.push(q); return typeof answer === 'function' ? answer(q) : JSON.stringify(answer); } });
const inbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));

test('triage: an instruction change returns the full proposed instructions and the base version', async () => {
  const t = await triageAsk({ ask: { id: 1, ask: 'write shorter replies', asked_by: 'k' }, def: loadAgent('gbp'), current: null,
    llm: model({ kind: 'instructions', reason: 'a wording change', proposed_skill_md: '# GBP\nReplies in two sentences.' }) });
  assert.strictEqual(t.kind, 'instructions');
  assert.strictEqual(t.base_version, 0);
  assert.match(t.proposed_skill_md, /two sentences/);
});

test('triage KNOWN-BAD: an ask to publish is "cant" even when the model says instructions', async () => {
  const t = await triageAsk({ ask: { id: 2, ask: 'publish the post as soon as it is approved', asked_by: 'k' }, def: loadAgent('bloggy-bob'), current: null,
    llm: model({ kind: 'instructions', reason: 'easy', proposed_skill_md: '# Bob\nPublish when approved.' }) });
  assert.strictEqual(t.kind, 'cant');
  assert.strictEqual(t.overruled, true);
  assert.strictEqual(t.proposed_skill_md, null);
  assert.match(t.instead, /draft/i);
});

test('triage refuses bad answers: unknown kind, empty or em-dash instructions', async () => {
  const def = loadAgent('gbp');
  const ask = { id: 3, ask: 'be friendlier', asked_by: 'k' };
  await assert.rejects(triageAsk({ ask, def, current: null, llm: model({ kind: 'maybe' }) }), /not one of/);
  await assert.rejects(triageAsk({ ask, def, current: null, llm: model({ kind: 'instructions', proposed_skill_md: ' ' }) }), /empty/);
  await assert.rejects(triageAsk({ ask, def, current: null, llm: model({ kind: 'instructions', proposed_skill_md: `# GBP ${EM} warm` }) }), /em dash/);
});

test('build order: next global number, HELD for Mimi, O_EXCL; skips a number already taken', () => {
  const d = inbox();
  fs.writeFileSync(path.join(d, 'ORDER_2026-10-11_1658_marketing.md'), 'x');
  fs.writeFileSync(path.join(d, 'REPLY_2026-10-11_1659_x.md'), 'x');
  assert.strictEqual(nextNumber(fs.readdirSync(d)), 1660);
  const o = fileBuildOrder({ inbox: d, ask: { id: 9, ask: 'Pull Instagram stats into the report', asked_by: 'khowe@x' }, def: loadAgent('monthly-report'),
    triage: { reason: 'needs a new connection', build_summary: 'Connect Instagram insights read-only.' }, now: new Date('2026-10-11T18:00:00Z') });
  assert.strictEqual(o.number, 1660);
  const text = fs.readFileSync(path.join(d, o.file), 'utf8');
  assert.match(o.file, /^ORDER_2026-10-11_1660_KH_ask_monthly-report_pull_instagram_stats_into_the_report\.md$/);
  assert.match(text, /^STATUS: HELD for Mimi/m);
  assert.match(text, /Connect Instagram insights read-only/);
  assert.ok(!text.includes(EM));
  assert.strictEqual(isBuilt(d, o.file), false);
  fs.writeFileSync(path.join(d, 'REPLY_2026-10-12_1660_box.md'), 'CLAIMED: x\nSTATUS: DONE. Landed.');
  assert.strictEqual(isBuilt(d, o.file), true);
});

test('sortAsks: instructions wait for an exec, a build is filed, a cant becomes a trait, a broken answer is FAILED', async () => {
  const s = createMemoryStore({ lint });
  const d = inbox();
  for (const t of ['write shorter replies', 'pull Instagram stats', 'send replies to reviewers automatically', 'be friendlier']) await s.createAsk('gbp', t, 'khowe@x');
  const llm = model((q) => {
    if (/shorter/.test(q.user)) return JSON.stringify({ kind: 'instructions', reason: 'wording', proposed_skill_md: '# GBP\nShort replies.' });
    if (/Instagram/.test(q.user)) return JSON.stringify({ kind: 'build', reason: 'new data', build_summary: 'Instagram read-only.' });
    if (/send replies/.test(q.user)) return JSON.stringify({ kind: 'instructions', reason: 'x', proposed_skill_md: '# GBP\nSend them.' });
    return 'no json at all';
  });
  await sortAsks({ store: s, llm, inbox: d, log: () => {} });
  const by = Object.fromEntries((await s.listAsks()).map((a) => [a.ask, a]));
  assert.strictEqual(by['write shorter replies'].status, 'awaiting_exec');
  assert.strictEqual(by['pull Instagram stats'].status, 'building');
  assert.ok(fs.existsSync(path.join(d, by['pull Instagram stats'].order_file)));
  assert.strictEqual(by['send replies to reviewers automatically'].status, 'cant', 'the fence overrules the model');
  assert.strictEqual(by['be friendlier'].status, 'failed');
  assert.strictEqual(await sortAsks({ store: s, llm, inbox: d, log: () => {} }), 0, 'nothing is sorted twice');
});

test('sortAsks: no model key sorts nothing and changes nothing', async () => {
  const s = createMemoryStore({ lint });
  await s.createAsk('gbp', 'write shorter replies', 'k');
  await sortAsks({ store: s, llm: null, inbox: inbox(), log: () => {} });
  assert.strictEqual(s.asks[0].status, 'new');
});

// ------------------------------------------------------------- routes

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
function app(store) { const a = express(); a.use(express.json()); a.use(pageGate); a.use(createAgentsRouter({ store, identity })); return a; }

async function proposed(store, agent = 'gbp', base = 0) {
  const { ask } = await store.createAsk(agent, 'write shorter replies', 'khowe@infinityhospitality.net');
  await store.updateAsk(ask.id, { status: 'awaiting_exec', kind: 'instructions',
    triage: { kind: 'instructions', reason: 'wording', proposed_skill_md: '# GBP\nShort replies.', base_version: base } });
  return ask.id;
}

test('routes: Katherine can ask but cannot apply; Mimi (rung 3) applies and it becomes the next version; the character shows it', async (t) => {
  const store = createMemoryStore({ lint });
  const s = await serve(app(store), t);
  const k = as('khowe@infinityhospitality.net');
  const m = as('mimi@infinityhospitality.net');
  const asked = await call(s, '/api/agents/gbp/asks', { headers: k, method: 'POST', body: { ask: 'reply to Knot reviews too' } });
  assert.strictEqual(asked.json.ask.status, 'new');
  assert.strictEqual((await call(s, '/api/agents/gbp/asks', { headers: k, method: 'POST', body: { ask: 'x' } })).status, 400);
  const id = await proposed(store);
  assert.strictEqual((await call(s, `/api/agents/asks/${id}/decide`, { headers: k, method: 'POST', body: { decision: 'apply' } })).status, 403);
  const ok = await call(s, `/api/agents/asks/${id}/decide`, { headers: m, method: 'POST', body: { decision: 'apply' } });
  assert.strictEqual(ok.json.ask.status, 'applied');
  assert.strictEqual(ok.json.settings.version, 1);
  assert.strictEqual(ok.json.settings.skill_md, '# GBP\nShort replies.');
  assert.match(ok.json.settings.note, /ask #\d+ from khowe@infinityhospitality.net, approved by mimi@infinityhospitality.net/);
  assert.strictEqual((await call(s, `/api/agents/asks/${id}/decide`, { headers: m, method: 'POST', body: { decision: 'apply' } })).status, 409, 'applied once');
  const list = await call(s, '/api/agents', { headers: m });
  assert.strictEqual(list.json.exec, true);
  const gbp = list.json.agents.find((a) => a.slug === 'gbp');
  assert.ok(gbp.character.does.some((x) => /write shorter replies \(added from ask/.test(x)));
  assert.match(gbp.character.role, /concierge/);
  assert.strictEqual((await call(s, '/api/agents', { headers: k })).json.exec, false);
});

test('routes KNOWN-BAD: a proposal made against older instructions is not applied; it goes back to be sorted again', async (t) => {
  const store = createMemoryStore({ lint });
  const s = await serve(app(store), t);
  const id = await proposed(store, 'gbp', 0);
  await store.saveSettings('gbp', { skill_md: '# GBP\nKatherine edited this meanwhile.', max_cards: 2, who: 'khowe@x' });
  const r = await call(s, `/api/agents/asks/${id}/decide`, { headers: as('mimi@infinityhospitality.net'), method: 'POST', body: { decision: 'apply' } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await store.getAsk(id)).status, 'new');
  assert.strictEqual((await store.currentSettings('gbp')).skill_md, '# GBP\nKatherine edited this meanwhile.');
});

test('routes: decline records the note; a cant shows under Traits with what it does instead', async (t) => {
  const store = createMemoryStore({ lint });
  const s = await serve(app(store), t);
  const m = as('mimi@infinityhospitality.net');
  const id = await proposed(store);
  const d = await call(s, `/api/agents/asks/${id}/decide`, { headers: m, method: 'POST', body: { decision: 'decline', note: 'keep them warm' } });
  assert.strictEqual(d.json.ask.status, 'declined');
  const { ask } = await store.createAsk('citations', 'log in to The Knot and update it', 'khowe@x');
  await store.updateAsk(ask.id, { status: 'cant', kind: 'cant', triage: { kind: 'cant', reason: 'fence', instead: 'Writes the pack for a person to paste' } });
  const l = (await call(s, '/api/agents', { headers: m })).json.agents.find((a) => a.slug === 'citations');
  assert.ok(l.character.traits.some((tr) => tr.cant === 'log in to The Knot and update it' && /paste/.test(tr.instead)));
});
