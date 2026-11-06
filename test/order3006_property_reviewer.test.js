'use strict';
// ORDER #3006 part C: Baylee's property agents registered with the master
// agent (#2962). Her department reads Dispatch's bridge
// (GET /api/brain/portal/property-reviewer-rows) with the bridge token this
// service already holds; the fetch is faked here, Dispatch is never reached.
// Facts only, Mimi and NB only, nothing sent, nobody contacted.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const W = require('../lib/reviewer-watch');

const BAYLEE = 'executiveassistant@infinityhospitality.net';
const NOW = new Date('2026-11-09T15:00:00Z'); // Monday; the week counted is 11.02 to 11.08
const PROPS = W.department('properties');

const DISPATCH = {
  department: 'properties', head_emails: [BAYLEE], page: '/properties/agents',
  findings: [
    { id: 1, slug: 'lease_watch', title: 'Hill Building: Renewal notice deadline', is_money: false, status: 'open', closed_by: null, closed_at: null, first_seen_at: '2026-11-03T12:00:00Z' },
    { id: 2, slug: 'rent_late_watch', title: null, is_money: true, status: 'open', closed_by: null, closed_at: null, first_seen_at: '2026-11-04T12:00:00Z' },
    { id: 3, slug: 'lease_watch', title: 'Hill Building: Rent step', is_money: false, status: 'done', closed_by: BAYLEE, closed_at: '2026-11-05T16:00:00Z', first_seen_at: '2026-11-05T12:00:00Z' },
    { id: 4, slug: 'maintenance_safety_watch', title: 'Blanton: Smoke alarm test', is_money: false, status: 'cleared', closed_by: 'machine:no longer found', closed_at: '2026-11-06T12:00:00Z', first_seen_at: '2026-11-02T12:00:00Z' },
    { id: 5, slug: 'lease_watch', title: 'Hill Building: Option date', is_money: false, status: 'snoozed', closed_by: BAYLEE, closed_at: null, first_seen_at: '2026-11-03T12:00:00Z' },
  ],
  runs: [{ slug: 'lease_watch', started_at: '2026-11-05T11:00:00Z', ok: true, trigger: 'schedule' }, { slug: 'lease_watch', started_at: '2026-11-07T11:00:00Z', ok: false, trigger: 'schedule' }],
  asks: [{ slug: 'lease_watch', asked_by: BAYLEE, status: 'applied', asked_at: '2026-11-04T14:00:00Z' }],
  settings: [{ slug: 'lease_watch', version: 2, edited_by: BAYLEE, created_at: '2026-11-04T14:00:00Z' }],
  visits: [{ page: '/properties/agents', at: '2026-11-06T15:00:00Z', email: BAYLEE }],
};

function fakeFetch(seen, answer) {
  return async (url, opts) => {
    seen.push({ url, opts });
    const a = answer || { status: 200, body: DISPATCH };
    return { ok: a.status === 200, status: a.status, json: async () => a.body };
  };
}
const ENV = { DISPATCH_BRIDGE_TOKEN: 'bridge-tok', DISPATCH_BRIDGE_URL: 'https://dispatch.test' };

test('Baylee\'s department is registered: head, page, no handover line, no visit recorded on this service', () => {
  assert.ok(PROPS);
  assert.equal(PROPS.head, 'Baylee Hinch');
  assert.deepStrictEqual(PROPS.head_emails, [BAYLEE]);
  assert.equal(PROPS.review_page, '/properties/agents');
  assert.deepStrictEqual(PROPS.visit_pages, []);
  assert.equal(PROPS.handover, false);
  assert.equal(typeof PROPS.read, 'function');
  assert.equal(W.department('marketing').read, undefined, 'marketing still reads its own database');
});

test('reader: one GET of the bridge with the bridge token; since in the query', async () => {
  const seen = [];
  const rows = await W.readPropertyRows(new Date('2026-10-26T05:00:00Z'), { fetchImpl: fakeFetch(seen), env: ENV });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://dispatch.test/api/brain/portal/property-reviewer-rows?since=2026-10-26T05%3A00%3A00.000Z');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer bridge-tok');
  assert.equal(seen[0].opts.method, undefined, 'GET');
  assert.equal(rows.cards.length, 5);
});

test('reader fails closed: no token asks nothing; a refusal is said, never zeros', async () => {
  const seen = [];
  await assert.rejects(W.readPropertyRows(new Date(), { fetchImpl: fakeFetch(seen), env: {} }), /DISPATCH_BRIDGE_TOKEN is not set/);
  assert.equal(seen.length, 0);
  await assert.rejects(W.readPropertyRows(new Date(), { fetchImpl: fakeFetch(seen, { status: 403, body: {} }), env: ENV }), /Dispatch answered 403/);
});

test('mapping: open waits, Done is her decision, cleared is the system, snoozed is neither; money has no title', () => {
  const r = W.mapPropertyRows(DISPATCH);
  const by = Object.fromEntries(r.cards.map((c) => [c.id, c]));
  assert.equal(by[1].status, 'draft');
  assert.equal(by[2].title, 'money finding (its title stays on Dispatch)');
  assert.equal(by[3].status, 'ready');
  assert.equal(by[3].decided_by, BAYLEE);
  assert.equal(by[4].status, 'archived');
  assert.ok(W.MACHINE_WHO.test(by[4].decided_by), 'cleared counts as the system');
  assert.equal(by[5].status, 'snoozed');
  assert.equal(by[5].decided_at, null);
  assert.equal(r.visits[0].dept, 'properties');
});

test('the scorecard: every number traces to a Dispatch row', () => {
  const s = W.scorecard({ dept: PROPS, rows: W.mapPropertyRows(DISPATCH), now: NOW });
  assert.equal(s.week_start, '2026-11-02');
  assert.equal(s.handover_at, null);
  assert.equal(s.week.drafts_made, 5);          // ids 1-5 first seen 11.02-11.05
  assert.equal(s.week.runs, 2);
  assert.equal(s.week.approved, 1);             // id 3, marked done by Baylee
  assert.deepStrictEqual(s.week.per_person, [{ who: BAYLEE, approved: 1, rejected: 0, archived: 0 }]);
  assert.equal(s.week.decided_by_machine, 1);   // id 4
  assert.equal(s.week.hours_to_decide_median, 4);
  assert.equal(s.week.asks, 1);
  assert.equal(s.week.instruction_edits, 1);
  assert.equal(s.week.approved_use[0].use, 'marked done; what was done: not trackable yet');
  assert.equal(s.now.drafts_waiting, 2);        // ids 1 and 2; the snoozed one is not waiting
  assert.equal(s.now.last_agents_visit, '2026-11-06T15:00:00.000Z');
  assert.equal(s.now.runs_since_last_visit, 1);
  assert.match(s.now.oldest_untouched[0].link, /^https?:\/\/.+\/properties\/agents$/);
});

test('scorecards(): marketing from its database, Baylee from the bridge; a bridge failure is one "not read" card, never a 500', async () => {
  let localReads = 0;
  const read = async () => { localReads++; return { cards: [], runs: [], asks: [], settings: [], visits: [] }; };
  const ok = await W.scorecards({ pool: {}, since: new Date('2026-10-26T05:00:00Z'), now: NOW, read, deps: { fetchImpl: fakeFetch([]), env: ENV } });
  assert.deepStrictEqual(ok.map((c) => c.department), ['marketing', 'properties']);
  assert.equal(localReads, 1);
  assert.equal(ok[1].week.approved, 1);
  const bad = await W.scorecards({ pool: {}, since: new Date('2026-10-26T05:00:00Z'), now: NOW, read, deps: { fetchImpl: fakeFetch([]), env: {} } });
  assert.match(bad[1].unavailable, /DISPATCH_BRIDGE_TOKEN is not set/);
  assert.equal(bad[1].week, undefined, 'no zeros in place of facts');
});

test('the words: findings and "marked done", absolute links, no judgment words, and an unavailable card says why', async () => {
  const cards = await W.scorecards({ pool: {}, since: new Date('2026-10-26T05:00:00Z'), now: NOW,
    read: async () => ({ cards: [], runs: [], asks: [], settings: [], visits: [] }), deps: { fetchImpl: fakeFetch([]), env: ENV } });
  const md = W.renderMarkdown(cards, { base: 'https://marketing.test' });
  assert.match(md, /## Properties: Baylee Hinch/);
  assert.match(md, /- Findings the agents made: 5/);
  assert.match(md, /marked done 1 \(prior week 0\)/);
  assert.doesNotMatch(md, /https:\/\/marketing\.testhttps?:/, 'a Dispatch link is never prefixed with the marketing base');
  assert.deepStrictEqual(W.labelWords(md), []);
  const off = W.renderMarkdown([W.unavailableCard(PROPS, 'Dispatch answered 403', '2026-11-02')]);
  assert.match(off, /Not read this week: Dispatch answered 403\./);
  assert.deepStrictEqual(W.labelWords(off), []);
});

test('fences: the reader and the page send nothing; no em dashes; the switch is still REVIEWER_WATCH (no new switch)', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib/reviewer-watch.js'), 'utf8');
  const start = lib.indexOf('async function readPropertyRows');
  const reader = lib.slice(start, lib.indexOf('\n}\n', start));
  assert.doesNotMatch(reader, /method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(lib, /sendMail|nodemailer|twilio|gmail/i);
  for (const f of ['lib/reviewer-watch.js', 'routes/reviewer-watch.js', 'jobs/reviewer_watch.js', 'public/reviewer-watch.html', 'test/order3006_property_reviewer.test.js']) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', f), 'utf8').includes(String.fromCharCode(0x2014)), false, f);
  }
  assert.equal(W.FLAG, 'REVIEWER_WATCH');
  assert.equal(W.watchOn({}), false);
});
