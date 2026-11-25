// ORDER #3804 (Mimi, 11.24.2026: "Meta and Google Ads weekly report: this ad
// word is leading to conversions over the week."): the Paid Ads Auditor's
// Monday report. Per venue, for the newest full week (Monday to Sunday, CT):
//   - Google: the keywords and search terms that drove conversions, and the ones
//     that spent with none;
//   - Meta: the ads that drove conversions, and the ones that spent with none;
//   - drafted action lines for K&M or Katherine ("Add 'x' as exact match for
//     <venue>"). Drafted only: K&M make every change in the ad accounts.
//
// THE FENCES (code, not prompt):
//   1. No dollar figure. Google rows arrive from the #3794 snapshot, which holds
//      spend only as a share of the account's week. Meta rows are reduced to the
//      same share inside lib/meta-read.js before they reach this file. Every line
//      this file returns passes google-ads-monitor.noMoney(), which refuses a
//      currency sign or money word (test/order3804_paid_ads_weekly.test.js).
//   2. Read-only. This file is pure: it reads two objects and returns text. It
//      has no client, no token and no network.
//   3. A missing source is a "Waiting on" line, never a silent gap.
//
// One account = one venue, as in #3794 (UNVERIFIED until the account list is read).
'use strict';

const R = require('./google-ads-read');
const M = require('./google-ads-monitor');

const FLAG = 'PAID_ADS_WEEKLY';
const ON = /^(1|on|true|yes)$/i;
function flagOn(env = process.env) { return ON.test(String((env || {})[FLAG] || '').trim()); }

const DEFAULTS = Object.freeze({ noConvSharePct: 5, noConvMinClicks: 3, maxRows: 10, maxActions: 8 });
function thresholds(env = process.env) {
  const num = (k, d) => { const x = Number(String((env || {})[k] || '').trim()); return Number.isFinite(x) && x > 0 ? x : d; };
  return {
    noConvSharePct: num('PAID_ADS_WEEKLY_SHARE_PCT', DEFAULTS.noConvSharePct),
    noConvMinClicks: num('PAID_ADS_WEEKLY_MIN_CLICKS', DEFAULTS.noConvMinClicks),
    maxRows: DEFAULTS.maxRows,
    maxActions: DEFAULTS.maxActions,
  };
}

// The newest full week (its Monday) and the week before it, from a CT date.
function reportWeek(now = new Date()) {
  const week = R.addDays(R.mondayOf(R.ctYmd(now)), -7);
  return { week, prior: R.addDays(week, -7), end: R.addDays(week, 6) };
}
const mdY = (ymd) => { const [y, m, d] = String(ymd).split('-'); return `${m}.${d}.${y}`; };

const r1 = (x) => Math.round(x * 10) / 10;
const pct = (a, b) => (b ? r1((a / b) * 100) : 0);
function trend(cur, prev) {
  if (!prev && cur) return 'new this week';
  if (!prev) return 'flat';
  const c = r1(((cur - prev) / prev) * 100);
  return c > 0 ? `up ${c}%` : c < 0 ? `down ${Math.abs(c)}%` : 'flat';
}
const lc = (s) => String(s || '').trim().toLowerCase();

// ---------------------------------------------------------------- Google (from the #3794 snapshot)
// ORDER #3821: the snapshot is written once a day (6:15 AM CT), so fresh = 30 hours.
const SNAPSHOT_FRESH_HOURS = 30;

// Why the Google half cannot be read, or null when it can.
function googleWaiting(snap, { env = process.env, now = new Date() } = {}) {
  if (!R.flagOn(env)) return `Google Ads API read is not on yet (#3794: Mimi's two setup clicks and merge, then ${R.FLAG})`;
  if (!snap || !snap.generated_at) return 'the daily Google Ads pull has not written a snapshot yet (jobs/ads_monitor.js)';
  const age = (now.getTime() - new Date(snap.generated_at).getTime()) / 3600000;
  if (!(age <= SNAPSHOT_FRESH_HOURS)) return `the Google Ads snapshot is stale (written ${snap.generated_at}); the daily 6:15 AM pull is not running`;
  return null;
}

function googleVenue(a, wk, t) {
  const inWeek = (list, w) => (list || []).filter((r) => r.week === w);
  const rowsOf = (list, label) => {
    const cur = inWeek(list, wk.week);
    const prev = new Map(inWeek(list, wk.prior).map((r) => [label(r), r]));
    return cur.map((r) => ({ ...r, label: label(r), prev_conversions: (prev.get(label(r)) || {}).conversions || 0, prev_seen: prev.has(label(r)) }));
  };
  const kws = rowsOf(a.keywords, (r) => `${lc(r.keyword)}|${lc(r.match_type)}|${r.campaign}|${r.ad_group}`);
  const terms = rowsOf(a.search_terms, (r) => `${lc(r.search_term)}|${r.campaign}|${r.ad_group}`);
  const weekRow = (a.weeks || []).find((w) => w.week === wk.week) || null;
  const priorRow = (a.weeks || []).find((w) => w.week === wk.prior) || null;
  const totalConv = weekRow ? weekRow.conversions : [...kws].reduce((s, r) => s + r.conversions, 0);

  const converting = (list) => list.filter((r) => r.conversions > 0).sort((x, y) => y.conversions - x.conversions || y.clicks - x.clicks).slice(0, t.maxRows);
  const noConv = (list) => list.filter((r) => !(r.conversions > 0) && (r.spend_share_pct || 0) >= t.noConvSharePct && r.clicks >= t.noConvMinClicks)
    .sort((x, y) => (y.spend_share_pct || 0) - (x.spend_share_pct || 0)).slice(0, t.maxRows);

  const kwLine = (r) => `"${r.keyword}" (${lc(r.match_type) || 'match type unknown'}, ${r.campaign} / ${r.ad_group})`;
  const termLine = (r) => `"${r.search_term}" (${r.campaign} / ${r.ad_group})`;
  const conv = (r, what) => `- ${what}: ${r1(r.conversions)} conversion${r.conversions === 1 ? '' : 's'} (${pct(r.conversions, totalConv)}% of the venue's week), ${r.clicks} clicks, ${r.spend_share_pct}% of spend; ${trend(r.conversions, r.prev_conversions)} on the week before`;
  const none = (r, what) => `- ${what}: ${r.spend_share_pct}% of spend, ${r.clicks} clicks, 0 conversions${r.prev_seen && !(r.prev_conversions > 0) ? ' (also 0 the week before)' : ''}`;

  const cKw = converting(kws);
  const cTerms = converting(terms);
  const nKw = noConv(kws);
  const nTerms = noConv(terms);

  // Action lines (drafted only; K&M make the change).
  const exact = new Set((a.keywords || []).filter((k) => lc(k.match_type) === 'exact').map((k) => lc(k.keyword)));
  const actions = [];
  for (const r of cTerms) {
    if (!exact.has(lc(r.search_term))) actions.push(`Add "${r.search_term}" as exact match for ${a.name} (${r1(r.conversions)} conversion${r.conversions === 1 ? '' : 's'} this week from the search term, no exact-match keyword yet)`);
  }
  for (const r of nTerms) actions.push(`Add "${r.search_term}" as a negative keyword for ${a.name}, or check its landing page (${r.spend_share_pct}% of spend, 0 conversions)`);
  for (const r of nKw) {
    if (r.prev_seen && !(r.prev_conversions > 0)) actions.push(`Pause or tighten keyword "${r.keyword}" (${lc(r.match_type)}) for ${a.name}: 0 conversions two weeks running`);
  }

  const lines = [];
  const convChange = priorRow ? trend(weekRow ? weekRow.conversions : 0, priorRow.conversions) : 'no week before to compare';
  const spendChange = weekRow && weekRow.spend_change_pct != null ? `${weekRow.spend_change_pct > 0 ? 'up' : weekRow.spend_change_pct < 0 ? 'down' : 'flat'}${weekRow.spend_change_pct ? ` ${Math.abs(weekRow.spend_change_pct)}%` : ''}` : 'n/a';
  lines.push(`Week: ${weekRow ? r1(weekRow.conversions) : 0} conversions (${convChange}), ${weekRow ? weekRow.clicks : 0} clicks; spend ${spendChange} on the week before.`);
  if (cKw.length) lines.push(`Keywords that converted:\n${cKw.map((r) => conv(r, kwLine(r))).join('\n')}`);
  if (cTerms.length) lines.push(`Search terms that converted:\n${cTerms.map((r) => conv(r, termLine(r))).join('\n')}`);
  if (!cKw.length && !cTerms.length) lines.push('No keyword or search term converted this week.');
  if (nKw.length) lines.push(`Keywords that spent with none:\n${nKw.map((r) => none(r, kwLine(r))).join('\n')}`);
  if (nTerms.length) lines.push(`Search terms that spent with none:\n${nTerms.map((r) => none(r, termLine(r))).join('\n')}`);
  return { venue: a.name, id: a.id, text: lines.join('\n\n'), actions: actions.slice(0, t.maxActions),
    counts: { converting_keywords: cKw.length, converting_terms: cTerms.length, no_conv_keywords: nKw.length, no_conv_terms: nTerms.length } };
}

// ---------------------------------------------------------------- Meta (from lib/meta-read.js readAdsWeek)
// meta = { ok, accounts: [{ id, name, ads: [{ campaign, adset, ad, ad_id, impressions, clicks, conversions, spend_share_pct }],
//          prior: [{ ad_id, conversions }] }] } | { ok: false, why, pending? }
function metaVenue(acct, t) {
  const ads = acct.ads || [];
  const prev = new Map((acct.prior || []).map((r) => [r.ad_id, r.conversions || 0]));
  const total = ads.reduce((s, r) => s + (r.conversions || 0), 0);
  const label = (r) => `"${r.ad}" (${r.campaign} / ${r.adset})`;
  const conv = ads.filter((r) => r.conversions > 0).sort((x, y) => y.conversions - x.conversions).slice(0, t.maxRows);
  const none = ads.filter((r) => !(r.conversions > 0) && (r.spend_share_pct || 0) >= t.noConvSharePct && r.clicks >= t.noConvMinClicks)
    .sort((x, y) => (y.spend_share_pct || 0) - (x.spend_share_pct || 0)).slice(0, t.maxRows);
  const lines = [`Week: ${r1(total)} conversions across ${ads.length} ad${ads.length === 1 ? '' : 's'}.`];
  if (conv.length) lines.push(`Ads that converted:\n${conv.map((r) => `- ${label(r)}: ${r1(r.conversions)} conversion${r.conversions === 1 ? '' : 's'} (${pct(r.conversions, total)}% of the account's week), ${r.clicks} clicks, ${r.spend_share_pct}% of spend; ${trend(r.conversions, prev.get(r.ad_id) || 0)} on the week before`).join('\n')}`);
  else lines.push('No ad converted this week.');
  if (none.length) lines.push(`Ads that spent with none:\n${none.map((r) => `- ${label(r)}: ${r.spend_share_pct}% of spend, ${r.clicks} clicks, 0 conversions`).join('\n')}`);
  const actions = none.map((r) => `Review Meta ad ${label(r)} for ${acct.name}: new creative or audience, or move its share to a converting ad (${r.spend_share_pct}% of spend, 0 conversions)`);
  return { venue: acct.name, id: acct.id, text: lines.join('\n\n'), actions: actions.slice(0, t.maxActions), counts: { converting_ads: conv.length, no_conv_ads: none.length } };
}

// ---------------------------------------------------------------- the card
function report({ snapshot = null, meta = null, now = new Date(), env = process.env } = {}) {
  const t = thresholds(env);
  const wk = reportWeek(now);
  const waiting = [];
  const sections = [];
  const actions = [];
  const counts = { google_venues: 0, meta_accounts: 0 };

  const gWhy = googleWaiting(snapshot, { env, now });
  if (gWhy) waiting.push(`Waiting on Google Ads: ${gWhy}.`);
  else {
    for (const a of snapshot.accounts || []) {
      const v = googleVenue(a, wk, t);
      counts.google_venues++;
      sections.push(`### ${v.venue}: Google Ads\n${v.text}`);
      actions.push(...v.actions);
    }
    if (!(snapshot.accounts || []).length) waiting.push('Waiting on Google Ads: the Brain can see 0 Google Ads accounts.');
  }

  if (!meta || !meta.ok) waiting.push(`Waiting on Meta: ${(meta && meta.why) || 'Meta was not read'}.`);
  else {
    for (const acct of meta.accounts || []) {
      const v = metaVenue(acct, t);
      counts.meta_accounts++;
      sections.push(`### ${v.venue}: Meta`);
      sections[sections.length - 1] += `\n${v.text}`;
      actions.push(...v.actions);
    }
    if (!(meta.accounts || []).length) waiting.push('Waiting on Meta: no Meta ad account was readable.');
  }

  const parts = [`Week of ${mdY(wk.week)} to ${mdY(wk.end)}. Conversions are what each platform reports; spend appears only as a share of the venue's week.`];
  if (waiting.length) parts.push(waiting.join('\n'));
  if (sections.length) parts.push(sections.join('\n\n'));
  parts.push(actions.length ? `## Drafted changes for K&M\n${actions.map((x) => `- ${x}`).join('\n')}` : '## Drafted changes for K&M\nNone this week.');
  parts.push('Read-only: the Brain changed nothing in Google Ads or Meta. K&M make any change; Katherine decides which of these go to them.');
  const body = M.noMoney(parts.join('\n\n'));
  return {
    agent: 'paid-ads', agent_name: 'Paid Ads Auditor', job: 'weekly converting keywords and ads report', target: 'Google Ads and Meta',
    title: M.noMoney(`Paid ads weekly: what converted, week of ${mdY(wk.week)}`),
    body,
    sources: [gWhy ? 'Google Ads (waiting)' : 'Google Ads API (read-only)', meta && meta.ok ? 'Meta Marketing API (read-only, ads_read)' : 'Meta (waiting)'],
    payload: { paid_ads_weekly: { week: wk.week, waiting: waiting.length, actions: actions.length, ...counts } },
  };
}

module.exports = { FLAG, DEFAULTS, flagOn, thresholds, reportWeek, mdY, trend, googleWaiting, googleVenue, metaVenue, report, SNAPSHOT_FRESH_HOURS };
