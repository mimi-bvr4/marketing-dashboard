// ORDER #1668: Katherine's "IHG Competitors" Google Sheet is the Scout's watch
// list. One tab per brand ("TBB - Competitors", "DEC - Competitors", ...), a
// Name (or Competitor) column and a URL column; optional Notes and Top columns.
// A row with a name and no URL starts a segment ("Corporate Focused").
//
// Mimi's rulings 10.12.2026:
//   - "Top" = listed on 3 or more tabs, or marked Y in a Top column. Top
//     competitors get a full profile, refreshed weekly.
//   - Our own venues on the sheet are skipped (and named, so she can tidy it).
//
// Read on the Box with the Brain service account, read-only (drive.readonly).
'use strict';

const { checkSite } = require('./agent-watch');

const SHEET_ID = '1YwAO3vGGI4W0Zx3bNmc6wXBQCs7T5NMvGMYW96JtreE';
const TOP_TABS = 3;
// Our own sites: never a competitor.
const OUR_SITES = new Set([
  'infinityhospitalitygroup.com', 'dreameventsandcatering.com', 'dailydishcatering.com', 'thebridgebuilding.com',
  'thebelltower.com', 'cherokeedock.com', 'saddlewoodsfarm.com', 'nashvilleeventbartending.com', 'thecordelle.com',
  'thesaintelle.com', 'estellenashville.com', 'nashvilleweddingvenue.com',
]);

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const yes = (v) => /^(y|yes|x|top|true|1)$/i.test(clean(v));

// "TBB - Competitors" -> "TBB"; anything else -> the whole title.
function brandOf(title) {
  const m = clean(title).match(/^([A-Za-z0-9]+)\s*[-–]\s*competitors?$/i);
  return m ? m[1].toUpperCase() : clean(title);
}

// tabs: [{ title, rows: [[cell, ...], ...] }] -> { competitors, ours, skipped }
function parseSheet(tabs) {
  const by = new Map();
  const ours = new Set();
  const skipped = [];
  for (const tab of tabs || []) {
    const rows = tab.rows || [];
    const hi = rows.findIndex((r) => (r || []).some((c) => /^url$/i.test(clean(c))));
    if (hi < 0) continue;
    const head = rows[hi].map((c) => clean(c).toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const cName = col(/^(name|competitor)$/); const cUrl = col(/^url$/); const cNotes = col(/^notes?$/); const cTop = col(/^top/);
    if (cName < 0 || cUrl < 0) continue;
    const brand = brandOf(tab.title);
    let segment = null;
    for (const r of rows.slice(hi + 1)) {
      const name = clean(r[cName]); const url = clean(r[cUrl]);
      if (!name && !url) continue;
      if (name && !url) { segment = name; continue; }
      const s = checkSite(url);
      if (s.error) { skipped.push({ brand, name, url, why: 'no usable website' }); continue; }
      if (OUR_SITES.has(s.site)) { ours.add(`${name} (${s.site})`); continue; }
      let c = by.get(s.site);
      if (!c) { c = { site: s.site, name, brands: [], segments: [], notes: [], marked_top: false }; by.set(s.site, c); }
      if (!c.brands.includes(brand)) c.brands.push(brand);
      if (segment && !c.segments.includes(segment)) c.segments.push(segment);
      const n = cNotes >= 0 ? clean(r[cNotes]) : '';
      if (n && !c.notes.includes(n)) c.notes.push(n);
      if (cTop >= 0 && yes(r[cTop])) c.marked_top = true;
    }
  }
  const competitors = [...by.values()].map((c) => ({ ...c, top: c.marked_top || c.brands.length >= TOP_TABS }))
    .sort((a, b) => (b.top - a.top) || (b.brands.length - a.brands.length) || a.name.localeCompare(b.name));
  return { competitors, ours: [...ours], skipped };
}

// Every tab's values through the Sheets API, with the read-only Drive token.
async function readSheet(drive, id = SHEET_ID) {
  const meta = await drive.getJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=sheets.properties.title`);
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  if (!titles.length) return [];
  const q = titles.map((t) => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "''")}'!A1:Z200`)}`).join('&');
  const vals = await drive.getJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values:batchGet?${q}`);
  return (vals.valueRanges || []).map((v, i) => ({ title: titles[i], rows: v.values || [] }));
}

module.exports = { parseSheet, readSheet, brandOf, SHEET_ID, OUR_SITES, TOP_TABS };
