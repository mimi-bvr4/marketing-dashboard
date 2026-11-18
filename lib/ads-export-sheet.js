// ORDER #3571 (#3567 follow-up 2): the reader for the ads export Sheet that
// K&M build per 07_Marketing_and_Brand/Ads_Export_Spec_for_KM.md. One Sheet,
// two tabs ("Google Ads", "Meta"), header in row 1, one row per line of data,
// `Week Start` is the Monday of the row's week as YYYY-MM-DD.
//
// THE COLUMN FENCE (the law of #3571): every agent that reads this Sheet has an
// allow-list of columns, and the list is applied while the rows are READ. A
// column off an agent's list is never copied into the row that agent gets, so
// it cannot leak into a prompt, a card or a log by any later mistake.
//   - The Monthly Report never receives `Cost` (Google) or `Amount Spent` (Meta).
//   - The Auditor (paid-ads) may read the spend columns, for trend and percentage
//     math only: its text carries spend as a share and a week-over-week change,
//     never as an amount. No dollar figure is shown to anyone (spec, "What we are
//     NOT asking for").
//   - An agent with no fence gets nothing (fail closed).
//
// Read-only: one Sheets values GET with the Brain's drive.readonly account.
'use strict';

const ENV = 'ADS_EXPORT_SHEET_ID';
const SHEET_ID = /^[A-Za-z0-9_-]{20,}$/;

// The spec's columns, spelled exactly as the spec writes them.
const TABS = {
  'Google Ads': ['Week Start', 'Account', 'Campaign', 'Ad Group', 'Keyword', 'Match Type', 'Search Term', 'Final URL', 'Impressions', 'Clicks', 'Cost', 'Conversions'],
  Meta: ['Week Start', 'Account', 'Campaign', 'Ad Set', 'Ad', 'Destination URL', 'Impressions', 'Reach', 'Link Clicks', 'Amount Spent', 'Leads'],
};
const SPEND = { 'Google Ads': 'Cost', Meta: 'Amount Spent' };
const NUMERIC = new Set(['Impressions', 'Clicks', 'Cost', 'Conversions', 'Reach', 'Link Clicks', 'Amount Spent', 'Leads']);
const RESULTS = { 'Google Ads': { clicks: 'Clicks', results: 'Conversions' }, Meta: { clicks: 'Link Clicks', results: 'Leads' } };

const without = (cols, drop) => cols.filter((c) => c !== drop);
const FENCE = Object.freeze({
  'monthly-report': Object.freeze({ 'Google Ads': without(TABS['Google Ads'], 'Cost'), Meta: without(TABS.Meta, 'Amount Spent') }),
  'paid-ads': Object.freeze({ 'Google Ads': TABS['Google Ads'].slice(), Meta: TABS.Meta.slice() }),
});

const cellText = (v) => String(v === undefined || v === null ? '' : v).trim();
const TOTALS = /^(grand\s+)?totals?:?$/i;

function weekStartOk(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return 'not YYYY-MM-DD';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return 'not a real date';
  if (d.getUTCDay() !== 1) return 'not a Monday';
  return null;
}

function num(s) {
  const t = cellText(s).replace(/[$,\s]/g, '');
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// One tab's raw values (row 1 = header) -> rows carrying ONLY `allowed` columns.
// A missing or renamed spec column refuses the whole tab (no partial read).
function parseTab(tab, values, allowed) {
  const spec = TABS[tab];
  if (!spec) return { ok: false, why: `"${tab}" is not a tab the spec names` };
  if (!Array.isArray(allowed)) return { ok: false, why: `no column fence for the ${tab} tab` };
  const header = ((values || [])[0] || []).map(cellText);
  const missing = spec.filter((c) => !header.includes(c));
  if (missing.length) {
    return { ok: false, why: `the ${tab} tab has no column named ${missing.map((c) => `"${c}"`).join(', ')} in row 1 (the spec spells it exactly that way); nothing was read` };
  }
  const at = Object.fromEntries(spec.map((c) => [c, header.indexOf(c)]));
  const keep = spec.filter((c) => allowed.includes(c));
  const rows = [];
  const skipped = { blank: 0, totals: 0 };
  const refused = [];
  for (let i = 1; i < values.length; i++) {
    const raw = (values[i] || []).map(cellText);
    if (!raw.some(Boolean)) { skipped.blank++; continue; }
    if (raw.some((v) => TOTALS.test(v)) || !raw[at['Week Start']]) { skipped.totals++; continue; }
    const bad = weekStartOk(raw[at['Week Start']]);
    if (bad) { refused.push({ row: i + 1, why: `Week Start "${raw[at['Week Start']]}" is ${bad}` }); continue; }
    const row = {};
    let nan = null;
    for (const c of keep) {
      const v = raw[at[c]] || '';
      if (NUMERIC.has(c)) { const n = num(v); if (n === null) { nan = c; break; } row[c] = n; } else row[c] = v;
    }
    if (nan) { refused.push({ row: i + 1, why: `${nan} is not a number` }); continue; }
    rows.push(row);
  }
  return { ok: true, rows, skipped, refused };
}

// Both tabs for one agent. `valuesByTab` is { 'Google Ads': [[...]], Meta: [[...]] }.
function readFenced(agent, valuesByTab) {
  const fence = FENCE[agent];
  if (!fence) return { ok: false, why: `${agent || 'this agent'} has no column fence for the ads export Sheet, so it reads nothing from it` };
  const tabs = {};
  const counts = {};
  for (const tab of Object.keys(TABS)) {
    if (!valuesByTab || !Array.isArray(valuesByTab[tab])) return { ok: false, why: `the Sheet has no tab named "${tab}" (the spec names "Google Ads" and "Meta"); nothing was read` };
    const r = parseTab(tab, valuesByTab[tab], fence[tab]);
    if (!r.ok) return { ok: false, why: r.why };
    tabs[tab] = r.rows;
    counts[tab] = { rows: r.rows.length, blank_skipped: r.skipped.blank, totals_skipped: r.skipped.totals, refused: r.refused.length, refused_rows: r.refused.slice(0, 20) };
  }
  return { ok: true, tabs, counts };
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : 'n/a');
function change(cur, prev) {
  if (!prev) return cur ? 'new' : 'n/a';
  const p = Math.round(((cur - prev) / prev) * 1000) / 10;
  return `${p > 0 ? '+' : ''}${p}%`;
}

// The text an agent's model reads (and the measured table on its card). Counts
// are counts; spend, where the fence lets it in at all, is a share or a change.
function sourceText(agent, read) {
  const lines = [];
  const tables = [];
  const spendSeen = agent === 'paid-ads';
  for (const tab of Object.keys(TABS)) {
    const rows = read.tabs[tab];
    const k = RESULTS[tab];
    const by = new Map();
    for (const r of rows) {
      const key = `${r.Account}\u0000${r['Week Start']}`;
      const a = by.get(key) || { account: r.Account, week: r['Week Start'], impressions: 0, clicks: 0, results: 0, spend: 0 };
      a.impressions += r.Impressions; a.clicks += r[k.clicks]; a.results += r[k.results];
      if (spendSeen && SPEND[tab] in r) a.spend += r[SPEND[tab]];
      by.set(key, a);
    }
    const agg = [...by.values()].sort((x, y) => x.account.localeCompare(y.account) || x.week.localeCompare(y.week));
    const prevOf = new Map();
    const head = spendSeen
      ? `| Account | Week Start | Impressions | ${k.clicks} | ${k.results} | Spend change vs prior week |\n|---|---|---|---|---|---|`
      : `| Account | Week Start | Impressions | ${k.clicks} | ${k.results} |\n|---|---|---|---|---|`;
    const body = agg.map((a) => {
      const prev = prevOf.get(a.account);
      prevOf.set(a.account, a);
      const base = `| ${a.account} | ${a.week} | ${a.impressions} | ${a.clicks} | ${a.results}`;
      return spendSeen ? `${base} | ${change(a.spend, prev ? prev.spend : 0)} |` : `${base} |`;
    });
    const c = read.counts[tab];
    const note = `${tab}: ${c.rows} rows read; ${c.totals_skipped} totals and ${c.blank_skipped} blank rows skipped; ${c.refused} refused${c.refused ? ` (${c.refused_rows.map((x) => `row ${x.row}: ${x.why}`).join('; ')})` : ''}.`;
    tables.push(`#### ${tab}\n${note}\n\n${head}\n${body.join('\n')}`);
    if (spendSeen) {
      // Search terms / ads in each account's newest week that spent and brought no result,
      // as a share of that account-week's spend. Never the amount.
      const newest = new Map();
      for (const a of agg) newest.set(a.account, a);
      const label = tab === 'Google Ads' ? (r) => `${r.Campaign} / ${r['Ad Group']} / "${r['Search Term']}" (keyword ${r.Keyword}, ${r['Match Type']}) -> ${r['Final URL']}`
        : (r) => `${r.Campaign} / ${r['Ad Set']} / ${r.Ad} -> ${r['Destination URL']}`;
      const waste = rows.filter((r) => { const w = newest.get(r.Account); return w && r['Week Start'] === w.week && r[SPEND[tab]] > 0 && !r[k.results]; })
        .map((r) => `- ${r.Account}, week of ${r['Week Start']}: ${label(r)}: ${pct(r[SPEND[tab]], newest.get(r.Account).spend)} of the account's spend that week, ${r[k.clicks]} ${k.clicks.toLowerCase()}, 0 ${k.results.toLowerCase()}`);
      if (waste.length) lines.push(`${tab}, spent with no ${k.results.toLowerCase()} in the newest week:\n${waste.slice(0, 40).join('\n')}`);
    }
  }
  const table = tables.join('\n\n');
  const head = `Ads export Sheet (K&M, per 07_Marketing_and_Brand/Ads_Export_Spec_for_KM.md), read-only. ${spendSeen
    ? 'Spend is shown only as a share or a week-over-week change; never write a spend amount or a currency figure.'
    : 'This agent does not receive spend columns.'}`;
  return { table, text: [head, table, ...lines].join('\n\n') };
}

function sheetIdFrom(env) {
  const id = cellText((env || {})[ENV]);
  return id || null;
}

// The live read: both tabs, one batchGet, values only (drive.readonly).
async function readSheet(id, drive) {
  const q = Object.keys(TABS).map((t) => `ranges=${encodeURIComponent(`'${t}'!A1:Z`)}`).join('&');
  const vals = await drive.getJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values:batchGet?${q}&majorDimension=ROWS`);
  const out = {};
  Object.keys(TABS).forEach((t, i) => { const v = (vals.valueRanges || [])[i]; if (v) out[t] = v.values || []; });
  return out;
}

module.exports = { ENV, SHEET_ID, TABS, SPEND, FENCE, parseTab, readFenced, sourceText, sheetIdFrom, readSheet, weekStartOk };
