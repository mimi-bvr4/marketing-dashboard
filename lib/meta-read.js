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
// The Graph API version is META_GRAPH_VERSION, else GRAPH_VERSION below
// (UNVERIFIED against Meta's docs on 11.06.2026: the docs lookup was refused
// that run; check it before the first live read).
'use strict';

const HOST = 'https://graph.facebook.com';
const GRAPH_VERSION = 'v21.0';
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

module.exports = { HOST, GRAPH_VERSION, TOKEN_ENV, KEYCHAIN, ACCOUNT_ENV, SCOPE, PATH_RE, tokenOf, accountOf, readUrl, metaGet, readAdAccount };
