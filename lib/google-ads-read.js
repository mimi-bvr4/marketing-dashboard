// ORDER #3794 (Mimi, 11.24.2026: "That sheet doesn't exist, we need to get
// Brain in there and monitoring the Google Ads stuff real time."): the Brain's
// ONE door to Google Ads. It replaces the #3567 export Sheet for the Paid Ads
// Auditor. K&M keep running the campaigns; this file only READS.
//
// THE FENCES (code, not prompt):
//   1. Two reads exist and nothing else: GET customers:listAccessibleCustomers
//      and POST customers/<10 digits>/googleAds:search (a GAQL read is a POST
//      body; Google publishes it that way). guard() refuses every other path
//      and method BEFORE a token is asked for or the network is touched, and it
//      refuses anything with "mutate" in it by name (test/order3794_google_ads_api_read.test.js).
//   2. A query must be a single GAQL SELECT. GAQL has no write verb, so this
//      is a second lock on the same door.
//   3. Spend (metrics.cost_micros) is read into memory for percentage and
//      trend math only. snapshot() keeps shares and week-over-week changes and
//      drops the amount, so no dollar figure is ever written to disk, a card or
//      a log (spend fence, the same law as lib/ads-export-sheet.js).
//   4. The token comes from the Brain's service account (lib/google-sa.js,
//      key in ~/.config/brain, never in the tree). No developer token: Google
//      sunset them on 09.09.2026 ("You no longer need a developer token or a
//      Google Ads manager account to get started", developers.google.com/
//      google-ads/api/docs/get-started/dev-token, read 11.25.2026).
//
// FEATURE FLAG: ADS_API_LIVE default OFF. Off: the hourly job reads nothing and
// the Auditor's source stays pending. `jobs/ads_monitor.js --accounts` (id and
// name only) works with the flag off: it is the setup proof Mimi asked for.
'use strict';

const HOST = 'https://googleads.googleapis.com';
// Verified 11.25.2026 on developers.google.com/google-ads/api/rest/common/search
// ("https://googleads.googleapis.com/v26/customers/CUSTOMER_ID/googleAds").
const API_VERSION = 'v26';
const VERSION_ENV = 'GOOGLE_ADS_API_VERSION';
// UNVERIFIED this run (the docs page that names the scope was not read): the
// Google Ads API's one OAuth scope. Google publishes no read-only Ads scope,
// so read-only is enforced by fences 1 and 2 above and by brain's account
// access level (Read only) in Google Ads.
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const FLAG = 'ADS_API_LIVE';
const LOGIN_ENV = 'GOOGLE_ADS_LOGIN_CUSTOMER_ID';
const ON = /^(1|on|true|yes)$/i;

const LIST_PATH = 'customers:listAccessibleCustomers';
const SEARCH_RE = /^customers\/(\d{10})\/googleAds:search$/;
const MAX_PAGES = 50;

function flagOn(env = process.env) { return ON.test(String((env || {})[FLAG] || '').trim()); }

function customerId(v) {
  const d = String(v == null ? '' : v).replace(/-/g, '').trim();
  return /^\d{10}$/.test(d) ? d : null;
}

function version(env = process.env) {
  const v = String((env || {})[VERSION_ENV] || '').trim();
  return /^v\d{2,3}$/.test(v) ? v : API_VERSION;
}

// Fence 1. Throws on anything that is not one of the two reads.
function guard(path, method) {
  const p = String(path || '');
  const m = String(method || '').toUpperCase();
  if (/mutate/i.test(p)) throw new Error(`refused: ${p} is a mutate endpoint; the Brain never changes Google Ads (ORDER #3794)`);
  if (p === LIST_PATH && m === 'GET') return;
  if (SEARCH_RE.test(p) && m === 'POST') return;
  throw new Error(`refused: ${m} ${p} is not one of the two Google Ads reads (listAccessibleCustomers, googleAds:search)`);
}

// Fence 2.
function gaql(q) {
  const s = String(q || '').trim();
  if (!/^SELECT\s/i.test(s)) throw new Error('refused: a Google Ads read is one GAQL SELECT');
  if (s.includes(';')) throw new Error('refused: one GAQL statement per read');
  return s;
}

function saToken(env = process.env) {
  const sa = require('./google-sa');
  return async () => {
    const key = sa.loadKey(env);
    if (!key) throw new Error(`no Brain service-account key on this machine (${sa.keyPath(env)})`);
    return sa.accessToken({ key, scopes: [SCOPE] });
  };
}

// ORDER #3795: the Google Ads error codes inside a failed answer. Google puts
// them in error.details[].errors[].errorCode as { <category>: <CODE> }; the
// category a code sits under is not relied on (UNVERIFIED for v26), only the
// CODE strings, so a moved category cannot hide one.
function errorCodes(j) {
  const out = [];
  const details = (j && j.error && Array.isArray(j.error.details)) ? j.error.details : [];
  for (const d of details) {
    for (const x of (d && Array.isArray(d.errors) ? d.errors : [])) {
      for (const v of Object.values((x && x.errorCode) || {})) if (typeof v === 'string' && /^[A-Z][A-Z0-9_]+$/.test(v)) out.push(v);
    }
  }
  return [...new Set(out)];
}

// ORDER #3795: a Test-level Cloud project reads test accounts only; against our
// real accounts Google answers CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION (v25+).
// That is a Waiting state with one fix, never a crash or a bare 403.
const NOT_APPROVED = 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION';
const WAITING = {
  [NOT_APPROVED]: 'Waiting on Google: Cloud project ihg-sales-brain is at Test access, which cannot read our real Google Ads accounts. Apply for Explorer access on the Google Ads API Overview page in Cloud Console (project ihg-sales-brain).',
};
function waitingLine(e) {
  for (const c of ((e && e.codes) || [])) if (WAITING[c]) return WAITING[c];
  return null;
}

// The client. `token` is an async () => access token (default: the service account).
function createClient({ env = process.env, fetchImpl = globalThis.fetch, token = saToken(env) } = {}) {
  async function call(path, method, body) {
    guard(path, method);
    const t = await token();
    const headers = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' };
    const login = customerId((env || {})[LOGIN_ENV]);
    if (login) headers['login-customer-id'] = login;
    const r = await fetchImpl(`${HOST}/${version(env)}/${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const codes = errorCodes(j);
      const msg = j && j.error && (j.error.status || j.error.message) ? `: ${String(j.error.status || j.error.message).slice(0, 160)}` : '';
      const e = new Error(`Google Ads answered ${r.status}${msg}${codes.length ? ` (${codes.join(', ')})` : ''}`);
      e.status = r.status;
      e.codes = codes;
      throw e;
    }
    return j;
  }
  return {
    async accessible() {
      const j = await call(LIST_PATH, 'GET');
      return (j.resourceNames || []).map((n) => customerId(String(n).split('/')[1])).filter(Boolean);
    },
    async search(cid, query) {
      const id = customerId(cid);
      if (!id) throw new Error(`refused: "${cid}" is not a 10-digit customer id`);
      const q = gaql(query);
      const rows = [];
      let pageToken;
      for (let i = 0; i < MAX_PAGES; i++) {
        const j = await call(`customers/${id}/googleAds:search`, 'POST', pageToken ? { query: q, pageToken } : { query: q });
        rows.push(...(j.results || []));
        pageToken = j.nextPageToken;
        if (!pageToken) return rows;
      }
      throw new Error(`a read ran past ${MAX_PAGES} pages; nothing from it was used`);
    },
  };
}

// Every account the Brain can see: customer id and name only.
async function listAccounts(client) {
  const out = [];
  for (const id of await client.accessible()) {
    let name = '';
    try {
      const rows = await client.search(id, 'SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1');
      name = (((rows[0] || {}).customer) || {}).descriptiveName || '';
    } catch (e) {
      if (waitingLine(e)) throw e; // #3795: a project-level Waiting state is never hidden in a name
      name = `(name not readable: ${String(e.message).slice(0, 80)})`;
    }
    out.push({ id, name });
  }
  return out;
}

// ---------------------------------------------------------------- the reads
// Field names are the API's GAQL names (UNVERIFIED against the v26 field
// reference this run: the docs fetch covered the endpoints, not every field).
const METRICS = 'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions';
function queries({ from, to }) {
  const during = `segments.date BETWEEN '${from}' AND '${to}'`;
  return {
    campaignDaily: `SELECT campaign.id, campaign.name, segments.date, ${METRICS} FROM campaign WHERE ${during}`,
    campaignStatus: "SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status FROM campaign WHERE campaign.status != 'REMOVED'",
    adGroupWeekly: `SELECT campaign.name, ad_group.id, ad_group.name, segments.week, ${METRICS} FROM ad_group WHERE ${during}`,
    keywordWeekly: `SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.final_urls, segments.week, ${METRICS} FROM keyword_view WHERE ${during}`,
    termWeekly: `SELECT campaign.name, ad_group.name, search_term_view.search_term, segments.week, ${METRICS} FROM search_term_view WHERE ${during}`,
    adsStatus: "SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED' AND campaign.status = 'ENABLED'",
  };
}

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
function metricsOf(r) {
  const m = r.metrics || {};
  // spend is in memory only (fence 3); micros / 1e6 is never formatted anywhere.
  return { impressions: n(m.impressions), clicks: n(m.clicks), conversions: n(m.conversions), spend: n(m.costMicros) };
}

// One account's raw rows -> the normalized shape the monitor reads.
function normalize(account, raw) {
  const c = (r) => r.campaign || {};
  const g = (r) => r.adGroup || {};
  return {
    id: account.id,
    name: account.name || account.id,
    campaigns: (raw.campaignStatus || []).map((r) => ({ id: String(c(r).id || ''), name: c(r).name || '', status: c(r).status || '', primary_status: c(r).primaryStatus || '' })),
    daily: (raw.campaignDaily || []).map((r) => ({ campaign_id: String(c(r).id || ''), campaign: c(r).name || '', date: (r.segments || {}).date, ...metricsOf(r) })),
    adGroups: (raw.adGroupWeekly || []).map((r) => ({ campaign: c(r).name || '', ad_group: g(r).name || '', week: (r.segments || {}).week, ...metricsOf(r) })),
    keywords: (raw.keywordWeekly || []).map((r) => {
      const k = ((r.adGroupCriterion || {}).keyword) || {};
      return { campaign: c(r).name || '', ad_group: g(r).name || '', text: k.text || '', match_type: k.matchType || '', final_urls: (r.adGroupCriterion || {}).finalUrls || [], week: (r.segments || {}).week, ...metricsOf(r) };
    }),
    terms: (raw.termWeekly || []).map((r) => ({ campaign: c(r).name || '', ad_group: g(r).name || '', text: ((r.searchTermView || {}).searchTerm) || '', week: (r.segments || {}).week, ...metricsOf(r) })),
    ads: (raw.adsStatus || []).map((r) => {
      const a = r.adGroupAd || {};
      return { campaign: c(r).name || '', ad_group: g(r).name || '', id: String((a.ad || {}).id || ''), final_urls: (a.ad || {}).finalUrls || [], status: a.status || '', approval: ((a.policySummary || {}).approvalStatus) || '' };
    }),
  };
}

// The whole read for one account: six GAQL SELECTs.
async function readAccount(client, account, window) {
  const q = queries(window);
  const raw = {};
  for (const k of Object.keys(q)) raw[k] = await client.search(account.id, q[k]);
  return normalize(account, raw);
}

// ---------------------------------------------------------------- dates (CT)
function ctYmd(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(ymd, k) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}
function mondayOf(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return addDays(ymd, -((d.getUTCDay() + 6) % 7));
}
// Today plus the last 13 full weeks: from the Monday 13 weeks before this week's Monday.
function windowFor(now = new Date()) {
  const to = ctYmd(now);
  return { from: addDays(mondayOf(to), -13 * 7), to };
}

// ---------------------------------------------------------------- the snapshot (no amounts)
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
function change(cur, prev) { return prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null; }

// What is kept on disk and read by the weekly Auditor: counts, and spend only as
// a share of the account's week or a change on the week before (fence 3).
function snapshot(accounts, { now = new Date() } = {}) {
  const out = { generated_at: now.toISOString(), today: ctYmd(now), accounts: [] };
  for (const a of accounts) {
    const weeks = new Map();
    const add = (wk, r) => {
      const w = weeks.get(wk) || { week: wk, impressions: 0, clicks: 0, conversions: 0, spend: 0 };
      w.impressions += r.impressions; w.clicks += r.clicks; w.conversions += r.conversions; w.spend += r.spend;
      weeks.set(wk, w);
    };
    for (const r of a.daily) add(mondayOf(r.date), r);
    const wk = [...weeks.values()].sort((x, y) => x.week.localeCompare(y.week));
    const spendOf = new Map(wk.map((w) => [w.week, w.spend]));
    const today = a.daily.filter((r) => r.date === out.today)
      .reduce((s, r) => ({ impressions: s.impressions + r.impressions, clicks: s.clicks + r.clicks, conversions: s.conversions + r.conversions }), { impressions: 0, clicks: 0, conversions: 0 });
    const rowsOf = (list, label) => list.map((r) => ({ ...label(r), week: r.week, impressions: r.impressions, clicks: r.clicks, conversions: Math.round(r.conversions * 10) / 10,
      spend_share_pct: pct(r.spend, spendOf.get(r.week) || 0), ...(r.final_urls ? { final_urls: r.final_urls.slice(0, 3) } : {}) }));
    out.accounts.push({
      id: a.id,
      name: a.name,
      today,
      weeks: wk.map((w, i) => ({ week: w.week, impressions: w.impressions, clicks: w.clicks, conversions: Math.round(w.conversions * 10) / 10,
        spend_change_pct: i ? change(w.spend, wk[i - 1].spend) : null })),
      campaigns: a.campaigns,
      ad_groups: rowsOf(a.adGroups, (r) => ({ campaign: r.campaign, ad_group: r.ad_group })),
      keywords: rowsOf(a.keywords, (r) => ({ campaign: r.campaign, ad_group: r.ad_group, keyword: r.text, match_type: r.match_type })),
      search_terms: rowsOf(a.terms, (r) => ({ campaign: r.campaign, ad_group: r.ad_group, search_term: r.text })),
      ads: a.ads.map((x) => ({ campaign: x.campaign, ad_group: x.ad_group, id: x.id, approval: x.approval, final_urls: x.final_urls.slice(0, 3) })),
    });
  }
  return out;
}

module.exports = { HOST, API_VERSION, VERSION_ENV, SCOPE, FLAG, LOGIN_ENV, LIST_PATH, SEARCH_RE, NOT_APPROVED, flagOn, customerId, version, guard, gaql, errorCodes, waitingLine,
  createClient, listAccounts, queries, normalize, readAccount, windowFor, ctYmd, addDays, mondayOf, snapshot };
