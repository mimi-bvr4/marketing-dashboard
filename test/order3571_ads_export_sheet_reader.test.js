// ORDER #3571 (#3567 follow-up 2): the ads export Sheet reader, proven on a
// fixture shaped exactly like 07_Marketing_and_Brand/Ads_Export_Spec_for_KM.md
// (two tabs, two accounts, three weeks). No live Sheet exists yet.
//
// The law of the order is the COLUMN FENCE: per agent, an allow-list of columns
// applied at READ time. The Monthly Report never receives Cost / Amount Spent;
// the Auditor may read spend for trend and percentage math, and its text shows
// no currency figure.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/ads-export-sheet');
const S = require('../lib/agent-sources');
const { loadAgent, resolveSources, finishBody } = require('../lib/agent-runner');
const { pausedFor } = require('../lib/producer');
const { characterOf, sourceView, liveMissing } = require('../routes/agents');

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const G_HEAD = ['Week Start', 'Account', 'Campaign', 'Ad Group', 'Keyword', 'Match Type', 'Search Term', 'Final URL', 'Impressions', 'Clicks', 'Cost', 'Conversions'];
const M_HEAD = ['Week Start', 'Account', 'Campaign', 'Ad Set', 'Ad', 'Destination URL', 'Impressions', 'Reach', 'Link Clicks', 'Amount Spent', 'Leads'];
// Spend values chosen to be unmistakable if one ever leaks into text.
const COSTS = ['412.37', '388.19', '507.73', '91.53', '77.29', '64.81', '233.17', '219.43', '198.67', '45.91', '52.39', '61.07', '17.33'];
const WEEKS = ['2026-11-02', '2026-11-09', '2026-11-16'];

function fixture() {
  const g = [G_HEAD];
  const m = [M_HEAD];
  WEEKS.forEach((w, i) => {
    g.push([w, 'Fontanel', 'Weddings', 'Barn', 'nashville wedding venue', 'Phrase', 'nashville barn wedding', 'https://fontanel.example/weddings', '1200', '80', COSTS[i], '4']);
    g.push([w, 'Fontanel', 'Weddings', 'Barn', 'wedding venue', 'Broad', 'free wedding venues', 'https://fontanel.example/', '300', '20', COSTS[3 + i], '0']);
    g.push([w, 'The Bell Tower', 'Events', 'Corporate', 'event space nashville', 'Exact', 'event space nashville', 'https://belltower.example/events', '900', '45', COSTS[6 + i], '3']);
    m.push([w, 'Fontanel', 'Spring Weddings', 'Engaged 25-34', 'Barn Reel', 'https://fontanel.example/tour', '5000', '4100', '60', COSTS[9 + i], '2']);
    m.push([w, 'The Bell Tower', 'Holiday Parties', 'Nashville HR', 'Carousel', 'https://belltower.example/holiday', '3000', '2600', '25', i === 2 ? COSTS[12] : '30', i === 2 ? '0' : '1']);
  });
  g.push(['', '', '', '', '', '', '', '', '7200', '435', '2018.44', '21']); // totals row, no Week Start
  g.push(['Total', '', '', '', '', '', '', '', '', '', '', '']);
  g.push([]);
  g.push(['', '', '', '']);
  return { 'Google Ads': g, Meta: m };
}

const CURRENCY = /\$|\b(usd|dollars?)\b/i;

// ------------------------------------------------------------ the header check

test('a fixture shaped like the spec reads: 9 Google rows, 6 Meta rows, totals and blanks skipped', () => {
  const r = A.readFenced('paid-ads', fixture());
  assert.ok(r.ok, r.why);
  assert.strictEqual(r.tabs['Google Ads'].length, 9);
  assert.strictEqual(r.tabs.Meta.length, 6);
  assert.strictEqual(r.counts['Google Ads'].totals_skipped, 2);
  assert.strictEqual(r.counts['Google Ads'].blank_skipped, 2);
  assert.strictEqual(r.counts['Google Ads'].refused, 0);
  assert.deepStrictEqual(A.TABS['Google Ads'], G_HEAD);
  assert.deepStrictEqual(A.TABS.Meta, M_HEAD);
});

test('a renamed or missing column refuses the whole read, naming the column', () => {
  const renamed = fixture();
  renamed['Google Ads'][0] = G_HEAD.map((c) => (c === 'Search Term' ? 'Search term' : c));
  let r = A.readFenced('paid-ads', renamed);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /Google Ads tab has no column named "Search Term"/);
  assert.strictEqual(r.tabs, undefined, 'no partial read');

  const missing = fixture();
  missing.Meta = missing.Meta.map((row) => row.filter((_, i) => i !== M_HEAD.indexOf('Leads')));
  r = A.readFenced('monthly-report', missing);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /Meta tab has no column named "Leads"/);

  const noTab = fixture(); delete noTab.Meta;
  r = A.readFenced('paid-ads', noTab);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /no tab named "Meta"/);
});

test('a Week Start that is not a Monday is refused per row and counted; the rest still read', () => {
  const f = fixture();
  f['Google Ads'][1][0] = '2026-11-03';  // a Tuesday
  f['Google Ads'][2][0] = '11/02/2026';  // wrong format
  f.Meta[1][0] = '2026-02-30';           // not a real date
  const r = A.readFenced('paid-ads', f);
  assert.ok(r.ok);
  assert.strictEqual(r.counts['Google Ads'].refused, 2);
  assert.strictEqual(r.tabs['Google Ads'].length, 7);
  assert.deepStrictEqual(r.counts['Google Ads'].refused_rows.map((x) => x.row), [2, 3]);
  assert.match(r.counts['Google Ads'].refused_rows[0].why, /not a Monday/);
  assert.strictEqual(r.counts.Meta.refused, 1);
  assert.ok(r.tabs['Google Ads'].every((row) => A.weekStartOk(row['Week Start']) === null));
});

// ------------------------------------------------------------ the column fence

test('FENCE: the Monthly Report never receives Cost or Amount Spent, in any row', () => {
  const r = A.readFenced('monthly-report', fixture());
  assert.ok(r.ok);
  for (const row of r.tabs['Google Ads']) assert.ok(!('Cost' in row), JSON.stringify(row));
  for (const row of r.tabs.Meta) assert.ok(!('Amount Spent' in row), JSON.stringify(row));
  assert.ok(!A.FENCE['monthly-report']['Google Ads'].includes('Cost'));
  assert.ok(!A.FENCE['monthly-report'].Meta.includes('Amount Spent'));
  // Nothing of a spend cell reaches its text either.
  const { text, table } = A.sourceText('monthly-report', r);
  for (const c of COSTS) assert.ok(!text.includes(c) && !table.includes(c), `spend ${c} leaked`);
  assert.doesNotMatch(text, CURRENCY);
});

test('FENCE: an agent with no fence reads nothing from the Sheet', () => {
  const r = A.readFenced('seo', fixture());
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /no column fence/);
});

test('FENCE: the Auditor reads spend for math, and its note and card show no currency figure', async () => {
  const r = A.readFenced('paid-ads', fixture());
  assert.strictEqual(r.tabs['Google Ads'][0].Cost, 412.37, 'the Auditor does receive the spend column');
  const got = await S.adsSheetSource({ type: 'ads_sheet', env: 'ADS_EXPORT_SHEET_ID' },
    { env: { ADS_EXPORT_SHEET_ID: ID }, agent: 'paid-ads', adsSheetValues: async () => fixture() });
  assert.ok(got.ok, got.why);
  for (const c of COSTS) assert.ok(!got.text.includes(c) && !got.table.includes(c), `spend ${c} leaked`);
  assert.doesNotMatch(got.text, CURRENCY);
  assert.doesNotMatch(got.table, CURRENCY);
  // Trend and percentage only: the wasted term is named with its share of spend.
  assert.match(got.text, /"free wedding venues".*% of the account's spend that week, 20 clicks, 0 conversions/);
  assert.match(got.table, /Spend change vs prior week/);
  assert.match(got.table, /[+-]\d+(\.\d)?%/);
  // The rendered card: the measured table is appended under the model's words.
  const body = finishBody({ title: 't', target: 'x', body: 'Draft.' }, { def: loadAgent('paid-ads'), got: [{ label: 'Google + Meta ads export Sheet', table: got.table }], unavailable: [], now: new Date('2026-11-18T18:00:00Z') });
  for (const c of COSTS) assert.ok(!body.includes(c), `spend ${c} on the card`);
  assert.doesNotMatch(body, CURRENCY);
  assert.strictEqual(got.measured.ads_sheet['Google Ads'].rows, 9);
});

// ------------------------------------------------------------ env unset: still waiting

const TODAY = {
  'paid-ads': { type: 'pending', required: true, label: 'Google + Meta ads export Sheet', since: '2026-10-13',
    why: 'the export Sheet has never existed: K&M build it per https://docs.google.com/document/d/1N0KqATZq3EBNT_OO7rNZpVF0kym5qqIQbM17A98GCxM/edit (#3567), share it to the Brain, and its id goes in ADS_EXPORT_SHEET_ID; Katherine owns the ask' },
  'monthly-report': { type: 'pending', label: 'Google + Meta ads export Sheet', why: 'the export Sheet has not been created and shared yet' },
};
const adsSrc = (d) => d.sources.find((s) => s.label === 'Google + Meta ads export Sheet');

test('env unset: no read, no crash, and the source answers the same waiting line as today', async () => {
  let reads = 0;
  for (const slug of ['paid-ads', 'monthly-report']) {
    const raw = { ...TODAY[slug], type: 'ads_sheet', env: 'ADS_EXPORT_SHEET_ID' };
    const r = await S.adsSheetSource(raw, { env: {}, agent: slug, adsSheetValues: async () => { reads++; return fixture(); } });
    assert.deepStrictEqual(r, { ok: false, why: TODAY[slug].why });
    const g = await S.gather(resolveSources([raw], {}), { env: {}, agent: slug, adsSheetValues: async () => { reads++; return fixture(); } });
    assert.deepStrictEqual(g.unavailable, [{ label: 'Google + Meta ads export Sheet', type: 'pending', why: TODAY[slug].why }]);
  }
  assert.strictEqual(reads, 0, 'nothing is read while the id is unset');
});

test('env unset: both cards look exactly as today (source view, pause, Waiting on line)', () => {
  const NOW = new Date('2026-11-18T18:00:00Z');
  const run = { started_at: '2026-11-18T12:00:00Z', unavailable: [{ label: 'Google + Meta ads export Sheet', type: 'pending', why: 'old run reason' }] };
  // #3794: the Auditor no longer reads the Sheet (Google Ads API read); the Monthly Report still waits on it.
  assert.strictEqual(adsSrc(loadAgent('paid-ads', undefined, {})), undefined);
  for (const slug of ['monthly-report']) {
    const now = loadAgent(slug, undefined, {});
    const before = { ...now, sources: now.sources.map((s) => (s.label === 'Google + Meta ads export Sheet' ? TODAY[slug] : s)) };
    assert.deepStrictEqual(adsSrc(now), TODAY[slug], `${slug} resolves to today's pending source`);
    assert.deepStrictEqual(now.sources.map(sourceView), before.sources.map(sourceView));
    assert.strictEqual(pausedFor(now), pausedFor(before));
    assert.deepStrictEqual(liveMissing(now, run, NOW), liveMissing(before, run, NOW));
    assert.deepStrictEqual(characterOf(now, [], run, NOW, null, {}), characterOf(before, [], run, NOW, null, {}));
  }
});

test('env set: the sheet source takes over for the Monthly Report; the Auditor stays paused on the API read', async () => {
  const env = { ADS_EXPORT_SHEET_ID: ID };
  const pa = loadAgent('paid-ads', undefined, env);
  assert.strictEqual(adsSrc(pa), undefined, '#3794');
  assert.strictEqual(pausedFor(pa), 'paused until the Google Ads API read exists; waiting since 11.24');
  const mr = loadAgent('monthly-report', undefined, env);
  const g = await S.gather([adsSrc(mr)], { env, agent: 'monthly-report', adsSheetValues: async () => fixture() });
  assert.strictEqual(g.got.length, 1);
  for (const c of COSTS) assert.ok(!g.got[0].text.includes(c));
  // A Google 403 names the account to share to; it never crashes the run.
  const no = await S.gather([adsSrc(mr)], { env, agent: 'monthly-report', adsSheetValues: async () => { const e = new Error('forbidden'); e.status = 403; throw e; } });
  assert.match(no.unavailable[0].why, /share it to infinity-brain@ihg-sales-brain\.iam\.gserviceaccount\.com as Viewer/);
});
