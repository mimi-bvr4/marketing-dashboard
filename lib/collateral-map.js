// ORDER #1688: Katherine's "All Companies - Collateral Map" is the Collateral
// Cadet's list of every material we hand out. One tab per company (IHG,
// DEC + DD, NLP); a section heading row, then one title per row. A title's
// cell may carry a link (the whole cell, part of its text, or a smart chip),
// and that link is where the Cadet goes to read the material.
//
// Read on the Box with the Brain service account, read-only (drive.readonly),
// the same token and client as the competitor sheet (#1668).
'use strict';

const SHEET_ID = '1Wpc2emAH0yr3Q8pO9CWux6GMvkdJI2F63qGY9QsHZIA';
const GRID_FIELDS = 'sheets(properties(title),data(rowData(values(formattedValue,hyperlink,'
  + 'textFormatRuns(format(link(uri))),chipRuns(chip(richLinkProperties(uri)))))))';

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

// A link -> what it points at. Drive ids come from /d/<id>, ?id=<id> or /folders/<id>.
function linkKind(uri) {
  const u = clean(uri);
  if (!u) return { kind: 'none' };
  let url;
  try { url = new URL(u); } catch (e) { return { kind: 'other', uri: u }; }
  const host = url.hostname.toLowerCase();
  if (host === 'docs.google.com' || host === 'drive.google.com') {
    const m = url.pathname.match(/\/d\/([A-Za-z0-9_-]{10,})/) || url.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
    const id = m ? m[1] : url.searchParams.get('id');
    if (!id) return { kind: 'other', uri: u };
    const type = /\/folders\//.test(url.pathname) ? 'folder'
      : /^\/document\//.test(url.pathname) ? 'doc'
        : /^\/spreadsheets\//.test(url.pathname) ? 'sheet'
          : /^\/presentation\//.test(url.pathname) ? 'slides' : 'file';
    return { kind: 'drive', type, id, uri: u };
  }
  if (host === 'canva.com' || host.endsWith('.canva.com') || host === 'canva.link') {
    const m = url.pathname.match(/\/design\/([A-Za-z0-9_-]+)/);
    return { kind: 'canva', id: m ? m[1] : null, uri: u };
  }
  return { kind: 'other', uri: u };
}

// The first link a cell carries: the cell's own, a link on part of its text, or a smart chip.
function cellLink(cell) {
  if (!cell) return null;
  if (cell.hyperlink) return cell.hyperlink;
  for (const r of cell.textFormatRuns || []) if (r.format && r.format.link && r.format.link.uri) return r.format.link.uri;
  for (const r of cell.chipRuns || []) if (r.chip && r.chip.richLinkProperties && r.chip.richLinkProperties.uri) return r.chip.richLinkProperties.uri;
  return null;
}

// tabs: [{ title, rows: [[cell, ...], ...] }] where a cell is the Sheets API
// CellData. The sheet as Katherine keeps it (read 10.13.2026): row 1 holds the
// section headings, one per column ("Venue Guides", "Experiences Guides", ...);
// each title sits below its heading in the same column. Blank spacer columns
// have no heading and are skipped. Returns { materials: [{ company, section,
// title, archived, link }] }, in sheet order (tab, column, row).
function parseMap(tabs) {
  const materials = [];
  for (const tab of tabs || []) {
    const company = clean(tab.title);
    const rows = tab.rows || [];
    const head = (rows[0] || []).map((c) => clean(c && c.formattedValue));
    head.forEach((section, col) => {
      if (!section) return;
      for (const row of rows.slice(1)) {
        const cell = (row || [])[col];
        const title = clean(cell && cell.formattedValue);
        if (!title) continue;
        materials.push({ company, section, title, archived: /\(archived\)/i.test(title), link: linkKind(cellLink(cell)) });
      }
    });
  }
  return { materials };
}

// The counts Katherine asked for: how many titles have a link, to what, and
// which have none.
function summarize(materials) {
  const by = { drive: 0, canva: 0, other: 0, none: 0 };
  const driveTypes = {};
  for (const m of materials) {
    by[m.link.kind] += 1;
    if (m.link.kind === 'drive') driveTypes[m.link.type] = (driveTypes[m.link.type] || 0) + 1;
  }
  return { total: materials.length, linked: materials.length - by.none, by, driveTypes,
    unlinked: materials.filter((m) => m.link.kind === 'none').map((m) => ({ company: m.company, section: m.section, title: m.title })) };
}

// Every tab with its cells and links, through the Sheets API.
async function readMap(drive, id = SHEET_ID) {
  const r = await drive.getJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?includeGridData=true&fields=${encodeURIComponent(GRID_FIELDS)}`);
  return (r.sheets || []).map((s) => ({ title: s.properties.title,
    rows: ((s.data && s.data[0] && s.data[0].rowData) || []).map((rd) => rd.values || []) }));
}

module.exports = { parseMap, summarize, readMap, linkKind, cellLink, SHEET_ID };
