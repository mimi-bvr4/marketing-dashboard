// ORDER #1733: the fenced, read-only HubSpot marketing-email statistics reader
// and the Email agent's scorecard source on top of it. Every HTTP call here is
// a stub: no live HubSpot or dashboard call in the suite.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const express = require('express');

const S = require('../lib/hubspot-email-stats');
const { createEmailStatsRouter } = require('../routes/email-stats');
const { runAgent } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const ENV = { HUBSPOT_TOKEN: 'pat-test-not-a-real-token' };
const RANGE = { label: '2026-10', start: '2026-10-01T00:00:00-05:00', end: '2026-10-31T23:59:59-05:00' };

function spy(status, body) {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status, json: async () => body }; };
  return { calls, fetchImpl };
}

const OK_BODY = {
  aggregate: { counters: { sent: 1000, delivered: 980, open: 410, click: 52, unsubscribed: 6, hardbounced: 8, softbounced: 12, spamreport: 1 },
    ratios: { openratio: 41.8 } },
  emails: [{ id: 1, name: 'Wedding nurture 1' }],
  objects: [{ email: 'bride@example.com', firstname: 'Ann' }],
};

test('the fence: a POST and an off-list path are refused before any network call', async () => {
  const s = spy(200, OK_BODY);
  const post = await S.request({ method: 'POST', path: S.STATS_PATH, env: ENV, fetchImpl: s.fetchImpl });
  const off = await S.request({ path: '/crm/v3/objects/contacts', env: ENV, fetchImpl: s.fetchImpl });
  const del = await S.request({ method: 'DELETE', path: S.STATS_PATH, env: ENV, fetchImpl: s.fetchImpl });
  assert.strictEqual(s.calls.length, 0);
  assert.ok(post.refused && /POST is not allowed \(GET only\)/.test(post.why), post.why);
  assert.ok(off.refused && /not on the allow-list/.test(off.why), off.why);
  assert.ok(del.refused);
  assert.deepStrictEqual([...S.ALLOWED_PATHS], [S.STATS_PATH]);
});

test('no token: fails closed with a reason and makes no call', async () => {
  const s = spy(200, OK_BODY);
  const r = await S.emailStats({ range: RANGE, env: {}, fetchImpl: s.fetchImpl });
  assert.strictEqual(s.calls.length, 0);
  assert.deepStrictEqual([r.ok, r.why], [false, 'no HUBSPOT_TOKEN in this environment']);
});

test('a 200 gives aggregate counts only: one GET to the allow-listed path, no email names, no contact fields', async () => {
  const s = spy(200, OK_BODY);
  const r = await S.emailStats({ range: RANGE, env: ENV, fetchImpl: s.fetchImpl });
  assert.ok(r.ok, r.why);
  assert.deepStrictEqual(r.counts, { sent: 1000, delivered: 980, opens: 410, clicks: 52, unsubscribes: 6, hard_bounces: 8, soft_bounces: 12, spam_reports: 1 });
  assert.strictEqual(s.calls.length, 1);
  const u = new URL(s.calls[0].url);
  assert.strictEqual(s.calls[0].opts.method, 'GET');
  assert.strictEqual(u.origin + u.pathname, 'https://api.hubapi.com' + S.STATS_PATH);
  assert.strictEqual(u.searchParams.get('startTimestamp'), RANGE.start);
  assert.strictEqual(u.searchParams.get('endTimestamp'), RANGE.end);
  assert.strictEqual(s.calls[0].opts.headers.Authorization, 'Bearer pat-test-not-a-real-token');
  const out = JSON.stringify(r);
  assert.doesNotMatch(out, /@|bride|Ann|Wedding nurture|pat-test/);
});

test('401/403 fail closed as "scope missing", naming only what HubSpot named', async () => {
  const named = await S.emailStats({ range: RANGE, env: ENV,
    fetchImpl: spy(403, { status: 'error', category: 'MISSING_SCOPES', errors: [{ context: { requiredGranularScopes: ['scope-from-hubspot'] } }] }).fetchImpl });
  assert.deepStrictEqual([named.ok, named.why], [false, 'scope missing: scope-from-hubspot']);
  const unnamed = await S.emailStats({ range: RANGE, env: ENV, fetchImpl: spy(401, { message: 'bad' }).fetchImpl });
  assert.deepStrictEqual([unnamed.ok, unnamed.why], [false, 'scope missing: HubSpot did not name the scope']);
});

test('a 404, another status, a thrown fetch or an answer without counters all fail closed with no number', async () => {
  const nf = await S.emailStats({ range: RANGE, env: ENV, fetchImpl: spy(404, {}).fetchImpl });
  assert.match(nf.why, /^endpoint not found \(404/);
  assert.strictEqual((await S.emailStats({ range: RANGE, env: ENV, fetchImpl: spy(500, {}).fetchImpl })).why, 'HubSpot answered 500');
  const thrown = await S.emailStats({ range: RANGE, env: ENV, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.match(thrown.why, /could not be reached: ECONNRESET/);
  const empty = await S.emailStats({ range: RANGE, env: ENV, fetchImpl: spy(200, { emails: [] }).fetchImpl });
  assert.deepStrictEqual([empty.ok, empty.counts], [false, undefined]);
});

test('last month is the Nashville calendar month, daylight or standard time', () => {
  assert.deepStrictEqual(S.lastMonth(new Date('2026-11-03T11:00:00Z')), RANGE);
  assert.deepStrictEqual(S.lastMonth(new Date('2027-01-03T12:00:00Z')),
    { label: '2026-12', start: '2026-12-01T00:00:00-06:00', end: '2026-12-31T23:59:59-06:00' });
  // 04:30 UTC on 11.01 is 23:30 CT on 10.31: still October in Nashville, so last month is September
  assert.strictEqual(S.lastMonth(new Date('2026-11-01T04:30:00Z')).label, '2026-09');
});

async function serve(router) {
  const app = express(); app.use(router);
  const srv = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test('route: ?month picks that month, a bad month is 400, and only a success is cached', async () => {
  const seen = []; let answer = { ok: false, why: 'scope missing: x' };
  const s = await serve(createEmailStatsRouter({ stats: async ({ range }) => { seen.push(range.label); return { ...answer, range }; },
    now: () => new Date('2026-11-03T12:00:00Z') }));
  try {
    assert.strictEqual((await fetch(s.base + '/api/funnel/email-stats?month=2026-13')).status, 400);
    const a = await (await fetch(s.base + '/api/funnel/email-stats')).json();
    assert.deepStrictEqual([a.ok, a.why, a.range.label], [false, 'scope missing: x', '2026-10']);
    answer = { ok: true, counts: { sent: 3 } };
    const r1 = await fetch(s.base + '/api/funnel/email-stats?month=2026-12');
    assert.strictEqual((await r1.json()).range.end, '2026-12-31T23:59:59-06:00');
    const r2 = await fetch(s.base + '/api/funnel/email-stats?month=2026-12');
    assert.strictEqual(r2.headers.get('x-cache'), 'HIT');
    await fetch(s.base + '/api/funnel/email-stats');
    assert.deepStrictEqual(seen, ['2026-10', '2026-12', '2026-10']);
  } finally { s.close(); }
});

function fakeModel(answers) {
  const calls = [];
  return { calls, model: 'test', complete: async (a) => { calls.push(a); return answers[Math.min(calls.length - 1, answers.length - 1)]; } };
}

test('the 3rd with the read working: the scorecard gets measured counts, and the numbers on the card are the measured ones', async () => {
  const store = createMemoryStore({ lint });
  const llm = fakeModel(['{"cards":[{"title":"Email scorecard, October 2026","body":"Three next moves."}]}']);
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push([url, opts.headers.Authorization]);
    return { status: 200, json: async () => ({ ok: true, range: RANGE, counts: { sent: 1000, delivered: 980, opens: 410 }, fetched_at: '2026-11-03T11:00:00.000Z' }) };
  };
  const r = await runAgent({ slug: 'email', store, llm, env: { IHG_TREE: os.tmpdir(), MARKETING_FLEET_KEY: 'mkt_test', MARKETING_BASE_URL: 'https://example.test' },
    fetchImpl, log: () => {}, scheduled: true });
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(seen, [['https://example.test/api/funnel/email-stats', 'Bearer mkt_test']]);
  assert.strictEqual(llm.calls.length, 1);
  assert.match(llm.calls[0].user, /=== HubSpot marketing email analytics \(last month\) ===/);
  assert.match(r.cards[0].body, /### Measured: HubSpot marketing email analytics \(last month\)/);
  assert.match(r.cards[0].body, /\| opens \| 410 \| 41\.0% \|/);
  assert.match(r.cards[0].body, /2026-10-01 to 2026-10-31/);
});
