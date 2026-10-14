// ORDER #1717 (Mimi, 10.13.2026: "her current marketing dashboards ... we need to
// integrate all of these into ours"). Katherine keeps typing into her own files;
// the Box reads them every night and the dashboard shows what she has.
//
// 🔴 THE LAWS THIS FILE CARRIES:
//   1. Read-only. Her files are read with the Box service account's drive.readonly
//      token (lib/drive-client.js). Nothing here can write to Drive.
//   2. Numbers are shown AS SHE HAS THEM: the cached values Excel saved, never
//      recomputed. A "-" or a blank is no reading, not zero.
//   3. Compensation never enters (iron rule 2). Only the Main Dashboard tab's
//      Spend, Lead Volume, Tours and Bookings blocks are kept. The "Spend Input"
//      and "Budget" tabs, which carry named salaries, are never read. Any column
//      whose header names pay is dropped even inside a kept block.
//   4. Instagram followers: "Whoops" (or a blank month) is NO reading, never zero.
'use strict';

const { readWorkbook } = require('./xlsx-lite');

const MASTER_XLSX_ID = '1LUGAor0cXa-rrxiSx5L15v0WWvJvOo9i';
const FOLLOWERS_SHEET_ID = '1u2u4yQ1YnYdDFQtCelk14hzmesXiZ39NcUufzw6ajho';
const MAIN_TAB = /^main dashboard/i;
const KEEP_BLOCKS = { 'MARKETING SPEND': 'spend', 'LEAD VOLUME': 'leads', 'TOURS COMPLETED': 'tours', BOOKINGS: 'bookings' };
const PAY_WORDS = /salary|salaries|wage|payroll|bonus|compensation|commission/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

// "Jan 2026" / "January" (+ a year) -> "2026-01"; anything else -> null.
function monthKey(label, year) {
  const m = clean(label).toLowerCase().match(/^([a-z]{3})[a-z]*\.?\s*(\d{4})?$/);
  if (!m) return null;
  const i = MONTHS.indexOf(m[1]);
  const y = m[2] || year;
  return i < 0 || !y ? null : `${y}-${String(i + 1).padStart(2, '0')}`;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Main Dashboard rows -> { spend, leads, tours, bookings }, each
// { title, columns, months: [{ month, values, entered }], total }.
function parseMasterDashboard(rows) {
  const out = {};
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || [];
    if (clean(r[0]).toLowerCase() !== 'month') continue;
    // The block's title is the nearest non-empty text above its header row.
    let title = '';
    for (let k = i - 1; k >= 0 && !title; k -= 1) title = clean((rows[k] || []).find((c) => clean(c)));
    const key = KEEP_BLOCKS[title.toUpperCase()];
    if (!key || out[key]) continue;
    const cols = [];
    for (let c = 1; c < r.length; c += 1) {
      const h = clean(r[c]);
      if (h && !PAY_WORDS.test(h)) cols.push({ c, h });
    }
    const block = { title, columns: cols.map((x) => x.h), months: [], total: null };
    for (let j = i + 1; j < rows.length; j += 1) {
      const row = rows[j] || [];
      const label = clean(row[0]);
      if (!label) break;
      const values = {};
      for (const { c, h } of cols) values[h] = num(row[c]);
      if (/^ytd/i.test(label)) { block.total = values; break; }
      const month = monthKey(label);
      if (!month) break;
      // A month she has not filled in yet carries zeros or blanks in every column.
      const entered = Object.values(values).some((v) => v !== null && v !== 0);
      block.months.push({ month, values, entered });
    }
    // A header with no number under it is a note typed into the header row (her
    // Spend block carries the revenue goals that way), not a column.
    const rowsOf = [...block.months.map((m) => m.values), block.total || {}];
    block.columns = block.columns.filter((h) => rowsOf.some((v) => v[h] != null));
    const keep = new Set(block.columns);
    for (const v of rowsOf) for (const h of Object.keys(v)) if (!keep.has(h)) delete v[h];
    out[key] = block;
  }
  return out;
}

function readMasterWorkbook(bytes) {
  const tabs = readWorkbook(bytes);
  const main = tabs.find((t) => MAIN_TAB.test(clean(t.name)));
  if (!main) throw new Error('no "Main Dashboard" tab in the workbook');
  return { tabs: tabs.map((t) => t.name), blocks: parseMasterDashboard(main.rows) };
}

// "IH-3071 TBB- 3,603 ECD-12.1K" -> [{ account, followers, approx }].
function parseFollowerCell(text) {
  const t = clean(text);
  if (!t || /^whoops/i.test(t)) return [];
  const out = [];
  for (const m of t.matchAll(/\b([A-Z]{2,4})\s*-\s*([\d][\d,]*(?:\.\d+)?)\s*([kK])?(?![\d])/g)) {
    const n = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    out.push({ account: m[1], followers: m[3] ? Math.round(n * 1000) : n, approx: !!m[3] });
  }
  return out;
}

// tabs: [{ title: "2026", rows }] -> { accounts, months: [{ month, readings: {ACC: {followers, approx}}, missing }] }
function parseFollowers(tabs) {
  const months = [];
  const accounts = new Set();
  for (const tab of tabs || []) {
    const year = (clean(tab.title).match(/^(\d{4})$/) || [])[1];
    if (!year) continue;
    const head = (tab.rows || [])[0] || [];
    const body = (tab.rows || [])[1] || [];
    head.forEach((h, c) => {
      const month = monthKey(h, year);
      if (!month) return;
      const raw = clean(body[c]);
      const readings = {};
      for (const x of parseFollowerCell(raw)) { readings[x.account] = { followers: x.followers, approx: x.approx }; accounts.add(x.account); }
      const missing = !Object.keys(readings).length;
      if (missing && !raw) return; // a month still to come
      months.push({ month, readings, missing, note: missing ? raw : undefined });
    });
  }
  months.sort((a, b) => a.month.localeCompare(b.month));
  return { accounts: [...accounts], months };
}

async function readFollowerSheet(drive, id = FOLLOWERS_SHEET_ID) {
  const meta = await drive.getJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=sheets.properties.title`);
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  if (!titles.length) return [];
  const q = titles.map((t) => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "''")}'!A1:Z5`)}`).join('&');
  const vals = await drive.getJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values:batchGet?${q}`);
  return (vals.valueRanges || []).map((v, i) => ({ title: titles[i], rows: v.values || [] }));
}

// Her three Looker Studio reports. Linked from the page until each chart is
// rebuilt natively (GA4) or its data flows (ads export, #1011 Amd C / #1701).
const LOOKER_REPORTS = [
  { key: 'websites', name: 'All Companies Website Analytics Dashboard', url: 'https://lookerstudio.google.com/reporting/0aef6b8c-904b-4252-a2cd-7e224f5225a9' },
  { key: 'ihg-ads', name: 'IHG Venues Ads Analytics Dashboard', url: 'https://lookerstudio.google.com/reporting/45cc97d8-5dbb-45f9-adf7-7cad40bf7f65' },
  { key: 'dec-dd-ads', name: 'DEC/DD Ads Analytics Dashboard', url: 'https://lookerstudio.google.com/reporting/f02e73ba-3865-4af9-b519-2a940154b36b' },
];

module.exports = {
  MASTER_XLSX_ID, FOLLOWERS_SHEET_ID, LOOKER_REPORTS, PAY_WORDS,
  monthKey, parseMasterDashboard, readMasterWorkbook, parseFollowerCell, parseFollowers, readFollowerSheet,
};
