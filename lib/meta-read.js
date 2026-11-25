// ORDER #3012 (Mimi, 11.05.2026 23:36 CT, ruling 4: "Meta = YES, read-only"):
// the Engagement Sleuth's ONE door to Meta. An Analyst system user with
// `ads_read` only; Mimi creates it, and its token goes to the Box's secret
// store. It never appears in chat, in the tree or in a log.
//
// THE FENCES (code, not prompt):
//   1. GET only. There is no other method in this file: the request builder
//      hard-codes 'GET' and refuses any path that is not an ad account read.
//   2. The token is asked for by NAME: env META_ADS_READ_TOKEN, else the Box
//      Keychain item `meta-ads-read-token`. With neither, NOTHING reaches the
//      network: the read answers `pending` and the audience stays UNVERIFIED.
//   3. The ad account comes from META_AD_ACCOUNT_ID (digits). None set: pending.
//   4. The token goes in the Authorization header, never in the URL, and no
//      answer or error carries it.
// The Graph API version is META_GRAPH_VERSION, else GRAPH_VERSION below.
// ORDER #3804 moved it to v27.0, read 11.25.2026 on developers.facebook.com/
// docs/graph-api/changelog ("The latest Graph API version is: v27.0"; the
// Marketing API table lists v27.0, introduced November 4, 2026).
//
// ORDER #3804 adds the Paid Ads Auditor's weekly read (readAdsWeek) on the SAME
// token: ad-level insights for one Monday-to-Sunday week, on every account in
// META_AD_ACCOUNT_IDS (comma list), else the one META_AD_ACCOUNT_ID. Spend is
// turned into a share of the account's week INSIDE this file and dropped, so no
// amount leaves it (the #3794 spend fence).
'use strict';

const HOST = 'https://graph.facebook.com';
const GRAPH_VERSION = 'v27.0';
const TOKEN_ENV = 'META_ADS_READ_TOKEN';
const KEYCHAIN = 'meta-ads-read-token';
const ACCOUNT_ENV = 'META_AD_ACCOUNT_ID';
const SCOPE = 'ads_read';
const READ_FIELDS = 'campaign_name,adset_name,impressions,reach,clicks,ctr,spend';
// The only reads allowed: the account itself, or its insights / campaigns / adsets / ads lists.
const PATH_RE = /^act_\d{1,25}(\/(insights|campaigns|adsets|ads))?$/;

function keychain(name) {
  try {
    const { execFileSync } = require('child_process');
    return String(execFileSync('security', ['find-generic-password', '-s', name, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
  } catch (e) { return null; }
}

function tokenOf(env = process.env, secrets = keychain) {
  const t = String(env[TOKEN_ENV] || '').trim();
  if (t) return t;
  return secrets ? (secrets(KEYCHAIN) || null) : null;
}

function accountOf(env = process.env) {
  const a = String(env[ACCOUNT_ENV] || '').trim().replace(/^act_/, '');
  return /^\d{1,25}$/.test(a) ? a : null;
}

function pending(why) {
  return { ok: false, pending: true, audience: 'UNVERIFIED', why: `Meta read access pending: ${why}` };
}

// The URL for one read. Refuses anything that is not an ad-account read path.
function readUrl(path, params = {}, env = process.env) {
  if (!PATH_RE.test(String(path))) throw new Error(`not a Meta ad account read: ${path}`);
  const v = /^v\d{1,3}\.\d$/.test(String(env.META_GRAPH_VERSION || '')) ? env.META_GRAPH_VERSION : GRAPH_VERSION;
  const q = new URLSearchParams(Object.entries(params).filter(([k]) => !/token/i.test(k)));
  return `${HOST}/${v}/${path}${q.toString() ? `?${q}` : ''}`;
}

// One GET. Returns { ok, data } | pending(...) | { ok: false, why } (never the token).
async function metaGet(path, { params = {}, env = process.env, fetchImpl = globalThis.fetch, secrets = keychain } = {}) {
  const token = tokenOf(env, secrets);
  if (!token) return pending(`no ${TOKEN_ENV} (or Keychain item ${KEYCHAIN}) on the Box yet; Mimi creates the Analyst system user with ${SCOPE} only`);
  let url;
  try { url = readUrl(path, params, env); } catch (e) { return { ok: false, why: e.message }; }
  let r;
  try { r = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }); } catch (e) { return { ok: false, why: `Meta did not answer (${String(e && e.message || e).replace(token, '[token]')})` }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, why: `Meta answered ${r.status}${j && j.error && j.error.type ? ` (${j.error.type})` : ''}` };
  return { ok: true, data: j };
}

// The Engagement Sleuth's read: last 30 days of the one ad account's insights.
async function readAdAccount({ env = process.env, fetchImpl = globalThis.fetch, secrets = keychain } = {}) {
  const token = tokenOf(env, secrets);
  if (!token) return pending(`no ${TOKEN_ENV} (or Keychain item ${KEYCHAIN}) on the Box yet; Mimi creates the Analyst system user with ${SCOPE} only`);
  const acct = accountOf(env);
  if (!acct) return pending(`no ${ACCOUNT_ENV} set (the one ad account to read)`);
  return metaGet(`act_${acct}/insights`, { params: { level: 'adset', date_preset: 'last_30d', fields: READ_FIELDS }, env, fetchImpl, secrets });
}

// ---------------------------------------------------------------- ORDER #3804: the weekly ad-level read
const ACCOUNTS_ENV = 'META_AD_ACCOUNT_IDS';
// Fields and level verified 11.25.2026 on developers.facebook.com/documentation/
// ads-commerce/marketing-api/reference/ad-account/insights (level enum
// {ad, adset, campaign, account}; ad_id, ad_name, adset_name, campaign_name,
// clicks, actions; time_range {'since':YYYY-MM-DD,'until':YYYY-MM-DD}).
const WEEK_FIELDS = 'campaign_name,adset_name,ad_name,ad_id,impressions,clicks,spend,actions';
// What counts as a conversion. Verified 11.25.2026 on developers.facebook.com/docs/
// marketing-api/reference/ads-action-stats: `lead` is "All offsite leads plus all
// On-Facebook leads", so it is used alone when present (the others are parts of
// it and adding them would double count). META_CONVERSION_ACTION overrides it.
const CONVERSION_ACTIONS = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];

function accountsOf(env = process.env) {
  const list = String(env[ACCOUNTS_ENV] || '').split(',').map((s) => s.trim().replace(/^act_/, '')).filter((s) => /^\d{1,25}$/.test(s));
  if (list.length) return [...new Set(list)];
  const one = accountOf(env);
  return one ? [one] : [];
}

function conversionsOf(actions, env = process.env) {
  const by = new Map((Array.isArray(actions) ? actions : []).map((a) => [String(a.action_type || ''), Number(a.value) || 0]));
  const pick = String(env.META_CONVERSION_ACTION || '').trim();
  if (pick) return by.get(pick) || 0;
  if (by.has('lead')) return by.get('lead');
  return (by.get('onsite_conversion.lead_grouped') || 0) + (by.get('offsite_conversion.fb_pixel_lead') || 0);
}

// Raw insight rows -> rows with spend as a share of the account's week, no amount.
function weekRows(rows, env = process.env) {
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const total = (rows || []).reduce((s, r) => s + n(r.spend), 0);
  return (rows || []).map((r) => ({
    campaign: r.campaign_name || '', adset: r.adset_name || '', ad: r.ad_name || '', ad_id: String(r.ad_id || ''),
    impressions: n(r.impressions), clicks: n(r.clicks), conversions: conversionsOf(r.actions, env),
    spend_share_pct: total ? Math.round((n(r.spend) / total) * 1000) / 10 : 0,
  }));
}

async function insightsFor(acct, since, until, opts) {
  const out = [];
  let after;
  for (let i = 0; i < 20; i++) {
    const params = { level: 'ad', time_range: JSON.stringify({ since, until }), fields: WEEK_FIELDS, limit: '500', ...(after ? { after } : {}) };
    const r = await metaGet(`act_${acct}/insights`, { ...opts, params });
    if (!r.ok) return r;
    out.push(...((r.data && r.data.data) || []));
    after = r.data && r.data.paging && r.data.paging.cursors && r.data.paging.next ? r.data.paging.cursors.after : null;
    if (!after) return { ok: true, rows: out };
  }
  return { ok: false, why: 'a Meta insights read ran past 20 pages; nothing from it was used' };
}

// week = { week: 'YYYY-MM-DD' (Monday), prior: 'YYYY-MM-DD' (Monday before) }.
// Answers { ok, accounts: [{ id, name, ads, prior }] } | pending(...) | { ok: false, why }.
async function readAdsWeek(week, { env = process.env, fetchImpl = globalThis.fetch, secrets = keychain } = {}) {
  const token = tokenOf(env, secrets);
  if (!token) return pending(`no ${TOKEN_ENV} (or Keychain item ${KEYCHAIN}) on the Box yet; the IHG Brain system user's ${SCOPE} token goes there once Katherine finishes the Meta setup`);
  const ids = accountsOf(env);
  if (!ids.length) return pending(`no ${ACCOUNTS_ENV} (or ${ACCOUNT_ENV}) set: the ad account ids to read`);
  const addDays = (ymd, k) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
  const opts = { env, fetchImpl, secrets };
  const accounts = [];
  for (const id of ids) {
    const head = await metaGet(`act_${id}`, { ...opts, params: { fields: 'name' } });
    if (!head.ok) return { ok: false, why: `ad account ${id}: ${head.why}` };
    const cur = await insightsFor(id, week.week, addDays(week.week, 6), opts);
    if (!cur.ok) return { ok: false, why: `ad account ${id}: ${cur.why}` };
    const prev = await insightsFor(id, week.prior, addDays(week.prior, 6), opts);
    if (!prev.ok) return { ok: false, why: `ad account ${id}: ${prev.why}` };
    accounts.push({ id, name: (head.data && head.data.name) || `Meta ad account ${id}`, ads: weekRows(cur.rows, env),
      prior: weekRows(prev.rows, env).map((r) => ({ ad_id: r.ad_id, conversions: r.conversions })) });
  }
  return { ok: true, accounts };
}

module.exports = { HOST, GRAPH_VERSION, TOKEN_ENV, KEYCHAIN, ACCOUNT_ENV, ACCOUNTS_ENV, SCOPE, PATH_RE, WEEK_FIELDS, CONVERSION_ACTIONS,
  tokenOf, accountOf, accountsOf, conversionsOf, weekRows, readUrl, metaGet, readAdAccount, readAdsWeek };
