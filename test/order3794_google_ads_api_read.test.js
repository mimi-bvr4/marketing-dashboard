// ORDER #3794: the Brain reads Google Ads directly through the API, live and
// read-only (replaces the #3567 export Sheet). No live account is read here:
// every call goes through a fake fetch, and the law is pinned in code:
//   - any mutate endpoint, any other path, any other method is refused BEFORE
//     a token is asked for or the network is touched;
//   - a read is one GAQL SELECT;
//   - no spend amount reaches the snapshot, a card or the Auditor's prompt;
//   - ADS_API_LIVE ships OFF and, off, the hourly job reads nothing.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/google-ads-read');
const M = require('../lib/google-ads-monitor');
const S = require('../lib/agent-sources');
const C = require('../lib/agent-checks');
const sa = require('../lib/google-sa');
const job = require('../jobs/ads_monitor');
const { loadAgent } = require('../lib/agent-runner');
const { pausedFor } = require('../lib/producer');

const ACC = '1234567890';
const ACC2 = '2222222222';
// Spend micros chosen to be unmistakable if an amount ever leaks into text.
const MICROS = { a: '412370000', b: '91530000', c: '233170000' };
const AMOUNTS = ['412.37', '91.53', '233.17', '412370000', '91530000', '233170000'];

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const a = answers(url, opts);
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  };
  fn.calls = calls;
  return fn;
}

test('guard: every mutate endpoint is refused by name, before a token or the network', async () => {
  for (const p of [`customers/${ACC}/googleAds:mutate`, `customers/${ACC}/campaigns:mutate`, `customers/${ACC}/campaignBudgets:mutate`,
    `customers/${ACC}/adGroupAds:mutate`, `customers/${ACC}/adGroupCriteria:mutate`, `customers/${ACC}/googleAds:searchMutate`]) {
    assert.throws(() => R.guard(p, 'POST'), /mutate endpoint/, p);
  }
  for (const [p, m] of [[`customers/${ACC}/googleAds:search`, 'GET'], [R.LIST_PATH, 'POST'], [`customers/${ACC}/googleAds:searchStream`, 'POST'],
    [`customers/${ACC}`, 'GET'], [`customers/${ACC}/googleAds:search`, 'DELETE'], ['customers/12/googleAds:search', 'POST']]) {
    assert.throws(() => R.guard(p, m), /refused/, `${m} ${p}`);
  }
  assert.doesNotThrow(() => R.guard(R.LIST_PATH, 'GET'));
  assert.doesNotThrow(() => R.guard(`customers/${ACC}/googleAds:search`, 'POST'));
  let asked = 0;
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const c = R.createClient({ env: {}, fetchImpl: f, token: async () => { asked++; return 't'; } });
  await assert.rejects(c.search(ACC, "UPDATE campaign SET campaign.status = 'PAUSED'"), /one GAQL SELECT/);
  await assert.rejects(c.search(ACC, 'SELECT campaign.id FROM campaign; SELECT 1'), /one GAQL statement/);
  await assert.rejects(c.search('12', 'SELECT campaign.id FROM campaign'), /10-digit/);
  assert.strictEqual(asked, 0, 'no token was asked for');
  assert.strictEqual(f.calls.length, 0, 'nothing reached the network');
});

test('the client: one GET to list, POST googleAds:search with paging; v26; login-customer-id only when set; no developer token', async () => {
  const f = fakeFetch((url, o) => {
    if (url.endsWith(R.LIST_PATH)) return { status: 200, body: { resourceNames: [`customers/${ACC}`, `customers/${ACC2}`] } };
    const b = JSON.parse(o.body);
    if (/FROM customer/.test(b.query)) return { status: 200, body: { results: [{ customer: { id: url.includes(ACC) ? ACC : ACC2, descriptiveName: url.includes(ACC) ? 'Fontanel' : 'The Bell Tower' } }] } };
    return b.pageToken ? { status: 200, body: { results: [{ n: 2 }] } } : { status: 200, body: { results: [{ n: 1 }], nextPageToken: 'p2' } };
  });
  const c = R.createClient({ env: { GOOGLE_ADS_LOGIN_CUSTOMER_ID: '999-888-7777' }, fetchImpl: f, token: async () => 'tok' });
  assert.deepStrictEqual(await R.listAccounts(c), [{ id: ACC, name: 'Fontanel' }, { id: ACC2, name: 'The Bell Tower' }]);
  assert.deepStrictEqual(await c.search(ACC, 'SELECT campaign.id FROM campaign'), [{ n: 1 }, { n: 2 }]);
  assert.strictEqual(f.calls[0].url, `https://googleads.googleapis.com/v26/${R.LIST_PATH}`);
  assert.strictEqual(f.calls[0].opts.method, 'GET');
  for (const k of f.calls) {
    assert.ok(['GET', 'POST'].includes(k.opts.method));
    assert.ok(!/mutate/i.test(k.url));
    assert.strictEqual(k.opts.headers.Authorization, 'Bearer tok');
    assert.strictEqual(k.opts.headers['login-customer-id'], '9998887777');
    assert.ok(!('developer-token' in k.opts.headers), 'developer tokens were sunset 09.09.2026');
    assert.ok(!k.url.includes('tok'), 'the token is never in a URL');
  }
  const f2 = fakeFetch(() => ({ status: 403, body: { error: { status: 'PERMISSION_DENIED' } } }));
  const c2 = R.createClient({ env: {}, fetchImpl: f2, token: async () => 'tok' });
  await assert.rejects(c2.accessible(), (e) => e.status === 403 && /PERMISSION_DENIED/.test(e.message));
  assert.ok(!('login-customer-id' in f2.calls[0].opts.headers));
});

test('the service account may sign the adwords scope, and only lib/google-ads-read.js asks for it', () => {
  assert.ok(sa.ALLOWED_SCOPES.has(R.SCOPE));
  const lib = path.join(__dirname, '..', 'lib');
  const users = fs.readdirSync(lib).filter((f) => f.endsWith('.js') && f !== 'google-sa.js' && /auth\/adwords/.test(fs.readFileSync(path.join(lib, f), 'utf8')));
  assert.deepStrictEqual(users, ['google-ads-read.js']);
  const src = fs.readFileSync(path.join(lib, 'google-ads-read.js'), 'utf8');
  assert.ok(!/['"](PUT|PATCH|DELETE)['"]/.test(src), 'no write method appears in the client');
});

test('ADS_API_LIVE ships OFF: off, a poll reads nothing and writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads3794-'));
  const lines = [];
  let read = 0;
  const client = { accessible: async () => { read++; return []; }, search: async () => { read++; return []; } };
  assert.strictEqual(await job.main({ argv: [], log: (l) => lines.push(l), env: { ADS_MONITOR_STATE_DIR: dir }, client }), 0);
  assert.strictEqual(read, 0);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.match(lines.join('\n'), /ADS_API_LIVE is off/);
  for (const v of ['', '0', 'off', 'false']) assert.strictEqual(R.flagOn({ ADS_API_LIVE: v }), false);
  assert.strictEqual(R.flagOn({ ADS_API_LIVE: 'on' }), true);
  const plist = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'launchd', 'com.infinitybrain.ads-monitor.plist'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/<key>ADS_API_LIVE<\/key>/.test(plist), 'the shipped plist does not turn the switch on');
  // #3821 replaced the hourly StartInterval with 06:15 and 13:15 (test/order3821_*).
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
});

test('--accounts lists customer id and name only, with the switch off', async () => {
  const lines = [];
  const client = { accessible: async () => [ACC], search: async () => [{ customer: { id: ACC, descriptiveName: 'Fontanel' } }] };
  assert.strictEqual(await job.main({ argv: ['--accounts'], log: (l) => lines.push(l), env: {}, client }), 0);
  assert.deepStrictEqual(lines, [`${ACC}  Fontanel`]);
});

// ---------------------------------------------------------------- the monitor, on a fixture
const NOW = new Date('2026-11-25T16:00:00Z'); // Wed 11.25.2026 10:00 CT
const TODAY = '2026-11-25';
const LASTWK = '2026-11-16';
const THISWK = '2026-11-23';

function account(id, name, { dropped = false, overlapTerm = 'nashville wedding venue', paused = false } = {}) {
  const daily = [];
  for (let k = 1; k <= 20; k++) {
    const date = R.addDays(TODAY, -k);
    const imp = dropped && k === 1 ? 0 : 100;
    if (imp) daily.push({ campaign_id: '11', campaign: 'Weddings', date, impressions: imp, clicks: 10, conversions: 1, spend: 50e6 });
  }
  daily.push({ campaign_id: '11', campaign: 'Weddings', date: TODAY, impressions: 30, clicks: 2, conversions: 0, spend: 10e6 });
  return {
    id, name,
    campaigns: [{ id: '11', name: 'Weddings', status: paused ? 'PAUSED' : 'ENABLED', primary_status: 'ELIGIBLE' }, { id: '12', name: 'Corporate', status: 'ENABLED', primary_status: 'LIMITED' }],
    daily,
    adGroups: [],
    keywords: [{ campaign: 'Weddings', ad_group: 'Barn', text: 'wedding venue', match_type: 'BROAD', final_urls: ['https://fontanel.example/gone'], week: LASTWK, impressions: 300, clicks: 20, conversions: 0, spend: Number(MICROS.a) / 10 }],
    terms: [
      { campaign: 'Weddings', ad_group: 'Barn', text: 'free wedding venues', week: LASTWK, impressions: 200, clicks: 12, conversions: 0, spend: Number(MICROS.b) },
      { campaign: 'Weddings', ad_group: 'Barn', text: overlapTerm, week: THISWK, impressions: 40, clicks: 3, conversions: 0, spend: 1e6 },
    ],
    ads: [{ campaign: 'Weddings', ad_group: 'Barn', id: '777', final_urls: ['https://fontanel.example/weddings'], status: 'ENABLED', approval: 'DISAPPROVED' }],
  };
}

test('the five flags: zero conversions past the threshold, drop to 0, disapproved / limited / newly paused, 404 URLs, two venues on one term', async () => {
  const a = account(ACC, 'Fontanel', { dropped: true });
  const b = account(ACC2, 'The Bell Tower', { paused: true });
  const prior = { campaigns: { [ACC2]: { 11: 'ENABLED' } }, flagged: [] };
  const flags = M.flagsFor([a, b], prior, { now: NOW, env: {} });
  const kinds = (k) => flags.filter((f) => f.kind === k);
  assert.ok(kinds('zero_conv').some((f) => /search term "free wedding venues"/.test(f.text) && /0 conversions/.test(f.text) && /% of the account's spend/.test(f.text)));
  assert.ok(kinds('drop').some((f) => /Fontanel: campaign "Weddings" dropped to 0 impressions on 2026-11-24/.test(f.text)));
  assert.ok(!kinds('drop').some((f) => /Bell Tower/.test(f.text)), 'the paused campaign is not reported as a drop');
  assert.strictEqual(kinds('disapproved').length, 2);
  assert.strictEqual(kinds('limited').length, 2);
  assert.deepStrictEqual(kinds('paused').map((f) => f.text), ['The Bell Tower: campaign "Weddings" was running at the last check and is paused now']);
  assert.ok(kinds('overlap').some((f) => /"nashville wedding venue": Fontanel and The Bell Tower/.test(f.text)));
  // A higher threshold quiets the zero-conversion flag.
  assert.strictEqual(M.flagsFor([a, b], prior, { now: NOW, env: { ADS_ZERO_CONV_SHARE_PCT: '99' } }).filter((f) => f.kind === 'zero_conv').length, 0);
  // First poll (no prior state) flags no pause: it is the baseline.
  assert.strictEqual(M.flagsFor([b], null, { now: NOW, env: {} }).filter((f) => f.kind === 'paused').length, 0);

  const status = { 'https://fontanel.example/gone': 404, 'https://fontanel.example/weddings': 200 };
  const u = await M.checkUrls(M.finalUrls([a]), null, { now: NOW, check: async (x) => status[x] });
  assert.deepStrictEqual(u.flags.map((f) => f.text), ['final URL https://fontanel.example/gone answers 404']);
  // A 500 needs two checks in a row (Night Watch's two strikes), and a URL is checked once a day.
  let n = 0;
  const once = await M.checkUrls(['https://x.example/'], null, { now: NOW, check: async () => { n++; return 500; } });
  assert.strictEqual(once.flags.length, 0);
  const again = await M.checkUrls(['https://x.example/'], { urls: once.urls }, { now: new Date(NOW.getTime() + 3600000), check: async () => { n++; return 500; } });
  assert.strictEqual(n, 1, 'not rechecked within a day');
  assert.strictEqual(again.flags.length, 0);
  const later = await M.checkUrls(['https://x.example/'], { urls: once.urls }, { now: new Date(NOW.getTime() + 25 * 3600000), check: async () => 500 });
  assert.match(later.flags[0].text, /answers 500 on two checks in a row/);
  await assert.rejects(M.urlStatus('https://x.example/', { method: 'HEAD' }), /GET only/);
});

test('a poll cards new flags once, as ONE draft Auditor card with no money in it; the snapshot keeps no amount', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads3794-'));
  const env = { ADS_API_LIVE: 'on', ADS_MONITOR_STATE_DIR: dir };
  const raw = (id, name) => ({
    campaignDaily: [{ campaign: { id: '11', name: 'Weddings' }, segments: { date: LASTWK }, metrics: { impressions: '900', clicks: '40', costMicros: MICROS.a, conversions: 0 } },
      { campaign: { id: '11', name: 'Weddings' }, segments: { date: TODAY }, metrics: { impressions: '50', clicks: '3', costMicros: MICROS.c, conversions: 1 } }],
    campaignStatus: [{ campaign: { id: '11', name: 'Weddings', status: 'ENABLED', primaryStatus: 'ELIGIBLE' } }],
    adGroupWeekly: [],
    keywordWeekly: [],
    termWeekly: [{ campaign: { name: 'Weddings' }, adGroup: { name: 'Barn' }, searchTermView: { searchTerm: `free venues ${name}` }, segments: { week: LASTWK }, metrics: { impressions: '400', clicks: '30', costMicros: MICROS.b, conversions: 0 } }],
    adsStatus: [{ campaign: { name: 'Weddings' }, adGroup: { name: 'Barn' }, adGroupAd: { ad: { id: '9', finalUrls: ['https://ok.example/'] }, status: 'ENABLED', policySummary: { approvalStatus: 'DISAPPROVED' } } }],
  });
  const Q = R.queries(R.windowFor(NOW));
  const client = {
    accessible: async () => [ACC],
    search: async (id, q) => {
      if (/FROM customer/.test(q)) return [{ customer: { id, descriptiveName: 'Fontanel' } }];
      const k = Object.keys(Q).find((x) => Q[x] === q);
      assert.ok(k, `an unknown query was sent: ${q}`);
      return raw(id, 'Fontanel')[k];
    },
  };
  const inserted = [];
  const store = { insert: async (c) => { inserted.push(c); return { id: inserted.length }; } };
  const log = [];
  assert.strictEqual(await job.main({ argv: [], log: (l) => log.push(l), env, client, store, now: NOW, checkUrl: async () => 200 }), 0);
  assert.strictEqual(inserted.length, 1);
  const card = inserted[0];
  assert.strictEqual(card.agent, 'paid-ads');
  assert.match(card.body, /Disapproved ads/);
  assert.match(card.body, /Spent with no conversions/);
  assert.match(card.body, /The Brain changed nothing; K&M make any change/);
  const snap = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');
  for (const t of [card.title, card.body, log.join('\n'), snap]) {
    for (const amt of AMOUNTS) assert.ok(!t.includes(amt), `an amount leaked: ${amt}`);
    assert.ok(!/[$]|\bspend"\s*:/.test(t), 'no currency sign and no raw spend field');
  }
  assert.match(snap, /spend_share_pct/);
  // The next poll finds the same flags and cards nothing.
  assert.strictEqual(await job.main({ argv: [], log: () => {}, env, client, store, now: new Date(NOW.getTime() + 3600000), checkUrl: async () => 200 }), 0);
  assert.strictEqual(inserted.length, 1);
  assert.throws(() => M.noMoney('took 412.37 dollars'), /money/);
  assert.throws(() => M.noMoney('cost $5'), /money/);
});

test('the Paid Ads Auditor waits on the API, not the Sheet; its weekly source reads the snapshot and shows no amount', async () => {
  const pa = loadAgent('paid-ads', undefined, {});
  assert.ok(!pa.sources.some((s) => s.type === 'ads_sheet' || /export Sheet/.test(s.label || '')), 'the Sheet dependency is gone');
  assert.strictEqual(pausedFor(pa), 'paused until the Google Ads API read exists; waiting since 11.24');
  const need = pa.character.needs.find((n) => /Google Ads API/.test(n));
  assert.ok(need && !pa.character.needs.some((n) => /export Sheet/.test(n)));
  const chk = C.checkFor(need);
  assert.strictEqual(chk.kind, 'google_ads_api');
  assert.deepStrictEqual(await C.runCheck(chk, { adsAccounts: async () => [ACC, ACC2] }), { ok: true, reason: 'the Brain sees 2 Google Ads accounts' });
  assert.strictEqual((await C.runCheck(chk, { adsAccounts: async () => [] })).ok, false);

  const on = loadAgent('paid-ads', undefined, { ADS_API_LIVE: 'on' });
  assert.strictEqual(pausedFor(on), null);
  const src = on.sources.find((s) => s.type === 'google_ads_api');
  const acct = account(ACC, 'Fontanel');
  const snap = R.snapshot([acct], { now: NOW });
  const got = await S.googleAdsApiSource(src, { env: { ADS_API_LIVE: 'on' }, now: () => NOW, adsSnapshot: async () => snap });
  assert.ok(got.ok);
  assert.match(got.text, /never write a spend amount/);
  assert.match(got.text, /Fontanel \(1234567890\)/);
  for (const amt of AMOUNTS) assert.ok(!got.text.includes(amt));
  const stale = await S.googleAdsApiSource(src, { env: { ADS_API_LIVE: 'on' }, now: () => new Date(NOW.getTime() + 31 * 3600000), adsSnapshot: async () => snap });
  assert.match(stale.why, /stale/);
  const off = await S.googleAdsApiSource(src, { env: {}, adsSnapshot: async () => snap });
  assert.strictEqual(off.ok, false);
});
