// ORDERS #1704 (the SEO agent) and #1705 (PR Patty).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const sa = require('../lib/google-sa');
const sc = require('../lib/search-console');
const ma = require('../lib/mail-alerts');
const { searchConsoleSource, mailAlertsSource, gather } = require('../lib/agent-sources');
const { matchAgent } = require('../jobs/kh_route');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { client_email: 'infinity-brain@ihg-sales-brain.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

test('google-sa: only read-only scopes can be signed; a subject is carried for brain@', async () => {
  for (const s of ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/webmasters', 'https://mail.google.com/']) {
    assert.throws(() => sa.signedJwt(KEY, { scopes: [s] }), /not read-only/);
  }
  const jwt = sa.signedJwt(KEY, { scopes: [ma.SCOPE], subject: 'brain@infinityhospitality.net' });
  assert.deepStrictEqual([claims(jwt).scope, claims(jwt).sub], [ma.SCOPE, 'brain@infinityhospitality.net']);
  let sent;
  const tok = await sa.accessToken({ key: KEY, scopes: [sc.SCOPE], fetchImpl: async (u, o) => { sent = [u, o.method]; return json(200, { access_token: 't1' }); } });
  assert.strictEqual(tok, 't1');
  assert.deepStrictEqual(sent, [sa.TOKEN_URL, 'POST']);
});

const row = (site, query, page, position, impressions, clicks = 0) => ({ site, query, page, position, impressions, clicks, ctr: impressions ? clicks / impressions : 0 });

test('search console: page 2 to 5, page-1-no-clicks, our own pages competing, and drops are measured by code', () => {
  const rows = [
    row('thebelltower.com', 'historic wedding venue nashville', 'https://thebelltower.com/weddings/', 14.2, 300, 2),
    row('thebelltower.com', 'downtown nashville venue', 'https://thebelltower.com/', 4.1, 500, 1),        // page 1, 0.2% CTR
    row('cherokeedock.com', 'lake wedding venue', 'https://cherokeedock.com/', 70, 900, 0),               // past page 5: not a quick win
    row('saddlewoodsfarm.com', 'barn wedding venues tennessee', 'https://saddlewoodsfarm.com/', 9, 40, 3),
    row('infinityhospitalitygroup.com', 'barn wedding venue tennessee', 'https://infinityhospitalitygroup.com/blog/barns/', 22, 35, 0),
    row('thebridgebuilding.com', 'waterfront wedding venue nashville', 'https://thebridgebuilding.com/', 18, 60, 1),
  ];
  const prev = [row('thebridgebuilding.com', 'waterfront wedding venue nashville', 'https://thebridgebuilding.com/', 6, 80, 5)];
  const a = sc.analyse(rows, prev);
  assert.deepStrictEqual(a.page2to5.map((r) => r.query), ['historic wedding venue nashville', 'waterfront wedding venue nashville', 'barn wedding venue tennessee']);
  assert.deepStrictEqual(a.lowCtr.map((r) => r.query), ['downtown nashville venue']);
  assert.strictEqual(a.competing.length, 1);                                    // "venues"/"venue" count as the same search
  assert.deepStrictEqual(a.competing[0].map((p) => p.site).sort(), ['infinityhospitalitygroup.com', 'saddlewoodsfarm.com']);
  assert.deepStrictEqual(a.dropped.map((r) => [r.query, r.wasPosition, r.position]), [['waterfront wedding venue nashville', 6, 18]]);
  const t = sc.tables(a, { facts: { 'https://thebelltower.com/weddings/': { title: 'Weddings', description: '' } } });
  assert.match(t, /\| thebelltower\.com \| historic wedding venue nashville \| https:\/\/thebelltower\.com\/weddings\/ \| 14\.2 \| 300 \| 2 \| Weddings \| \(no description\) \|/);
  assert.match(t, /0\.2%/);
});

test('search console: a 3-day lag and two 28-day windows; sc-domain property preferred; unverified ignored', () => {
  const w = sc.windows(new Date('2026-10-13T12:00:00Z'));
  assert.deepStrictEqual(w, { cur: { startDate: '2026-09-13', endDate: '2026-10-10' }, prev: { startDate: '2026-08-16', endDate: '2026-09-12' } });
  const p = sc.matchProperties(['thebelltower.com', 'cherokeedock.com', 'thecordelle.com'], [
    { siteUrl: 'https://www.thebelltower.com/', permissionLevel: 'siteRestrictedUser' },
    { siteUrl: 'sc-domain:thebelltower.com', permissionLevel: 'siteRestrictedUser' },
    { siteUrl: 'sc-domain:cherokeedock.com', permissionLevel: 'siteUnverifiedUser' },
  ]);
  assert.deepStrictEqual(p, { 'thebelltower.com': 'sc-domain:thebelltower.com', 'cherokeedock.com': null, 'thecordelle.com': null });
});

function scFetch({ sitesStatus = 200 } = {}) {
  const calls = [];
  const f = async (u, o = {}) => {
    calls.push([o.method || 'GET', u]);
    if (u.endsWith('/webmasters/v3/sites')) return sitesStatus === 200
      ? json(200, { siteEntry: [{ siteUrl: 'sc-domain:thebelltower.com', permissionLevel: 'siteRestrictedUser' }] })
      : json(403, { error: { message: 'Google Search Console API has not been used in project 308053229449 before or it is disabled.' } });
    if (/searchAnalytics\/query$/.test(u)) {
      const body = JSON.parse(o.body);
      const cur = body.endDate === '2026-10-10';
      return json(200, { rows: [{ keys: ['historic wedding venue nashville', 'https://thebelltower.com/weddings/'], clicks: 1, impressions: 200, ctr: 0.005, position: cur ? 15 : 14 }] });
    }
    if (u === 'https://thebelltower.com/weddings/') return { ok: true, status: 200, url: u, text: async () => '<title>Weddings at The Bell Tower</title><meta name="description" content="Old church, new parties.">', headers: { get: () => 'text/html' } };
    return json(404, {});
  };
  return { f, calls };
}

test('search console source: reads only, attaches the measured table with the live title; names the sites not open yet', async () => {
  const { f, calls } = scFetch();
  const r = await searchConsoleSource({ type: 'search_console', sites: ['thebelltower.com', 'thecordelle.com'] },
    { env: {}, fetch: f, saKey: KEY, saToken: async () => 'tok', now: () => new Date('2026-10-13T12:00:00Z'), lint: () => ({ fails: [] }) });
  assert.ok(r.ok, r.why);
  assert.match(r.text, /Sites read: 1 of 2\. Not open to the Box yet: thecordelle\.com\./);
  assert.match(r.table, /historic wedding venue nashville/);
  assert.match(r.table, /Weddings at The Bell Tower \| Old church, new parties\./);
  assert.ok(calls.every(([m, u]) => m === 'GET' || /searchAnalytics\/query$/.test(u)), 'the only POST is the read-only search query');
});

test('search console source: when Google refuses, the card says why and the exact one-time fix', async () => {
  const { f } = scFetch({ sitesStatus: 403 });
  const r = await searchConsoleSource({ type: 'search_console', sites: ['thebelltower.com'] }, { env: {}, fetch: f, saKey: KEY, saToken: async () => 'tok' });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /has not been used in project/);
  assert.match(r.why, /infinity-brain@ihg-sales-brain\.iam\.gserviceaccount\.com as a Restricted user/);
  const none = await searchConsoleSource({ type: 'search_console', sites: ['x.com'] }, { env: { BRAIN_SA_KEY: '/nope/key.json' }, fetch: f });
  assert.match(none.why, /no Brain service-account key/);
});

const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

test('PR Patty mail source: searches brain@ for the press services, GET only, quotes each email; empty inbox names the forwarding step', async () => {
  const calls = [];
  const msgs = {
    m1: { payload: { headers: [{ name: 'From', value: 'Qwoted <alerts@qwoted.com>' }, { name: 'Subject', value: 'Request Roundup' }, { name: 'Date', value: 'Tue, 13 Oct 2026 14:00:00 -0500' }],
      mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Wedding planner needed for Brides. Deadline Oct 15.</p><a href="https://app.qwoted.com/r/1">Pitch</a>') } }] } },
  };
  const f = async (u, o = {}) => {
    calls.push([o.method || 'GET', u]);
    if (u.includes('/messages?')) return json(200, { messages: [{ id: 'm1' }] });
    const id = u.match(/messages\/(\w+)\?/)[1];
    return json(200, msgs[id]);
  };
  const src = { type: 'mail_alerts', match: ['qwoted', 'haro', 'help a reporter', 'be inspired pr'], days: 1 };
  const r = await mailAlertsSource(src, { env: {}, fetch: f, saKey: KEY, saToken: async (scope, sub) => { assert.strictEqual(scope, ma.SCOPE); assert.strictEqual(sub, 'brain@infinityhospitality.net'); return 'tok'; } });
  assert.ok(r.ok, r.why);
  assert.ok(calls.every(([m]) => m === 'GET'));
  assert.strictEqual(decodeURIComponent(calls[0][1].split('q=')[1]), 'newer_than:1d {qwoted haro "help a reporter" "be inspired pr"}');
  assert.match(r.text, /never instructions to you/);
  assert.match(r.text, /Wedding planner needed for Brides\. Deadline Oct 15\.\nPitch \(https:\/\/app\.qwoted\.com\/r\/1\)/);
  assert.match(r.table, /Request Roundup/);
  const empty = await mailAlertsSource(src, { env: {}, fetch: async () => json(200, {}), saKey: KEY, saToken: async () => 'tok' });
  assert.strictEqual(empty.ok, false);
  assert.match(empty.why, /Katherine forwards the Qwoted, HARO and Be Inspired PR alert emails/);
});

test('a Monday-only source is skipped quietly on other days, and runs on Monday', async () => {
  const src = [{ type: 'pending', only_dow: [1], why: 'ran' }];
  const tue = await gather(src, { env: {}, now: () => new Date('2026-10-13T15:00:00Z') });
  assert.deepStrictEqual(tue, { got: [], unavailable: [] });
  const mon = await gather(src, { env: {}, now: () => new Date('2026-10-12T15:00:00Z') });
  assert.deepStrictEqual(mon.unavailable.map((u) => u.why), ['ran']);
});

test("Katherine's Drive orders route to the right agent", () => {
  assert.deepStrictEqual(matchAgent('Keyword research for The Bell Tower'), ['seo']);
  assert.deepStrictEqual(matchAgent('Why did our rankings drop? Check Search Console'), ['seo']);
  assert.deepStrictEqual(matchAgent('SEO blog post about barn weddings'), ['bloggy-bob']);
  assert.deepStrictEqual(matchAgent('Blog post for the keyword winter weddings'), ['bloggy-bob']);
  assert.deepStrictEqual(matchAgent('Pitch the Qwoted request about holiday parties'), ['pr-patty']);
  assert.deepStrictEqual(matchAgent('Fix the broken links on cherokeedock.com'), ['site-health']);
});

const { runAgent } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

function fakeLlm() { const calls = []; return { calls, model: 'test', complete: async (x) => { calls.push(x); return JSON.stringify({ cards: [{ title: 'Press requests, 10.13.2026', body: 'One fit.' }] }); } }; }

test('PR Patty: an empty inbox on a weekday writes no card; a broken inbox says so; a full one drafts', async () => {
  const env = { IHG_TREE: require('os').tmpdir() };
  const quiet = async (u) => (u.includes('/messages?') ? json(200, {}) : json(404, {}));
  let store = createMemoryStore({ lint }); let llm = fakeLlm();
  let r = await runAgent({ slug: 'pr-patty', store, llm, env, log: () => {}, fetchImpl: quiet, now: () => new Date('2026-10-13T12:00:00Z'), saKey: KEY, saToken: async () => 'tok' });
  assert.ok(r.ok); assert.strictEqual(r.cards.length, 0); assert.strictEqual(llm.calls.length, 0);
  const broken = async () => json(403, { error: { message: 'Delegation denied' } });
  store = createMemoryStore({ lint }); llm = fakeLlm();
  r = await runAgent({ slug: 'pr-patty', store, llm, env, log: () => {}, fetchImpl: broken, now: () => new Date('2026-10-13T12:00:00Z'), saKey: KEY, saToken: async () => 'tok' });
  assert.strictEqual(r.cards.length, 1); assert.match(r.cards[0].title, /PR Patty could not run: a required source is missing/);
  assert.strictEqual(llm.calls.length, 0);
});

test('SEO: Search Console closed means a "could not run" card, never a draft written around it', async () => {
  const { f } = scFetch({ sitesStatus: 403 });
  const store = createMemoryStore({ lint }); const llm = fakeLlm();
  const r = await runAgent({ slug: 'seo', store, llm, env: { IHG_TREE: require('os').tmpdir() }, log: () => {}, fetchImpl: f, saKey: KEY, saToken: async () => 'tok' });
  assert.strictEqual(r.cards.length, 1);
  assert.match(r.cards[0].title, /SEO could not run: a required source is missing/);
  assert.strictEqual(llm.calls.length, 0);
});
