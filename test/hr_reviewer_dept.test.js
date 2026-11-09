'use strict';
// HR's agent team on NB's weekly scorecard: one bridge GET, no staff names.
const test = require('node:test');
const assert = require('node:assert');
const W = require('../lib/reviewer-watch');

const ENV = { DISPATCH_BRIDGE_TOKEN: 'bridge-tok', DISPATCH_BRIDGE_URL: 'https://dispatch.test' };
const BODY = {
  department: 'hr',
  findings: [
    { id: 1, slug: 'file_fixer', status: 'open', title: 'Jane Doe: no phone', first_seen_at: '2026-10-27T15:00:00Z' },
    { id: 2, slug: 'time_punch_partner', status: 'done', closed_by: 'hr@infinityhospitality.net', closed_at: '2026-10-29T15:00:00Z', first_seen_at: '2026-10-27T15:00:00Z' },
    { id: 3, slug: 'onboarding_buddy', status: 'cleared', closed_by: 'machine:not found', closed_at: '2026-10-29T15:00:00Z', first_seen_at: '2026-10-27T15:00:00Z' },
  ],
  runs: [{ slug: 'hr_admiral', started_at: '2026-10-28T15:00:00Z', ok: true }],
  asks: [], settings: [],
  visits: [{ page: '/hr/agents', email: 'hr@infinityhospitality.net', at: '2026-10-28T15:00:00Z' }],
};
function fakeFetch(seen, res) {
  return async (url, opts) => { seen.push({ url, opts }); const r = res || { status: 200, body: BODY }; return { ok: r.status < 300, status: r.status, json: async () => r.body }; };
}

test('HR is registered: Layne, /hr/agents, no handover line, read from Dispatch', () => {
  const d = W.department('hr');
  assert.equal(d.head, 'Layne Wyckmans');
  assert.deepStrictEqual(d.head_emails, ['hr@infinityhospitality.net']);
  assert.equal(d.review_page, '/hr/agents');
  assert.equal(d.handover, false);
  assert.equal(typeof d.read, 'function');
});

test('reader: one GET of the HR bridge path; no staff name survives even if Dispatch sent one', async () => {
  const seen = [];
  const rows = await W.readHrRows(new Date('2026-10-26T05:00:00Z'), { fetchImpl: fakeFetch(seen), env: ENV });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://dispatch.test/api/brain/portal/hr-reviewer-rows?since=2026-10-26T05%3A00%3A00.000Z');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer bridge-tok');
  assert.equal(rows.cards.length, 3);
  assert.ok(rows.cards.every((c) => !/Jane/.test(c.title)));
  assert.equal(rows.cards[0].title, 'File Fixer finding (names stay on Dispatch)');
  assert.deepStrictEqual(rows.cards.map((c) => c.status), ['draft', 'ready', 'archived']);
  assert.equal(rows.cards[2].decided_by, 'the Box (no longer found)');
  assert.equal(rows.visits[0].dept, 'hr');
});

test('fails closed: no token asks nothing; a refusal becomes an HR "not read" card', async () => {
  const seen = [];
  await assert.rejects(W.readHrRows(new Date(), { fetchImpl: fakeFetch(seen), env: {} }), /DISPATCH_BRIDGE_TOKEN is not set/);
  assert.equal(seen.length, 0);
  const read = async () => ({ cards: [], runs: [], asks: [], settings: [], visits: [] });
  const cards = await W.scorecards({ pool: {}, since: new Date('2026-10-26T05:00:00Z'), now: new Date('2026-11-02T15:00:00Z'), read,
    deps: { fetchImpl: fakeFetch([], { status: 403, body: {} }), env: ENV } });
  const hr = cards.find((c) => c.department === 'hr');
  assert.match(hr.unavailable, /Dispatch answered 403/);
  const md = W.renderMarkdown(cards, { base: 'https://marketing.test' });
  assert.match(md, /## HR: Layne Wyckmans/);
  assert.deepStrictEqual(W.labelWords(md), []);
});

test('a full HR week renders with the agreed words and no judgment words', async () => {
  const read = async () => ({ cards: [], runs: [], asks: [], settings: [], visits: [] });
  const cards = await W.scorecards({ pool: {}, since: new Date('2026-10-26T05:00:00Z'), now: new Date('2026-11-02T15:00:00Z'), read,
    deps: { fetchImpl: fakeFetch([]), env: ENV } });
  const md = W.renderMarkdown(cards, { base: 'https://marketing.test' });
  assert.match(md, /## HR: Layne Wyckmans/);
  const hrPart = md.slice(md.indexOf('## HR:'));
  assert.doesNotMatch(hrPart, /Jane/);
  assert.match(hrPart, /marked done 1/);
  assert.deepStrictEqual(W.labelWords(md), []);
});
