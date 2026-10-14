// ORDER #1717: read an .xlsx workbook's cell VALUES with no new dependency.
// Katherine keeps her Master Marketing Dashboard as an Excel file in Drive, which
// the Sheets API cannot read. An .xlsx is a zip of XML parts; node's zlib inflates
// them. This reads what Excel last saved in each cell (<v>): a formula's cached
// result, never the formula, and never evaluates anything.
'use strict';

const zlib = require('zlib');

const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

// zip bytes -> Map(name -> Buffer), from the central directory.
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not an xlsx: no zip directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('not an xlsx: bad zip entry');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (usize > MAX_ENTRY_BYTES) throw new Error(`refused: ${name} is too large`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, zlib.inflateRawSync(raw));
  }
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e.toLowerCase()];
});
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? unxml(m[1]) : null; };
// Every <t> run in a fragment, joined (rich text splits one string into runs).
const texts = (frag) => [...frag.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

// "AB12" -> [11, 27] (0-based row, column).
function cellIndex(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, c - 1];
}

function readSheetXml(xml, shared) {
  const rows = [];
  for (const m of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const tag = ` ${m[1]}`;
    const body = m[2] || '';
    const at = cellIndex(attr(tag, 'r') || '');
    if (!at) continue;
    const t = attr(tag, 't');
    const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    let val = null;
    if (t === 's') val = v == null ? null : shared[Number(v)];
    else if (t === 'inlineStr') val = texts(body);
    else if (t === 'str' || t === 'e') val = v == null ? null : unxml(v);
    else if (t === 'b') val = v == null ? null : v === '1';
    else if (v != null) { const n = Number(v); val = Number.isFinite(n) ? n : unxml(v); }
    if (val === null || val === '') continue;
    const [r, c] = at;
    (rows[r] = rows[r] || [])[c] = val;
  }
  for (let i = 0; i < rows.length; i += 1) rows[i] = rows[i] || [];
  return rows;
}

// xlsx bytes -> [{ name, rows: [[value, ...], ...] }] in workbook order.
function readWorkbook(buf) {
  const z = readZip(buf);
  const part = (n) => (z.has(n) ? z.get(n).toString('utf8') : null);
  const wb = part('xl/workbook.xml');
  if (!wb) throw new Error('not an xlsx: no workbook');
  const rels = new Map();
  for (const m of (part('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\s[^>]*>/g)) {
    rels.set(attr(` ${m[0]}`, 'Id'), attr(` ${m[0]}`, 'Target'));
  }
  const shared = [...(part('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\s[^>]*>/g)) {
    const tag = ` ${m[0]}`;
    const target = rels.get(attr(tag, 'r:id'));
    if (!target) continue;
    const pathIn = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = part(pathIn);
    if (xml == null) continue;
    sheets.push({ name: attr(tag, 'name'), rows: readSheetXml(xml, shared) });
  }
  return sheets;
}

module.exports = { readWorkbook, readZip, readSheetXml, cellIndex, unxml };
