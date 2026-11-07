'use strict';
// ORDER #3070 (Mimi ruled B on credential-3051-marketing-zz-test-user,
// 11.06.2026 19:03 CT): "Build MKT_TEST_PERSON_IDS so the ZZ_TEST canary gets
// Katherine's role on the dashboard and exec routes still refuse it."
//
// FEATURE FLAG: MKT_TEST_PERSON_IDS default OFF (empty), so nobody new is
// admitted until it is set. The canary is a Chef seat (rung 1 in Dispatch's
// RUNG_BY_BUNDLE), staff 376, person_775002ef2c2f.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';
delete process.env.MKT_TEST_PERSON_IDS;

const { isAllowed, KATHERINE_PERSON_ID } = require('../lib/access');
const { pageGate } = require('../middleware/page-gate');
const { createAgentsRouter, isExec } = require('../routes/agents');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const CANARY_ID = 'person_775002ef2c2f';
const CANARY = { active: true, rung: 1, person_id: CANARY_ID };
const CANARY_EMAIL = 'zz-test-canary@infinityhospitality.net';

function withFlag(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'MKT_TEST_PERSON_IDS');
  const before = process.env.MKT_TEST_PERSON_IDS;
  if (value === undefined) delete process.env.MKT_TEST_PERSON_IDS; else process.env.MKT_TEST_PERSON_IDS = value;
  try { return fn(); } finally {
    if (had) process.env.MKT_TEST_PERSON_IDS = before; else delete process.env.MKT_TEST_PERSON_IDS;
  }
}

test('(a) the canary is refused when MKT_TEST_PERSON_IDS is unset or empty', () => {
  withFlag(undefined, () => assert.strictEqual(isAllowed(CANARY), false, 'unset'));
  withFlag('', () => assert.strictEqual(isAllowed(CANARY), false, 'empty'));
  withFlag(' , ,', () => assert.strictEqual(isAllowed(CANARY), false, 'only blanks'));
});

test('(b) the canary is admitted when listed, with whitespace, or in a comma list', () => {
  withFlag(CANARY_ID, () => assert.strictEqual(isAllowed(CANARY), true, 'exact'));
  withFlag(`  ${CANARY_ID}  `, () => assert.strictEqual(isAllowed(CANARY), true, 'whitespace'));
  withFlag(`person_other00001, ${CANARY_ID} ,`, () => assert.strictEqual(isAllowed(CANARY), true, 'comma list'));
  withFlag('person_other00001', () => assert.strictEqual(isAllowed(CANARY), false, 'a different id does not admit it'));
  withFlag(`x${CANARY_ID}`, () => assert.strictEqual(isAllowed(CANARY), false, 'no substring match'));
});

test('(d) an inactive listed person is still refused', () => {
  withFlag(CANARY_ID, () => {
    assert.strictEqual(isAllowed({ ...CANARY, active: false }), false);
    assert.strictEqual(isAllowed({ rung: 1, person_id: CANARY_ID }), false, 'active missing');
  });
});

test('(e) Katherine and an exec are admitted exactly as before, flag set or not', () => {
  for (const flag of [undefined, '', CANARY_ID]) {
    withFlag(flag, () => {
      assert.strictEqual(isAllowed({ active: true, rung: 2, person_id: KATHERINE_PERSON_ID }), true);
      assert.strictEqual(isAllowed({ active: true, rung: 3, person_id: 'person_exec0001' }), true);
      assert.strictEqual(isAllowed({ active: true, rung: 2, person_id: 'person_mkt00002' }), false, 'another marketing seat stays out');
      assert.strictEqual(isAllowed({ active: false, rung: 3, person_id: 'person_exec0001' }), false);
    });
  }
});

// ---------------------------------------------------------------- (c) exec

function serve(a, t) { return new Promise((resolve) => { const s = http.createServer(a).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); }); }
function call(server, urlPath, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { const tx = Buffer.concat(c).toString(); let json = null; try { json = JSON.parse(tx); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
const as = (email) => ({ Cookie: `mkt_session=${jwt.sign({ role: 'sso', email, mkt_access: true }, process.env.JWT_SECRET)}` });
const identity = { lookup: async (email) => (email === CANARY_EMAIL ? CANARY : { active: false }) };

test('(c) with the flag set the canary is admitted but isExec stays false and /asks/:id/decide answers 403', async (t) => {
  process.env.MKT_TEST_PERSON_IDS = CANARY_ID;
  t.after(() => { delete process.env.MKT_TEST_PERSON_IDS; });
  assert.strictEqual(isAllowed(CANARY), true, 'the seat is real');
  assert.strictEqual(await isExec({ mktUser: { email: CANARY_EMAIL } }, identity), false);

  const store = createMemoryStore({ lint });
  const { ask } = await store.createAsk('gbp', 'write shorter replies', CANARY_EMAIL);
  await store.updateAsk(ask.id, { status: 'awaiting_exec', kind: 'instructions',
    triage: { kind: 'instructions', reason: 'wording', proposed_skill_md: '# GBP\nShort replies.', base_version: 0 } });
  const a = express(); a.use(express.json()); a.use(pageGate); a.use(createAgentsRouter({ store, identity }));
  const s = await serve(a, t);
  const r = await call(s, `/api/agents/asks/${ask.id}/decide`, { headers: as(CANARY_EMAIL), method: 'POST', body: { decision: 'apply' } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await store.listAsks())[0].status, 'awaiting_exec', 'nothing applied');
});
