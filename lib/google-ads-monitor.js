// ORDER #3794: the hourly Google Ads monitor's rules. Pure functions over the
// normalized accounts lib/google-ads-read.js returns, plus one GET-only URL
// checker. It flags; it never changes anything in Google Ads, and its text
// carries counts, shares and changes, never a dollar figure.
//
// The five flags (order #3794, "Live monitor"):
//   zero_conv   a keyword or search term took >= ADS_ZERO_CONV_SHARE_PCT (default
//               10) percent of its account's spend in the newest full week, with
//               >= ADS_ZERO_CONV_MIN_CLICKS (default 5) clicks and 0 conversions
//   drop        an enabled campaign averaged >= ADS_DROP_MIN_IMPRESSIONS (default
//               20) impressions a day over the 7 days before yesterday, and had 0
//               yesterday (a full day; an hour-old "today" is too noisy)
//   disapproved an enabled ad whose approval status is DISAPPROVED
//   limited     an enabled campaign whose primary status is LIMITED; and paused,
//               a campaign that was ENABLED at the last poll and is PAUSED now
//               (the first poll is the baseline and flags no pause)
//   url         a final URL that answers 404 or 410 (at once), or fails twice in
//               a row any other way (Night Watch's two-strike rule)
//   overlap     one search term showing in two or more of our accounts (one
//               account = one venue; UNVERIFIED until the account list is read)
//               in the same week
//
// Each flag has a stable key. A key already flagged is not carded again; the
// state file remembers keys, campaign statuses and URL results between polls.
'use strict';

const R = require('./google-ads-read');

const DEFAULTS = Object.freeze({ zeroConvSharePct: 10, zeroConvMinClicks: 5, dropMinImpressions: 20 });
function thresholds(env = process.env) {
  const num = (k, d) => { const x = Number(String((env || {})[k] || '').trim()); return Number.isFinite(x) && x > 0 ? x : d; };
  return {
    zeroConvSharePct: num('ADS_ZERO_CONV_SHARE_PCT', DEFAULTS.zeroConvSharePct),
    zeroConvMinClicks: num('ADS_ZERO_CONV_MIN_CLICKS', DEFAULTS.zeroConvMinClicks),
    dropMinImpressions: num('ADS_DROP_MIN_IMPRESSIONS', DEFAULTS.dropMinImpressions),
  };
}

const share = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function weekSpend(a) {
  const m = new Map();
  for (const r of a.daily) { const w = R.mondayOf(r.date); m.set(w, (m.get(w) || 0) + r.spend); }
  return m;
}

function zeroConv(a, today, t) {
  const week = R.addDays(R.mondayOf(today), -7); // newest FULL week
  const total = weekSpend(a).get(week) || 0;
  if (!total) return [];
  const out = [];
  const look = (list, kind, label) => {
    for (const r of list) {
      if (r.week !== week || r.conversions > 0 || r.clicks < t.zeroConvMinClicks) continue;
      const s = share(r.spend, total);
      if (s < t.zeroConvSharePct) continue;
      out.push({ kind: 'zero_conv', key: `zero_conv:${a.id}:${kind}:${r.campaign}:${r.ad_group}:${r.text}:${week}`,
        text: `${a.name}: ${kind} ${label(r)} (${r.campaign} / ${r.ad_group}) took ${s}% of the account's spend in the week of ${week} with ${r.clicks} clicks and 0 conversions` });
    }
  };
  look(a.keywords, 'keyword', (r) => `"${r.text}" (${String(r.match_type).toLowerCase() || 'match type unknown'})`);
  look(a.terms, 'search term', (r) => `"${r.text}"`);
  return out;
}

function drops(a, today, t) {
  const yday = R.addDays(today, -1);
  const out = [];
  const enabled = new Map(a.campaigns.filter((c) => c.status === 'ENABLED').map((c) => [c.id, c]));
  for (const [id, c] of enabled) {
    const days = a.daily.filter((r) => r.campaign_id === id);
    const on = (d) => days.filter((r) => r.date === d).reduce((s, r) => s + r.impressions, 0);
    let before = 0;
    for (let k = 2; k <= 8; k++) before += on(R.addDays(today, -k));
    const avg = before / 7;
    if (avg >= t.dropMinImpressions && on(yday) === 0) {
      out.push({ kind: 'drop', key: `drop:${a.id}:${id}:${yday}`,
        text: `${a.name}: campaign "${c.name}" dropped to 0 impressions on ${yday} (it averaged ${Math.round(avg)} a day the week before)` });
    }
  }
  return out;
}

function statusFlags(a, prior, today) {
  const out = [];
  const was = ((prior && prior.campaigns) || {})[a.id] || null;
  for (const c of a.campaigns) {
    if (c.status === 'ENABLED' && c.primary_status === 'LIMITED') {
      out.push({ kind: 'limited', key: `limited:${a.id}:${c.id}`, text: `${a.name}: campaign "${c.name}" is limited (primary status LIMITED)` });
    }
    if (was && was[c.id] === 'ENABLED' && c.status === 'PAUSED') {
      out.push({ kind: 'paused', key: `paused:${a.id}:${c.id}:${today || ''}`, text: `${a.name}: campaign "${c.name}" was running at the last check and is paused now` });
    }
  }
  for (const ad of a.ads) {
    if (ad.approval === 'DISAPPROVED') {
      out.push({ kind: 'disapproved', key: `disapproved:${a.id}:${ad.id}`, text: `${a.name}: ad ${ad.id} in ${ad.campaign} / ${ad.ad_group} is disapproved${ad.final_urls[0] ? ` (${ad.final_urls[0]})` : ''}` });
    }
  }
  return out;
}

function overlaps(accounts, today) {
  const weeks = new Set([R.mondayOf(today), R.addDays(R.mondayOf(today), -7)]);
  const by = new Map();
  for (const a of accounts) {
    for (const r of a.terms) {
      if (!weeks.has(r.week) || !r.impressions) continue;
      const k = `${r.week}\u0000${String(r.text).trim().toLowerCase()}`;
      const set = by.get(k) || new Map();
      set.set(a.id, a.name);
      by.set(k, set);
    }
  }
  const out = [];
  for (const [k, set] of by) {
    if (set.size < 2) continue;
    const [week, term] = k.split('\u0000');
    out.push({ kind: 'overlap', key: `overlap:${term}:${week}`, text: `"${term}": ${[...set.values()].sort().join(' and ')} both showed ads for it in the week of ${week}` });
  }
  return out;
}

// ---------------------------------------------------------------- URLs (Night Watch's checker, ported)
// brain-core box_jobs/site_guardian/watch.py fetch(): GET only, a named
// read-only User-Agent, 15 s timeout, redirects followed, status 0 = no answer.
const USER_AGENT = 'IHG-AdsMonitor/1.0 (+brain@infinityhospitality.net; read-only watch)';
const URL_TIMEOUT_MS = 15000;
const URL_RECHECK_HOURS = 24;

async function urlStatus(url, { fetchImpl = globalThis.fetch, method = 'GET' } = {}) {
  if (method !== 'GET') throw new Error(`the ads monitor's URL check is read-only: GET only, refused ${method}`);
  if (!/^https?:\/\//i.test(String(url))) return 0;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), URL_TIMEOUT_MS);
    const r = await fetchImpl(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': USER_AGENT }, signal: ctl.signal });
    clearTimeout(timer);
    return r.status;
  } catch (e) { return 0; }
}

function finalUrls(accounts) {
  const s = new Set();
  for (const a of accounts) {
    for (const ad of a.ads) for (const u of ad.final_urls) s.add(u);
    for (const k of a.keywords) for (const u of k.final_urls || []) s.add(u);
  }
  return [...s].sort();
}

// Checks each URL at most once a day; returns the new url state and the flags.
async function checkUrls(urls, prior, { now = new Date(), check = urlStatus } = {}) {
  const was = (prior && prior.urls) || {};
  const state = {};
  const out = [];
  for (const u of urls) {
    const p = was[u];
    if (p && p.at && now.getTime() - new Date(p.at).getTime() < URL_RECHECK_HOURS * 3600000) { state[u] = p; continue; }
    const st = await check(u);
    const ok = st >= 200 && st < 400;
    const fails = ok ? 0 : (p ? p.fails || 0 : 0) + 1;
    state[u] = { status: st, fails, at: now.toISOString() };
    if (st === 404 || st === 410) out.push({ kind: 'url', key: `url:${u}:${st}`, text: `final URL ${u} answers ${st}` });
    else if (!ok && fails >= 2) out.push({ kind: 'url', key: `url:${u}:${st}`, text: `final URL ${u} ${st ? `answers ${st}` : 'did not answer'} on two checks in a row` });
  }
  return { urls: state, flags: out };
}

// ---------------------------------------------------------------- the whole poll
function flagsFor(accounts, prior, { now = new Date(), env = process.env } = {}) {
  const t = thresholds(env);
  const today = R.ctYmd(now);
  const out = [];
  for (const a of accounts) out.push(...zeroConv(a, today, t), ...drops(a, today, t), ...statusFlags(a, prior, today));
  out.push(...overlaps(accounts, today));
  return out;
}

function campaignState(accounts) {
  const o = {};
  for (const a of accounts) o[a.id] = Object.fromEntries(a.campaigns.map((c) => [c.id, c.status]));
  return o;
}

// The flags no earlier poll carded.
function newFlags(flags, prior) {
  const seen = new Set((prior && prior.flagged) || []);
  return flags.filter((f) => !seen.has(f.key));
}

// No card or log line may carry a currency figure (order #3794).
const MONEY = /[$€£]|\bUSD\b|\bdollars?\b|\bcost_micros\b|\bcostMicros\b/i;
function noMoney(text) {
  if (MONEY.test(String(text))) throw new Error('refused: the ads monitor wrote a money word or figure; nothing was carded');
  return text;
}

const LABEL = { zero_conv: 'Spent with no conversions', drop: 'Impressions dropped to 0', disapproved: 'Disapproved ads',
  limited: 'Limited campaigns', paused: 'Paused since the last check', url: 'Final URLs that do not load', overlap: 'Our venues bidding on the same search term' };

// One draft card per poll that found something new: Katherine's Paid Ads
// Auditor card, and the Review pile (every draft card is on Review).
function cardFor(fresh, { now = new Date() } = {}) {
  if (!fresh.length) return null;
  const parts = [];
  for (const kind of Object.keys(LABEL)) {
    const these = fresh.filter((f) => f.kind === kind);
    if (these.length) parts.push(`**${LABEL[kind]}**\n${these.map((f) => `- ${f.text}`).join('\n')}`);
  }
  const body = noMoney(`${parts.join('\n\n')}\n\nRead live from Google Ads (read-only). The Brain changed nothing; K&M make any change.`);
  return {
    agent: 'paid-ads', agent_name: 'Paid Ads Auditor', job: 'hourly Google Ads monitor', target: 'Google Ads',
    title: noMoney(`Google Ads: ${fresh.length} new flag${fresh.length === 1 ? '' : 's'} (${R.ctYmd(now)})`),
    body, sources: ['Google Ads API (read-only)'], payload: { ads_monitor: { keys: fresh.map((f) => f.key), kinds: [...new Set(fresh.map((f) => f.kind))] } },
  };
}

module.exports = { DEFAULTS, thresholds, zeroConv, drops, statusFlags, overlaps, urlStatus, finalUrls, checkUrls, flagsFor, campaignState, newFlags, noMoney, cardFor, USER_AGENT, LABEL };
