'use strict';
// ORDER #1717: Katherine's dashboards inside ours.
//   * her .xlsx is read with no new dependency, cached values only
//   * only the Spend / Lead Volume / Tours / Bookings blocks are kept, and no
//     column or tab that names pay ever reaches the payload (iron rule 2)
//   * "Whoops" in the follower sheet is NO reading, never zero
//   * /api/her-numbers is leadership-only and closed to fleet keys (#1370, #1390)
// No network, no real figures from her files: every number below is made up.
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

const { readWorkbook } = require('../lib/xlsx-lite');
const K = require('../lib/katherine-files');
const { runOnce } = require('../jobs/katherine_files');

// ---- a tiny .xlsx writer for fixtures (stored + deflated entries) -----------
function zip(files) {
  const locals = []; const centrals = []; let off = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text, 'utf8');
    const deflate = i % 2 === 1;
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const col = (c) => { let s = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
function xlsx(tabs) {
  const shared = [];
  const sid = (s) => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const files = {};
  tabs.forEach((t, i) => {
    const rows = t.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (v == null) return '';
      const ref = `${col(ci)}${ri + 1}`;
      return typeof v === 'number' ? `<c r="${ref}" s="3"><f>SUM(X1)</f><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${sid(v)}</v></c>`;
    }).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });
  files['xl/workbook.xml'] = `<workbook><sheets>${tabs.map((t, i) => `<sheet name="${t.name.replace(/&/g, '&amp;')}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<Relationships>${tabs.map((t, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] = `<sst>${shared.map((s) => `<si><r><t>${s.slice(0, 2).replace(/&/g, '&amp;')}</t></r><r><t xml:space="preserve">${s.slice(2).replace(/&/g, '&amp;')}</t></r></si>`).join('')}</sst>`;
  return zip(files);
}

const MONTHS = ['Jan 2026', 'Feb 2026', 'Mar 2026'];
const MAIN = [
  ['INFINITY HOSPITALITY GROUP | MASTER MARKETING DASHBOARD | 2026'],
  [],
  [null, 'MARKETING SPEND'],
  ['Month', 'Total Paid Ad Spend', 'Total Mktg Spend (Fully Loaded)', 'TBB Ad Spend', 'Katherine Salary', 'A goal note typed in the header row'],
  ['Jan 2026', 100, 250, 40, 999],
  ['Feb 2026', 110, 260, '-', 999],
  ['Mar 2026', 120, 270, 50, 999],
  ['YTD TOTAL', 330, 780, 90, 2997],
  [],
  ['LEAD VOLUME'],
  ['Month', 'UNIQUE Leads', 'The Knot', 'Google Search', 'TOTAL TBB Leads', 'TOTAL ECD Leads'],
  ['Jan 2026', 30, 10, 20, 12, 18],
  ['Feb 2026', 40, 15, 25, 16, 24],
  ['Mar 2026', 0, 0, 0, 0, 0],
  ['YTD TOTAL', 70, 25, 45, 28, 42],
  [],
  [null, 'TOURS COMPLETED'],
  ['Month', 'Total Tours', 'TBB Tours'],
  ...MONTHS.map((m, i) => [m, i + 1, i]),
  ['YTD TOTAL', 6, 3],
  [],
  [null, 'COST PER LEAD  &  COST PER BOOKING'],
  ['Month', 'CPL (Paid Ads)'],
  ['Jan 2026', 5],
  ['YTD AVERAGES', 5],
];
const SPEND_INPUT = [['IHG MARKETING SPEND INPUT'], ['Month', 'Google Ads (TBB)', 'Katherine Salary', 'Samantha Salary'], ['Jan 2026', 1, 2, 3]];
const workbook = () => xlsx([{ name: 'Main Dashboard (2026)', rows: MAIN }, { name: 'Spend Input (2026)', rows: SPEND_INPUT }, { name: 'Budget (2026)', rows: [['Wages'], ["Katherine's Salary", 1]] }]);

test('the xlsx reader gives back cached cell values, rich-text strings joined, both zip methods', () => {
  const tabs = readWorkbook(workbook());
  assert.deepStrictEqual(tabs.map((t) => t.name), ['Main Dashboard (2026)', 'Spend Input (2026)', 'Budget (2026)']);
  assert.strictEqual(tabs[0].rows[3][1], 'Total Paid Ad Spend');
  assert.strictEqual(tabs[0].rows[4][1], 100);
  assert.strictEqual(tabs[0].rows[5][3], '-');
});

test('Spend, Leads, Tours and Bookings are kept as she has them; other blocks are not', () => {
  const { blocks, tabs } = K.readMasterWorkbook(workbook());
  assert.deepStrictEqual(Object.keys(blocks).sort(), ['leads', 'spend', 'tours']);
  assert.ok(tabs.includes('Spend Input (2026)'), 'the tab list is recorded');
  assert.deepStrictEqual(blocks.spend.columns, ['Total Paid Ad Spend', 'Total Mktg Spend (Fully Loaded)', 'TBB Ad Spend']);
  assert.strictEqual(blocks.spend.months[0].month, '2026-01');
  assert.strictEqual(blocks.spend.months[0].values['Total Paid Ad Spend'], 100);
  assert.strictEqual(blocks.spend.months[1].values['TBB Ad Spend'], null, 'a "-" is no reading, not zero');
  assert.strictEqual(blocks.spend.total['Total Mktg Spend (Fully Loaded)'], 780, 'her total, not a sum we made');
  assert.strictEqual(blocks.leads.months[2].entered, false, 'an all-zero month is "not entered yet"');
  assert.strictEqual(blocks.leads.months[1].values['The Knot'], 15);
});

test('KNOWN-BAD: no salary column, salary tab or pay word ever reaches the stored payload (iron rule 2)', () => {
  const parsed = K.readMasterWorkbook(workbook());
  const json = JSON.stringify(parsed.blocks);
  assert.ok(!/salary|wage/i.test(json), 'no pay header in the kept blocks');
  assert.ok(!json.includes('999') && !json.includes('2997'), 'no salary value in the kept blocks');
  assert.ok(!json.includes('goal note'), 'a header with no numbers under it is not a column');
  for (const h of ['Katherine Salary', 'Total wages', 'Bonus pool', 'Payroll']) assert.ok(K.PAY_WORDS.test(h), h);
});

test('follower cells parse per account; "Whoops" and blank months are no reading, never zero', () => {
  assert.deepStrictEqual(K.parseFollowerCell('IH-3071 TBB- 3,603 ECD-12.1K'), [
    { account: 'IH', followers: 3071, approx: false },
    { account: 'TBB', followers: 3603, approx: false },
    { account: 'ECD', followers: 12100, approx: true },
  ]);
  assert.deepStrictEqual(K.parseFollowerCell('Whoops'), []);
  const f = K.parseFollowers([
    { title: '2026', rows: [['March', 'April', 'May', 'June'], ['IH-10 COR- 1,200', 'Whoops', '', 'IH-12']] },
    { title: 'Notes', rows: [['March'], ['IH-1']] },
  ]);
  assert.deepStrictEqual(f.accounts.sort(), ['COR', 'IH']);
  assert.deepStrictEqual(f.months.map((m) => m.month), ['2026-03', '2026-04', '2026-06']);
  const april = f.months.find((m) => m.month === '2026-04');
  assert.strictEqual(april.missing, true);
  assert.deepStrictEqual(april.readings, {}, 'no zero is stored for a Whoops month');
  assert.strictEqual(f.months[0].readings.COR.followers, 1200);
});

test('the nightly job writes both reads, keeps the last good read when a file fails, and never writes to Drive', async () => {
  const puts = []; const calls = [];
  const store = { put: async (s, v) => puts.push([s, v]) };
  const drive = {
    downloadXlsx: async (id) => { calls.push(['xlsx', id]); return { file: { name: 'Master Marketing Dashboard.xlsx', modifiedTime: '2026-10-13T19:01:39Z' }, bytes: workbook() }; },
    getFile: async () => ({ name: 'IG Monthly Follower Counts', modifiedTime: '2026-10-02T02:08:59Z' }),
    getJson: async (url) => { calls.push(['get', url]); return /values:batchGet/.test(url) ? { valueRanges: [{ values: [['March'], ['IH-10']] }] } : { sheets: [{ properties: { title: '2026' } }] }; },
  };
  const log = [];
  assert.strictEqual(await runOnce({ store, drive, log: (l) => log.push(l) }), 0);
  assert.deepStrictEqual(puts.map((p) => p[0]), ['master', 'followers']);
  assert.deepStrictEqual(calls.filter(([k]) => k === 'xlsx'), [['xlsx', K.MASTER_XLSX_ID]]);
  assert.ok(calls.filter(([k]) => k === 'get').every(([, u]) => /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[^/]+(\?|\/values:batchGet\?)/.test(u)));
  const broken = { ...drive, downloadXlsx: async () => { throw new Error('Drive 404'); } };
  puts.length = 0;
  assert.strictEqual(await runOnce({ store, drive: broken, log: (l) => log.push(l) }), 1);
  assert.deepStrictEqual(puts.map((p) => p[0]), ['followers'], 'a failed read writes nothing over the last good one');
  assert.ok(log.some((l) => /master: NOT READ \(Drive 404\)/.test(l)));
});

test('downloadXlsx refuses anything that is not an .xlsx, and only ever GETs', async () => {
  const { createDriveClient } = require('../lib/drive-client');
  const crypto = require('node:crypto');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const methods = [];
  let mime = 'application/vnd.google-apps.spreadsheet';
  const fetchImpl = async (url, opts) => {
    methods.push([opts.method, url]);
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    if (url.includes('alt=media')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    return { ok: true, json: async () => ({ id: 'x', name: 'f', mimeType: mime, size: '10' }) };
  };
  const c = createDriveClient({ key: { client_email: 'sa@test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, fetchImpl });
  await assert.rejects(c.downloadXlsx('x'), /not an \.xlsx/);
  assert.ok(!methods.some(([, u]) => u.includes('alt=media')), 'a Google Sheet is never downloaded');
  mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const got = await c.downloadXlsx('x');
  assert.strictEqual(got.bytes.length, 4);
  assert.ok(methods.filter(([, u]) => !u.includes('oauth2')).every(([m]) => m === 'GET'));
});

// ---- the route: leadership only, closed to fleet keys -----------------------
process.env.JWT_SECRET = 'marketing-test-secret-not-real';
process.env.DISPATCH_JWT_SECRET = 'dispatch-test-secret-not-real';
process.env.DISPATCH_BRIDGE_TOKEN = 'test-only-bridge-token';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
delete process.env.DATABASE_URL;
const { sha256 } = require('../lib/fleet-tokens');
const GOOD_KEY = 'mkt_test-only-good-key';
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  pool: { query: async (sql, p) => ({ rows: /^SELECT/i.test(sql) && p[0] === sha256(GOOD_KEY) ? [{ id: 1, label: 'ARC', user_id: 't', revoked_at: null }] : [] }) },
  hasDb: () => true, ensureTables: async () => {} } };
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ active: true, person_id: 'person_exec0001', rung: 3, bundle: 'Exec' }) });
const { fleetGate } = require('../middleware/auth');
const { pageGate } = require('../middleware/page-gate');
const { createKatherineRouter } = require('../routes/katherine');

const MARKER = 'HER-NUMBERS-STAND-IN';
function serve(t) {
  const a = express();
  a.use(fleetGate); a.use(pageGate);
  a.use(createKatherineRouter({ store: { get: async (s) => (s === 'master'
    ? { source_name: 'm.xlsx', source_modified: null, read_at: new Date(), payload: { blocks: { spend: { title: MARKER } } } }
    : null) } }));
  return new Promise((resolve) => { const s = http.createServer(a).listen(0, '127.0.0.1', () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
}
function call(s, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.address().port, path: p, method: 'GET', headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); req.end();
  });
}
const execCookie = () => ({ cookie: 'mkt_session=' + encodeURIComponent(jwt.sign(
  { role: 'sso', email: 'exec@infinityhospitality.net', mkt_access: true }, process.env.JWT_SECRET, { expiresIn: '30d' })) });

test('KNOWN-BAD: a fleet key gets no spend from /api/her-numbers (#1390 allow list)', async (t) => {
  const s = await serve(t);
  const r = await call(s, '/api/her-numbers', { authorization: 'Bearer ' + GOOD_KEY });
  assert.strictEqual(r.status, 403);
  assert.ok(!r.body.includes(MARKER));
  const anon = await call(s, '/api/her-numbers');
  assert.notStrictEqual(anon.status, 200);
  assert.ok(!anon.body.includes(MARKER));
});

test('an exec session reads her numbers, with her Looker reports linked', async (t) => {
  const s = await serve(t);
  const r = await call(s, '/api/her-numbers', execCookie());
  assert.strictEqual(r.status, 200);
  const d = JSON.parse(r.body);
  assert.strictEqual(d.master.blocks.spend.title, MARKER);
  assert.strictEqual(d.followers, null, 'not read yet is null, never an empty zero table');
  assert.strictEqual(d.looker.length, 3);
  assert.ok(d.looker.every((l) => /^https:\/\/lookerstudio\.google\.com\/reporting\//.test(l.url)));
});
