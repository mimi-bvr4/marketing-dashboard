// ORDER #3804: the Monday paid ads report (Google Ads + Meta). No live account
// is read here: Google comes from a built snapshot, Meta through a fake fetch.
// Pinned in code:
//   - converting keywords/search terms/ads and the ones that spent with none,
//     per venue, for the newest full week, with trends on the week before;
//   - drafted action lines for K&M ("Add 'x' as exact match for <venue>");
//   - no dollar figure anywhere: Meta spend becomes a share inside meta-read.js;
//   - a "Waiting on" line for whichever source is missing;
//   - PAID_ADS_WEEKLY ships OFF and, off, the job reads and writes nothing.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../lib/paid-ads-weekly');
const meta = require('../lib/meta-read');
const job = require('../jobs/paid_ads_weekly');

// Wednesday 11.25.2026 10:00 CT: newest full week is Monday 11.16 to Sunday 11.22.
const NOW = new Date('2026-11-25T16:00:00Z');
const WK = '2026-11-16';
const PRIOR = '2026-11-09';
const ON = { ADS_API_LIVE: 'on' };
const AMOUNTS = ['412.37', '91.53', '233.17', '17.04'];

function snap(over = {}) {
  return {
    generated_at: new Date(NOW.getTime() - 3600000).toISOString(),
    today: '2026-11-25',
    accounts: [{
      id: '1234567890', name: 'TBB',
      today: { impressions: 0, clicks: 0, conversions: 0 },
      weeks: [{ week: PRIOR, impressions: 900, clicks: 80, conversions: 2, spend_change_pct: null },
        { week: WK, impressions: 1000, clicks: 100, conversions: 4, spend_change_pct: 12.5 }],
      campaigns: [],
      keywords: [
        { campaign: 'Weddings', ad_group: 'Venue', keyword: 'nashville wedding venue', match_type: 'PHRASE', week: WK, impressions: 300, clicks: 30, conversions: 3, spend_share_pct: 40 },
        { campaign: 'Weddings', ad_group: 'Venue', keyword: 'nashville wedding venue', match_type: 'PHRASE', week: PRIOR, impressions: 280, clicks: 25, conversions: 1, spend_share_pct: 38 },
        { campaign: 'Weddings', ad_group: 'Broad', keyword: 'event space', match_type: 'BROAD', week: WK, impressions: 200, clicks: 12, conversions: 0, spend_share_pct: 22 },
        { campaign: 'Weddings', ad_group: 'Broad', keyword: 'event space', match_type: 'BROAD', week: PRIOR, impressions: 190, clicks: 11, conversions: 0, spend_share_pct: 20 },
        { campaign: 'Weddings', ad_group: 'Exact', keyword: 'barn wedding nashville', match_type: 'EXACT', week: WK, impressions: 50, clicks: 5, conversions: 0, spend_share_pct: 2 },
      ],
      search_terms: [
        { campaign: 'Weddings', ad_group: 'Venue', search_term: 'rehearsal dinner venue nashville', week: WK, impressions: 40, clicks: 6, conversions: 1, spend_share_pct: 4 },
        { campaign: 'Weddings', ad_group: 'Venue', search_term: 'barn wedding nashville', week: WK, impressions: 40, clicks: 6, conversions: 1, spend_share_pct: 4 },
        { campaign: 'Weddings', ad_group: 'Broad', search_term: 'free event space', week: WK, impressions: 90, clicks: 9, conversions: 0, spend_share_pct: 11 },
      ],
      ads: [],
    }],
    ...over,
  };
}

function metaOk() {
  return { ok: true, accounts: [{ id: '555', name: 'IHG Meta', ads: [
    { campaign: 'Engaged', adset: 'Nashville 25-40', ad: 'Garden ceremony reel', ad_id: '9', impressions: 5000, clicks: 70, conversions: 3, spend_share_pct: 55 },
    { campaign: 'Engaged', adset: 'Nashville 25-40', ad: 'Ballroom carousel', ad_id: '8', impressions: 4000, clicks: 20, conversions: 0, spend_share_pct: 45 },
  ], prior: [{ ad_id: '9', conversions: 1 }] }] };
}

test('the week is the newest full Monday-to-Sunday week, CT', () => {
  assert.deepStrictEqual(W.reportWeek(NOW), { week: WK, prior: PRIOR, end: '2026-11-22' });
  // Monday 00:30 CT still reports the week that just ended.
  assert.strictEqual(W.reportWeek(new Date('2026-11-23T06:30:00Z')).week, WK);
});

test('Google: converting keywords and terms, spent-with-none, trends, drafted actions', () => {
  const card = W.report({ snapshot: snap(), meta: metaOk(), now: NOW, env: ON });
  const b = card.body;
  assert.match(card.title, /week of 11\.16\.2026/);
  assert.match(b, /### TBB: Google Ads/);
  assert.match(b, /Keywords that converted:\n- "nashville wedding venue" \(phrase, Weddings \/ Venue\): 3 conversions \(75% of the venue's week\), 30 clicks, 40% of spend; up 200% on the week before/);
  assert.match(b, /Search terms that converted:[\s\S]*"rehearsal dinner venue nashville"/);
  assert.match(b, /Keywords that spent with none:\n- "event space" \(broad, Weddings \/ Broad\): 22% of spend, 12 clicks, 0 conversions \(also 0 the week before\)/);
  assert.match(b, /Search terms that spent with none:\n- "free event space"/);
  assert.match(b, /Week: 4 conversions \(up 100%\), 100 clicks; spend up 12.5% on the week before\./);
  // Actions: exact match for the converting term with no exact keyword; none for the one that has one.
  assert.match(b, /- Add "rehearsal dinner venue nashville" as exact match for TBB/);
  assert.doesNotMatch(b, /Add "barn wedding nashville" as exact match/);
  assert.match(b, /- Add "free event space" as a negative keyword for TBB/);
  assert.match(b, /- Pause or tighten keyword "event space" \(broad\) for TBB: 0 conversions two weeks running/);
  // Below the share threshold: not listed as spent-with-none.
  assert.doesNotMatch(b, /"barn wedding nashville" \(exact[^\n]*0 conversions/);
  assert.match(b, /K&M make any change/);
});

test('Meta: converting ads and spent-with-none per account, with an action line', () => {
  const b = W.report({ snapshot: snap(), meta: metaOk(), now: NOW, env: ON }).body;
  assert.match(b, /### IHG Meta: Meta\nWeek: 3 conversions across 2 ads\./);
  assert.match(b, /Ads that converted:\n- "Garden ceremony reel" \(Engaged \/ Nashville 25-40\): 3 conversions \(100% of the account's week\), 70 clicks, 55% of spend; up 200% on the week before/);
  assert.match(b, /Ads that spent with none:\n- "Ballroom carousel"/);
  assert.match(b, /- Review Meta ad "Ballroom carousel"/);
});

test('a missing source is a Waiting on line, never a gap', () => {
  const pend = { ok: false, pending: true, why: 'Meta read access pending: no META_ADS_READ_TOKEN' };
  const off = W.report({ snapshot: snap(), meta: pend, now: NOW, env: {} });
  assert.match(off.body, /Waiting on Google Ads: Google Ads API read is not on yet \(#3794/);
  assert.match(off.body, /Waiting on Meta: Meta read access pending/);
  assert.match(off.body, /## Drafted changes for K&M\nNone this week\./);
  assert.deepStrictEqual(off.sources, ['Google Ads (waiting)', 'Meta (waiting)']);
  const stale = W.report({ snapshot: snap({ generated_at: '2026-11-20T00:00:00Z' }), meta: metaOk(), now: NOW, env: ON });
  assert.match(stale.body, /Waiting on Google Ads: the Google Ads snapshot is stale/);
  assert.match(W.report({ snapshot: null, meta: metaOk(), now: NOW, env: ON }).body, /has not written a snapshot yet/);
});

test('no money: the report refuses a currency figure, and Meta spend leaves meta-read.js as a share only', () => {
  const bad = snap();
  bad.accounts[0].name = 'TBB $412.37';
  assert.throws(() => W.report({ snapshot: bad, meta: metaOk(), now: NOW, env: ON }), /money word or figure/);
  const rows = meta.weekRows([
    { campaign_name: 'C', adset_name: 'S', ad_name: 'A', ad_id: '1', impressions: '10', clicks: '2', spend: '412.37', actions: [{ action_type: 'lead', value: '2' }, { action_type: 'onsite_conversion.lead_grouped', value: '1' }] },
    { campaign_name: 'C', adset_name: 'S', ad_name: 'B', ad_id: '2', impressions: '10', clicks: '2', spend: '17.04', actions: [{ action_type: 'link_click', value: '2' }] },
  ], {});
  assert.strictEqual(rows[0].conversions, 2, '`lead` is the all-leads total, never added to its parts');
  assert.strictEqual(rows[1].conversions, 0);
  assert.strictEqual(rows[0].spend_share_pct, 96);
  const text = JSON.stringify(rows);
  for (const a of AMOUNTS) assert.ok(!text.includes(a), `amount ${a} left meta-read`);
  assert.ok(!('spend' in rows[0]));
});

test('Meta weekly read: GET only, ad level, one week, every account, token never in the URL', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (/\/act_\d+\?/.test(url)) return { ok: true, status: 200, json: async () => ({ name: 'IHG Meta' }) };
    return { ok: true, status: 200, json: async () => ({ data: [{ campaign_name: 'C', adset_name: 'S', ad_name: 'A', ad_id: '1', impressions: '10', clicks: '4', spend: '412.37', actions: [{ action_type: 'lead', value: '1' }] }] }) };
  };
  const env = { META_ADS_READ_TOKEN: 'ZZ_TEST_META', META_AD_ACCOUNT_IDS: 'act_111, 222' };
  const r = await meta.readAdsWeek({ week: WK, prior: PRIOR }, { env, fetchImpl, secrets: () => null });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.accounts.map((a) => a.id), ['111', '222']);
  assert.strictEqual(r.accounts[0].ads[0].conversions, 1);
  assert.strictEqual(calls.length, 6, 'name + this week + last week, per account');
  for (const c of calls) {
    assert.strictEqual(c.opts.method, 'GET');
    assert.ok(!c.url.includes('ZZ_TEST_META'));
    assert.match(c.url, /^https:\/\/graph\.facebook\.com\/v27\.0\/act_(111|222)/);
  }
  const ins = decodeURIComponent(calls[1].url);
  assert.match(ins, /level=ad/);
  assert.match(ins, /"since":"2026-11-16","until":"2026-11-22"/);
  assert.match(ins, /actions/);
  assert.ok(!JSON.stringify(r).includes('412.37'));
});

test('Meta weekly read is pending, with nothing sent, until the token and the account ids exist', async () => {
  let hit = 0;
  const fetchImpl = async () => { hit++; return { ok: true, status: 200, json: async () => ({}) }; };
  const a = await meta.readAdsWeek({ week: WK, prior: PRIOR }, { env: { META_AD_ACCOUNT_IDS: '111' }, fetchImpl, secrets: () => null });
  assert.ok(a.pending && /META_ADS_READ_TOKEN/.test(a.why));
  const b = await meta.readAdsWeek({ week: WK, prior: PRIOR }, { env: { META_ADS_READ_TOKEN: 'x' }, fetchImpl, secrets: () => null });
  assert.ok(b.pending && /META_AD_ACCOUNT_IDS/.test(b.why));
  assert.strictEqual(hit, 0);
  assert.deepStrictEqual(meta.accountsOf({ META_AD_ACCOUNT_ID: 'act_42' }), ['42'], 'falls back to the Sleuth\'s one account');
});

test('PAID_ADS_WEEKLY ships OFF: off, the job reads and writes nothing; on, one card per week', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-'));
  const logs = [];
  let metaReads = 0;
  const readMeta = async () => { metaReads++; return metaOk(); };
  const inserted = [];
  const store = { insert: async (c) => { inserted.push(c); return { id: 77 }; } };
  assert.strictEqual(await job.main({ argv: [], env: { ADS_MONITOR_STATE_DIR: dir }, log: (l) => logs.push(l), readMeta, store, now: NOW }), 0);
  assert.match(logs[0], /PAID_ADS_WEEKLY is off/);
  assert.strictEqual(metaReads, 0);
  assert.strictEqual(inserted.length, 0);
  assert.deepStrictEqual(fs.readdirSync(dir), []);

  const env = { ADS_MONITOR_STATE_DIR: dir, PAID_ADS_WEEKLY: 'on', ...ON };
  assert.strictEqual(await job.main({ argv: [], env, log: () => {}, readMeta, store, now: NOW, snapshot: snap() }), 0);
  assert.strictEqual(inserted.length, 1);
  assert.strictEqual(inserted[0].agent, 'paid-ads');
  assert.match(inserted[0].body, /rehearsal dinner venue nashville/);
  assert.strictEqual(await job.main({ argv: [], env, log: (l) => logs.push(l), readMeta, store, now: NOW, snapshot: snap() }), 0);
  assert.strictEqual(inserted.length, 1, 'the same week is not carded twice');
  assert.match(logs[logs.length - 1], /already carded/);
});

test('the plist ships NOT loaded-on-run and without the switch', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'launchd', 'com.infinitybrain.paid-ads-weekly.plist'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(p, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.doesNotMatch(p, /<key>PAID_ADS_WEEKLY<\/key>/);
  assert.match(p, /<key>Weekday<\/key>\s*<integer>1<\/integer>/);
});
