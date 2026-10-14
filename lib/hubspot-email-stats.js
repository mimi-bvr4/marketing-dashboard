// ORDER #1733: the fenced, read-only HubSpot marketing-email statistics reader
// behind the Email agent's monthly scorecard (#1724).
//
// THE FENCE. Every call goes through request(), which refuses any method but
// GET and any path not on ALLOWED_PATHS before a byte leaves the process. What
// comes back is aggregate counts only: no email names, no contact fields.
// A 401/403 fails closed as "scope missing: <what HubSpot named>"; any other
// non-200 fails closed with its status. No number is ever made up.
//
// UNVERIFIED (#1733 REPLY): the path below and the counter names in COUNTERS
// were not checked against HubSpot's docs in the run that wrote this (the docs
// tools were refused). A wrong path answers 404, which fails closed as
// "endpoint not found"; it can never produce a number.
'use strict';

const { hubspotToken, hubspotHeaders } = require('./hubspot-token');

const BASE = 'https://api.hubapi.com';
const STATS_PATH = '/marketing/v3/emails/statistics/list';
const ALLOWED_PATHS = Object.freeze([STATS_PATH]);

// HubSpot counter key -> the scorecard's name for it. Anything else in the
// answer is dropped, so a contact or email field can never ride through.
const COUNTERS = Object.freeze({
  sent: 'sent', delivered: 'delivered', open: 'opens', click: 'clicks',
  unsubscribed: 'unsubscribes', hardbounced: 'hard_bounces', softbounced: 'soft_bounces',
  bounce: 'bounces', spamreport: 'spam_reports',
});

function refuse(why) { return { ok: false, refused: true, why }; }

async function request({ method = 'GET', path, query = {}, env = process.env, fetchImpl = globalThis.fetch }) {
  if (String(method).toUpperCase() !== 'GET') return refuse(`refused: ${method} is not allowed (GET only)`);
  if (!ALLOWED_PATHS.includes(path)) return refuse(`refused: ${path} is not on the allow-list`);
  if (!hubspotToken(env)) return { ok: false, why: 'no HUBSPOT_TOKEN in this environment' };
  const qs = new URLSearchParams(query).toString();
  let r;
  try { r = await fetchImpl(`${BASE}${path}${qs ? '?' + qs : ''}`, { method: 'GET', headers: hubspotHeaders(env) }); }
  catch (e) { return { ok: false, why: `HubSpot could not be reached: ${e.message}` }; }
  let body = null;
  try { body = await r.json(); } catch (e) { body = null; }
  if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, why: `scope missing: ${scopeNames(body)}` };
  if (r.status === 404) return { ok: false, status: 404, why: `endpoint not found (404 on ${path})` };
  if (r.status !== 200) return { ok: false, status: r.status, why: `HubSpot answered ${r.status}` };
  return { ok: true, status: 200, body };
}

// The scope names HubSpot itself puts in a 401/403 answer, never a guess.
function scopeNames(body) {
  const found = new Set();
  const walk = (v, key) => {
    if (Array.isArray(v)) { if (/scope/i.test(key || '')) v.forEach((s) => typeof s === 'string' && found.add(s)); else v.forEach((x) => walk(x, key)); }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(body, '');
  return found.size ? [...found].join(', ') : 'HubSpot did not name the scope';
}

// The previous calendar month in Nashville, as HubSpot timestamps.
function lastMonth(now = new Date()) {
  const [y, m] = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }).split('-').map(Number);
  const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
  const pad = (n) => String(n).padStart(2, '0');
  const days = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return { label: `${py}-${pad(pm)}`, start: `${py}-${pad(pm)}-01T00:00:00${ctOffset(py, pm, 1)}`,
    end: `${py}-${pad(pm)}-${pad(days)}T23:59:59${ctOffset(py, pm, days)}` };
}

// "-05:00" in daylight time, "-06:00" in standard time, read from the tz database.
function ctOffset(y, m, d) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(Date.UTC(y, m - 1, d, 12))).find((p) => p.type === 'timeZoneName').value; // "GMT-5"
  const h = Number(name.replace('GMT', '')) || 0;
  return `${h < 0 ? '-' : '+'}${String(Math.abs(h)).padStart(2, '0')}:00`;
}

function aggregate(body) {
  const c = body && body.aggregate && body.aggregate.counters;
  if (!c || typeof c !== 'object') return null;
  const out = {};
  for (const [k, name] of Object.entries(COUNTERS)) if (Number.isFinite(Number(c[k]))) out[name] = Number(c[k]);
  return Object.keys(out).length ? out : null;
}

async function emailStats({ range, now, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const w = range || lastMonth(now);
  const r = await request({ path: STATS_PATH, query: { startTimestamp: w.start, endTimestamp: w.end }, env, fetchImpl });
  if (!r.ok) return { ok: false, why: r.why, range: w };
  const counts = aggregate(r.body);
  if (!counts) return { ok: false, why: 'HubSpot answered without aggregate counters', range: w };
  return { ok: true, range: w, counts };
}

module.exports = { request, emailStats, lastMonth, aggregate, scopeNames, ALLOWED_PATHS, STATS_PATH, COUNTERS };
