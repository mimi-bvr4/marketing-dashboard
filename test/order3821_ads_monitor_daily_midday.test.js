// ORDER #3821 (Mimi, 11.25.2026): the Google Ads monitor is not hourly.
//   - launchd runs it at 06:15 and 13:15 CT; no StartInterval is left;
//   - before noon CT the job is the daily full pull (13 weeks, every flag, the
//     snapshot); from noon on it is the midday check (7 days, alerts only on a
//     disapproved ad, a stopped campaign, a URL that does not load, spend well
//     ahead of normal with 0 conversions), no card unless one fires, and it never
//     rewrites the snapshot;
//   - the snapshot counts as fresh for 30 hours, since it is written once a day;
//   - the Auditor's card reads "Checks Google Ads daily at 6:15 AM, quick health
//     check at 1:15 PM."; no amount on any surface.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/google-ads-read');
const M = require('../lib/google-ads-monitor');
const W = require('../lib/paid-ads-weekly');
const job = require('../jobs/ads_monitor');

const ACC = '1234567890';
const MORNING = new Date('2026-11-25T12:15:00Z'); // 06:15 CT
const MIDDAY = new Date('2026-11-25T19:15:00Z'); // 13:15 CT
const TODAY = '2026-11-25';
const AMOUNT_MICROS = '412370000';

function plistText() {
  return fs.readFileSync(path.join(__dirname, '..', 'jobs', 'launchd', 'com.infinitybrain.ads-monitor.plist'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

test('launchd: 06:15 and 13:15, no hourly StartInterval, switch still OFF, not run at load', () => {
  const p = plistText();
  assert.ok(!/<key>StartInterval<\/key>/.test(p), 'the hourly poll is gone');
  const times = [...p.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepStrictEqual(times, ['6:15', '13:15']);
  assert.ok(!/<key>ADS_API_LIVE<\/key>/.test(p));
  assert.match(p, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(p, /<key>TZ<\/key>\s*<string>America\/Chicago<\/string>/);
});

test('the run picks its mode from the CT hour; an explicit flag wins', () => {
  assert.strictEqual(job.modeFor([], MORNING), 'daily');
  assert.strictEqual(job.modeFor([], MIDDAY), 'midday');
  assert.strictEqual(job.modeFor(['--daily'], MIDDAY), 'daily');
  assert.strictEqual(job.modeFor(['--midday'], MORNING), 'midday');
  assert.strictEqual(job.modeFor([], new Date('2026-11-25T17:59:00Z')), 'daily'); // 11:59 CT
  assert.strictEqual(job.modeFor([], new Date('2026-11-25T18:00:00Z')), 'midday'); // 12:00 CT
});

function account({ servingToday = true, spendToday = 10e6, convToday = 0, approval = 'APPROVED', limited = false } = {}) {
  const daily = [];
  for (let k = 1; k <= 7; k++) daily.push({ campaign_id: '11', campaign: 'Weddings', date: R.addDays(TODAY, -k), impressions: 100, clicks: 10, conversions: 1, spend: 50e6 });
  if (servingToday) daily.push({ campaign_id: '11', campaign: 'Weddings', date: TODAY, impressions: 40, clicks: 4, conversions: convToday, spend: spendToday });
  return {
    id: ACC, name: 'Fontanel',
    campaigns: [{ id: '11', name: 'Weddings', status: 'ENABLED', primary_status: limited ? 'LIMITED' : 'ELIGIBLE' }],
    daily, adGroups: [], keywords: [], terms: [],
    ads: [{ campaign: 'Weddings', ad_group: 'Barn', id: '777', final_urls: ['https://fontanel.example/weddings'], status: 'ENABLED', approval }],
  };
}

test('midday flags: disapproved, 0 impressions so far today, spend ahead of normal with 0 conversions; nothing else', () => {
  const quiet = M.middayFlags([account({ limited: true })], null, { now: MIDDAY, env: {} });
  assert.deepStrictEqual(quiet, [], 'a limited campaign is the daily pull\'s, not a midday alert');

  const kinds = (fl) => fl.map((f) => f.kind).sort();
  assert.deepStrictEqual(kinds(M.middayFlags([account({ approval: 'DISAPPROVED' })], null, { now: MIDDAY, env: {} })), ['disapproved']);

  const stopped = M.middayFlags([account({ servingToday: false })], null, { now: MIDDAY, env: {} });
  assert.deepStrictEqual(kinds(stopped), ['drop']);
  assert.match(stopped[0].text, /Fontanel: campaign "Weddings" has 0 impressions so far today \(2026-11-25, checked 1:15 PM CT\)/);
  assert.strictEqual(stopped[0].key, `drop:${ACC}:11:${TODAY}`, 'same key the next morning\'s yesterday-drop uses, so it is carded once');

  const hot = M.middayFlags([account({ spendToday: 60e6 })], null, { now: MIDDAY, env: {} });
  assert.deepStrictEqual(kinds(hot), ['pace']);
  assert.match(hot[0].text, /has spent 120% of a usual day's spend by 1:15 PM CT today, with 0 conversions/);
  // A conversion today, or a normal pace, quiets it; the threshold is adjustable.
  assert.deepStrictEqual(M.middayFlags([account({ spendToday: 60e6, convToday: 1 })], null, { now: MIDDAY, env: {} }), []);
  assert.deepStrictEqual(M.middayFlags([account({ spendToday: 60e6 })], null, { now: MIDDAY, env: { ADS_PACE_PCT: '150' } }), []);

  const paused = account(); paused.campaigns[0].status = 'PAUSED';
  assert.deepStrictEqual(kinds(M.middayFlags([paused], { campaigns: { [ACC]: { 11: 'ENABLED' } } }, { now: MIDDAY, env: {} })), ['paused']);
  for (const f of [...stopped, ...hot]) M.noMoney(f.text);
});

test('URLs are rechecked after 6 hours, so 1:15 PM re-tests what 6:15 AM tested', async () => {
  assert.strictEqual(M.URL_RECHECK_HOURS, 6);
  let n = 0;
  const am = await M.checkUrls(['https://x.example/'], null, { now: MORNING, check: async () => { n++; return 200; } });
  const pm = await M.checkUrls(['https://x.example/'], { urls: am.urls }, { now: MIDDAY, check: async () => { n++; return 404; } });
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(pm.flags.map((f) => f.text), ['final URL https://x.example/ answers 404']);
});

function rawFor({ disapproved }) {
  return {
    campaignDaily: [
      ...[1, 2, 3, 4, 5, 6, 7].map((k) => ({ campaign: { id: '11', name: 'Weddings' }, segments: { date: R.addDays(TODAY, -k) }, metrics: { impressions: '100', clicks: '10', costMicros: '50000000', conversions: 1 } })),
      { campaign: { id: '11', name: 'Weddings' }, segments: { date: TODAY }, metrics: { impressions: '40', clicks: '4', costMicros: '10000000', conversions: 0 } },
    ],
    campaignStatus: [{ campaign: { id: '11', name: 'Weddings', status: 'ENABLED', primaryStatus: 'LIMITED' } }],
    adGroupWeekly: [],
    keywordWeekly: [],
    termWeekly: [{ campaign: { name: 'Weddings' }, adGroup: { name: 'Barn' }, searchTermView: { searchTerm: 'free venues' }, segments: { week: '2026-11-16' }, metrics: { impressions: '400', clicks: '30', costMicros: AMOUNT_MICROS, conversions: 0 } }],
    adsStatus: [{ campaign: { name: 'Weddings' }, adGroup: { name: 'Barn' }, adGroupAd: { ad: { id: '9', finalUrls: ['https://ok.example/'] }, status: 'ENABLED', policySummary: { approvalStatus: disapproved ? 'DISAPPROVED' : 'APPROVED' } } }],
  };
}
function clientFor(now, { disapproved = false } = {}) {
  const sent = [];
  const Q = { ...R.queries(R.windowFor(now)), ...Object.fromEntries(Object.entries(R.queries(R.middayWindowFor(now))).map(([k, v]) => [`mid:${k}`, v])) };
  return {
    sent,
    accessible: async () => [ACC],
    search: async (id, q) => {
      if (/FROM customer/.test(q)) return [{ customer: { id, descriptiveName: 'Fontanel' } }];
      const k = Object.keys(Q).find((x) => Q[x] === q);
      assert.ok(k, `an unknown query was sent: ${q}`);
      sent.push(k);
      return rawFor({ disapproved })[k.replace(/^mid:/, '')];
    },
  };
}

test('the midday run: 7-day reads only, no card when nothing fires, never rewrites the snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads3821-'));
  const env = { ADS_API_LIVE: 'on', ADS_MONITOR_STATE_DIR: dir };
  const inserted = [];
  const store = { insert: async (c) => { inserted.push(c); return { id: inserted.length }; } };

  // 06:15: the daily pull, 13 weeks, every flag (the limited campaign and the
  // zero-conversion term card), and the snapshot.
  const am = clientFor(MORNING);
  assert.strictEqual(await job.main({ argv: [], log: () => {}, env, client: am, store, now: MORNING, checkUrl: async () => 200 }), 0);
  assert.ok(am.sent.every((k) => !k.startsWith('mid:')), 'the daily pull reads the 13-week window');
  assert.strictEqual(am.sent.length, 6);
  assert.strictEqual(inserted.length, 1);
  assert.strictEqual(inserted[0].job, 'daily Google Ads pull');
  const snapBefore = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');

  // 13:15, nothing wrong: no card, the snapshot is untouched.
  const pm = clientFor(MIDDAY);
  const log = [];
  assert.strictEqual(await job.main({ argv: [], log: (l) => log.push(l), env, client: pm, store, now: MIDDAY, checkUrl: async () => 200 }), 0);
  // (the two status reads carry no date, so they match either window's text)
  assert.deepStrictEqual(pm.sent.map((k) => k.replace(/^mid:/, '')).sort(), [...job.MIDDAY_READS].sort());
  assert.ok(pm.sent.includes('mid:campaignDaily') && pm.sent.includes('mid:keywordWeekly'), 'dated reads use the 7-day window');
  assert.strictEqual(inserted.length, 1, 'no card unless an alert fires');
  assert.match(log.join('\n'), /^midday check: read 1 account\(s\), 2026-11-18 to 2026-11-25/m);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'), snapBefore);

  // 13:15 the next day... same day with a disapproved ad and a dead landing page: one card.
  const bad = clientFor(MIDDAY, { disapproved: true });
  const later = new Date(MIDDAY.getTime() + 7 * 3600000); // 20:15 CT, past the URL recheck window
  assert.strictEqual(await job.main({ argv: ['--midday'], log: () => {}, env, client: bad, store, now: later, checkUrl: async () => 404 }), 0);
  assert.strictEqual(inserted.length, 2);
  const card = inserted[1];
  assert.strictEqual(card.job, 'midday Google Ads health check');
  assert.match(card.title, /^Google Ads midday check: 2 new flags/);
  assert.match(card.body, /Disapproved ads/);
  assert.match(card.body, /Final URLs that do not load/);
  assert.ok(!/Limited campaigns|Spent with no conversions/.test(card.body), 'daily-only flags stay off the midday card');
  for (const t of [card.title, card.body, snapBefore]) {
    assert.ok(!t.includes(AMOUNT_MICROS) && !t.includes('412.37') && !/[$]/.test(t), 'no amount on any surface');
  }
});

test('the snapshot is fresh for 30 hours, since it is written once a day', () => {
  assert.strictEqual(W.SNAPSHOT_FRESH_HOURS, 30);
  const on = { PAID_ADS_WEEKLY: 'on', ADS_API_LIVE: 'on' };
  const snap = (h) => ({ generated_at: new Date(MORNING.getTime() - h * 3600000).toISOString(), accounts: [] });
  assert.strictEqual(W.googleWaiting(snap(29), { env: on, now: MORNING }), null);
  assert.match(W.googleWaiting(snap(31), { env: on, now: MORNING }), /stale .*daily 6:15 AM pull is not running/);
});

test('the Auditor card says the new cadence, and no surface says hourly', () => {
  const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'paid-ads', 'agent.json'), 'utf8'));
  assert.strictEqual(def.cadence, 'Checks Google Ads daily at 6:15 AM, quick health check at 1:15 PM.');
  assert.ok(!/hour/i.test(JSON.stringify(def)), 'no "hourly" left on the Auditor');
  assert.ok(def.character.does.some((d) => /^Quick health check at 1:15 PM/.test(d)));
});
