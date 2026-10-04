// ORDER #1241 step 3: #1007's DEALID sheet rule, ported from planning
// server/lib/marketing_sheet.js (on planning main). Katherine's "[NEW] Event
// Master List - Marketing" sheet is the place of record for whether a client is
// cool with photo use.
//
// Ported, not required: planning is a different repo and service. What came
// across is the part the photo page needs, unchanged in behaviour:
//   * headers are matched by NORMALIZED TEXT, never by position
//   * the header row is the one carrying "Event Name"; month rows are skipped
//   * two columns that read as the same field: neither is used
//   * a row is found by its DEALID cell and NOTHING ELSE. No name joins.
//   * a DEALID on two rows is refused, never picked
//
// Out: { rowsByDealId, refused } where each row is keyed by its own header
// text, which is the shape photo-archive.rightsFor reads.
'use strict';

function normHeader(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase().replace(/\?+$/, '').trim();
}

const DEAL_ID_HEADERS = ['dealid', 'deal id'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const isBlank = (v) => v == null || String(v).trim() === '';
const isMonth = (v) => MONTHS.includes(String(v == null ? '' : v).trim().toLowerCase());

// One tab, as the Sheets API returns it (rows of strings).
function parseTab(values) {
  const rows = values || [];
  const headerIndex = rows.findIndex((r) => (r || []).some((c) => normHeader(c) === 'event name'));
  if (headerIndex === -1) return { ok: false, reason: 'no "Event Name" header row on this tab' };
  const header = rows[headerIndex];
  const columns = [];
  const dealCols = [];
  header.forEach((raw, index) => {
    const n = normHeader(raw);
    if (!n) return;                                      // spacer column
    columns.push({ index, header: String(raw).replace(/\s+/g, ' ').trim() });
    if (DEAL_ID_HEADERS.includes(n)) dealCols.push(index);
  });
  if (dealCols.length !== 1) {
    return { ok: false, reason: dealCols.length ? 'two columns read as DEALID; neither is used' : 'this tab has no DEALID column' };
  }
  const events = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const filled = r.filter((c) => !isBlank(c));
    if (!filled.length) continue;
    if (filled.length === 1 && isMonth(filled[0])) continue;
    events.push({ rowNumber: i + 1, cells: r });
  }
  return { ok: true, columns, dealCol: dealCols[0], events };
}

// Every tab together. A DEALID found on more than one row, on one tab or across
// two, is refused for all of them: the page will not pick which one Katherine meant.
function rowsByDealId(tabs) {
  const hits = new Map();
  const refused = [];
  for (const { title, values } of tabs || []) {
    const tab = parseTab(values);
    if (!tab.ok) { refused.push({ tab: title, reason: tab.reason }); continue; }
    for (const e of tab.events) {
      const id = String(e.cells[tab.dealCol] == null ? '' : e.cells[tab.dealCol]).trim();
      if (!id) continue;
      const row = {};
      for (const c of tab.columns) row[c.header] = isBlank(e.cells[c.index]) ? '' : String(e.cells[c.index]);
      (hits.get(id) || hits.set(id, []).get(id)).push({ tab: title, rowNumber: e.rowNumber, row });
    }
  }
  const out = {};
  for (const [id, list] of hits) {
    if (list.length > 1) refused.push({ deal_id: id, reason: `deal ${id} is on ${list.length} rows; not picked` });
    else out[id] = list[0].row;
  }
  return { rowsByDealId: out, refused };
}

module.exports = { normHeader, parseTab, rowsByDealId };
