'use strict';
// ORDER #3622: the Archivist reads Canva designs (read-only), behind
// CADET_CANVA_READ (default OFF). brain@ Canva signs in once through the
// dashboard (PKCE); the Box trades the code, exports each design to PDF, reads
// its text and caches it by design id plus Canva's updated_at.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const C = require('../lib/canva');
const P = require('../lib/canva-pdf');
const S = require('../lib/cadet-search');
const { runOnce } = require('../jobs/cadet_run');

const KATHERINE = 'where is The Estate at Cherokee Dock pricing listed?';
const GUIDE_LINE = 'Pricing for Sunday through Thursday events is lower than for Friday and Saturday events.';

// ------------------------------------------------------------ a PDF like Canva's
// A Type0 font with two-byte glyph ids and a ToUnicode map, the content stream
// FlateDecode'd, the font and page dicts packed into an object stream.
function makePdf(lines, { image = false } = {}) {
  const chars = [...new Set(lines.join(''))];
  const gid = new Map(chars.map((c, k) => [c, k + 3]));
  const hex = (s) => [...s].map((c) => gid.get(c).toString(16).padStart(4, '0')).join('');
  const content = image ? 'q 100 0 0 100 0 0 cm /Im1 Do Q'
    : `BT /F1 12 Tf 50 700 Td ${lines.map((l, k) => `${k ? '0 -14 Td ' : ''}[<${hex(l.slice(0, 10))}> -40 <${hex(l.slice(10))}>] TJ`).join(' ')} ET`;
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
${chars.length} beginbfchar
${chars.map((c) => `<${gid.get(c).toString(16).padStart(4, '0')}> <${c.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\n')}
endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const z = (s) => zlib.deflateSync(Buffer.from(s, 'latin1'));
  const packed = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /AAAA+Inter /Encoding /Identity-H /ToUnicode 5 0 R >>'];
  let header = ''; let body = '';
  packed.forEach((o, k) => { header += `${k + 1} ${body.length} `; body += `${o}\n`; });
  const objstm = z(header + body);
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const stream = (num, dict, data) => Buffer.concat([Buffer.from(`${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
  parts.push(stream(5, '/Filter /FlateDecode', z(cmap)));
  parts.push(stream(6, '/Filter /FlateDecode', z(content)));
  parts.push(stream(7, `/Type /ObjStm /N ${packed.length} /First ${header.length} /Filter /FlateDecode`, objstm));
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}

test('the PDF reader gets the text out of a Canva-shaped PDF (Type0 font, ToUnicode, object stream, Flate)', () => {
  const t = P.pdfText(makePdf(['The Estate at Cherokee Dock', GUIDE_LINE]));
  assert.ok(t.includes('The Estate at Cherokee Dock'), t);
  assert.ok(t.replace(/\s+/g, ' ').includes(GUIDE_LINE.replace(/\s+/g, ' ')) || t.replace(/ /g, '').includes(GUIDE_LINE.replace(/ /g, '')), t);
});

test('a PDF that is a picture of text gives no text, and anything not a PDF gives none', () => {
  assert.strictEqual(P.pdfText(makePdf(['x'], { image: true })), '');
  assert.strictEqual(P.pdfText(Buffer.from('<html>not a pdf</html>')), '');
});

// ------------------------------------------------------------ a fake Canva

function fakeCanva({ designs = {}, denied = [], refresh = 'RT1' } = {}) {
  const calls = [];
  const kc = { 'canva-client-id': 'CID', 'canva-client-secret': 'CSECRET', 'canva-refresh-token': refresh };
  const saved = [];
  let n = 0;
  const json = (status, j) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => j });
  async function fetchImpl(url, opts = {}) {
    const method = opts.method || 'GET';
    calls.push(`${method} ${url}`);
    const u = new URL(url);
    if (u.hostname === 'canva.link') return { status: 302, ok: false, headers: { get: (h) => (h === 'location' ? `https://www.canva.com/design/${u.pathname.slice(1).toUpperCase()}/view` : null) } };
    if (u.hostname === 'export.example') { const id = u.pathname.slice(1, -4); return { status: 200, ok: true, arrayBuffer: async () => designs[id].pdf }; }
    const p = u.pathname.replace('/rest/v1', '');
    if (p === '/oauth/token') {
      assert.strictEqual(method, 'POST');
      assert.strictEqual(opts.headers.Authorization, `Basic ${Buffer.from('CID:CSECRET').toString('base64')}`);
      const b = new URLSearchParams(opts.body);
      calls.push(`token ${b.get('grant_type')}${b.get('code_verifier') ? ' verifier' : ''}`);
      if (b.get('grant_type') === 'refresh_token' && b.get('refresh_token') !== kc['canva-refresh-token']) return json(400, { error: 'invalid_grant' });
      n += 1;
      return json(200, { access_token: `AT${n}`, refresh_token: `RT${n + 1}`, expires_in: 14400 });
    }
    const d = p.match(/^\/designs\/([^/]+)$/);
    if (d) {
      if (denied.includes(d[1])) return json(403, { code: 'permission_denied', message: 'Not allowed to access design' });
      if (!designs[d[1]]) return json(404, { code: 'design_not_found' });
      return json(200, { design: { id: d[1], title: designs[d[1]].title, updated_at: designs[d[1]].updated_at } });
    }
    if (p === '/exports' && method === 'POST') {
      const id = JSON.parse(opts.body).design_id;
      assert.deepStrictEqual(JSON.parse(opts.body).format, { type: 'pdf' });
      if (denied.includes(id)) return json(403, { code: 'permission_denied' });
      return json(200, { job: { id: `J-${id}`, status: 'in_progress' } });
    }
    const e = p.match(/^\/exports\/J-(.+)$/);
    if (e) return json(200, { job: { id: `J-${e[1]}`, status: 'success', urls: [`https://export.example/${e[1]}.pdf`] } });
    return json(404, {});
  }
  return { calls, saved, kc, fetchImpl, secrets: (k) => kc[k] || null, save: (k, v) => { saved.push(k); kc[k] = v; } };
}

const mat = (title, uri, extra = {}) => ({ company: 'IHG', section: 'Venue Guides', title, archived: false, link: { kind: 'canva', id: null, uri }, ...extra });
const nullDrive = { async listPage() { return { files: [] }; }, async getFile() { throw new Error('no'); }, async exportText() { return ''; } };
const noWeb = async (url) => ({ status: 404, url, text: async () => '' });

// ------------------------------------------------------------ the switch

test('CADET_CANVA_READ ships OFF: unset, "", "off" are off; only "on" is on', () => {
  for (const v of [undefined, '', 'off', 'yes', 'true']) assert.strictEqual(C.readOn({ CADET_CANVA_READ: v }), false, String(v));
  assert.strictEqual(C.readOn({ CADET_CANVA_READ: 'on' }), true);
  assert.strictEqual(C.readOn({}), false);
});

test('switch OFF: the search is byte-for-byte #3617\'s (no reader passed)', async () => {
  const mats = [mat('ECD Venue Guide', 'https://canva.link/ecd1')];
  const now = () => new Date('2026-11-19T20:00:00Z');
  const before = await S.search({ phrase: KATHERINE, materials: mats, drive: nullDrive, fetch: noWeb, now });
  const off = await S.search({ phrase: KATHERINE, materials: mats, drive: nullDrive, fetch: noWeb, now, canva: null });
  assert.deepStrictEqual(off, before);
  assert.strictEqual(off.materials[0].why, "a Canva design: the Archivist can't open Canva yet (open it from the Collateral Map Sheet)");
  assert.match(off.tally.summary, /1 material not read: it is a Canva design, and the Archivist can't open Canva yet\./);
});

test('switch ON but brain@ never signed in: the same honest line, and no Canva call at all', async () => {
  const f = fakeCanva({ refresh: null });
  const reader = C.createReader({ fetchImpl: f.fetchImpl, secrets: f.secrets, save: f.save, cache: C.createMemoryCache() });
  const r = await S.search({ phrase: KATHERINE, materials: [mat('ECD Venue Guide', 'https://canva.link/ecd1')], drive: nullDrive, fetch: noWeb, canva: reader });
  assert.strictEqual(r.materials[0].why, "a Canva design: the Archivist can't open Canva yet (open it from the Collateral Map Sheet)");
  assert.strictEqual(r.materials[0].canva, true);
  assert.deepStrictEqual(f.calls, []);
});

// ------------------------------------------------------------ the read

test('Katherine\'s question, switch ON: the ECD venue guide answers with its pricing sentence', async () => {
  const f = fakeCanva({ designs: { ECD1: { title: 'ECD Venue Guide 2026', updated_at: 100, pdf: makePdf(['The Estate at Cherokee Dock', GUIDE_LINE]) } } });
  const reader = C.createReader({ fetchImpl: f.fetchImpl, secrets: f.secrets, save: f.save, cache: C.createMemoryCache(), wait: async () => {} });
  const r = await S.search({ phrase: KATHERINE, materials: [mat('ECD Venue Guide', 'https://canva.link/ecd1')], drive: nullDrive, fetch: noWeb, canva: reader });
  const m = r.materials[0];
  assert.strictEqual(m.status, 'FOUND', JSON.stringify(m));
  assert.strictEqual(m.via, 'canva');
  assert.match(m.files[0].lines[0], /^Pricing for Sunday through Thursday/);
  assert.match(r.tally.answer, /^ECD Venue Guide \(IHG\): Pricing for Sunday/);
  assert.ok(!/not read/.test(r.tally.summary), r.tally.summary);
  // the refresh token rotated and the new one was saved before use
  assert.deepStrictEqual(f.saved, ['canva-refresh-token']);
  assert.strictEqual(f.kc['canva-refresh-token'], 'RT2');
});

test('the cache: an unchanged design is not exported again; a changed one is', async () => {
  const designs = { ECD1: { title: 'g', updated_at: 100, pdf: makePdf(['Old pricing words here.']) } };
  const cache = C.createMemoryCache();
  let clock = 1e12;
  const f = fakeCanva({ designs });
  const mk = () => C.createReader({ fetchImpl: f.fetchImpl, secrets: f.secrets, save: f.save, cache, now: () => clock, wait: async () => {} });
  const m = mat('ECD Venue Guide', 'https://canva.link/ecd1');
  await mk().read(m);
  const exports1 = f.calls.filter((c) => c.startsWith('POST https://api.canva.com/rest/v1/exports')).length;
  assert.strictEqual(exports1, 1);
  // within the hour: the cache answers, Canva is not asked at all
  const n = f.calls.length;
  assert.ok((await mk().read(m)).text);
  assert.strictEqual(f.calls.length, n);
  // after the hour, unchanged: one design GET, no export
  clock += C.CHECK_MS + 1;
  await mk().read(m);
  assert.strictEqual(f.calls.filter((c) => c.startsWith('POST https://api.canva.com/rest/v1/exports')).length, 1);
  // changed in Canva: exported again, new text
  clock += C.CHECK_MS + 1;
  designs.ECD1 = { title: 'g', updated_at: 200, pdf: makePdf(['New pricing words here.']) };
  const r = await mk().read(m);
  assert.strictEqual(f.calls.filter((c) => c.startsWith('POST https://api.canva.com/rest/v1/exports')).length, 2);
  assert.match(r.text, /New pricing/);
});

test('a design brain@ can\'t open is listed by the map\'s title as "brain@ can\'t open this one", never a guessed name', async () => {
  const f = fakeCanva({ denied: ['LOCKED1'] });
  const reader = C.createReader({ fetchImpl: f.fetchImpl, secrets: f.secrets, save: f.save, cache: C.createMemoryCache() });
  const r = await S.search({ phrase: 'pricing', materials: [mat('SWF Bar Menu', 'https://canva.link/locked1')], drive: nullDrive, fetch: noWeb, canva: reader });
  const m = r.materials[0];
  assert.strictEqual(m.status, 'NOT CHECKED');
  assert.strictEqual(m.why, "brain@ can't open this one");
  assert.strictEqual(m.title, 'SWF Bar Menu');
  assert.match(r.tally.summary, /1 Canva design brain@ can't open: SWF Bar Menu\./);
  // the 11 sites (none loaded here) are the only "other places"; the locked design is not counted twice
  assert.match(r.tally.summary, /; 11 other places not checked\./);
});

test('an image-only design stays NOT CHECKED (image-only pages), never NOT FOUND', async () => {
  const f = fakeCanva({ designs: { PIC1: { title: 'p', updated_at: 1, pdf: makePdf(['x'], { image: true }) } } });
  const reader = C.createReader({ fetchImpl: f.fetchImpl, secrets: f.secrets, save: f.save, cache: C.createMemoryCache(), wait: async () => {} });
  const r = await S.search({ phrase: 'pricing', materials: [mat('Photo Card', 'https://canva.link/pic1')], drive: nullDrive, fetch: noWeb, canva: reader });
  assert.strictEqual(r.materials[0].status, 'NOT CHECKED');
  assert.match(r.materials[0].why, /image-only pages/);
});

test('the budget: past it, an unread design says it is next in line (NOT CHECKED), and the Box pass reads oldest first', async () => {
  const designs = {}; const mats = [];
  for (let k = 1; k <= 4; k++) { designs[`D${k}`] = { title: `t${k}`, updated_at: 1, pdf: makePdf([`Guide ${k} pricing.`]) }; mats.push(mat(`Guide ${k}`, `https://canva.link/d${k}`)); }
  const f = fakeCanva({ designs });
  const cache = C.createMemoryCache();
  const reader = C.createReader({ fetchImpl: f.fetchImpl, secrets: f.secrets, save: f.save, cache, budget: 2, wait: async () => {} });
  const r = await S.search({ phrase: 'pricing', materials: mats, drive: nullDrive, fetch: noWeb, canva: reader });
  assert.deepStrictEqual(r.materials.map((m) => m.status), ['FOUND', 'FOUND', 'NOT CHECKED', 'NOT CHECKED']);
  assert.match(r.materials[2].why, /next in line/);
  const pass = C.createReader({ fetchImpl: f.fetchImpl, secrets: f.secrets, save: f.save, cache, budget: 2, wait: async () => {} });
  const p = await pass.prime(mats);
  assert.strictEqual(p.read, 2);
  assert.ok(cache.get('D3') && cache.get('D4'), 'the two never read are read first');
});

test('the Box run: searches read Canva first, then the pass spends what is left', async () => {
  const f = fakeCanva({ designs: { ECD1: { title: 'g', updated_at: 1, pdf: makePdf([GUIDE_LINE]) } } });
  const reader = C.createReader({ fetchImpl: f.fetchImpl, secrets: f.secrets, save: f.save, cache: C.createMemoryCache(), wait: async () => {} });
  const done = [];
  const store = { saveMap: async () => {}, map: async () => ({ materials: [mat('ECD Venue Guide', 'https://canva.link/ecd1')] }),
    takeAsks: async () => [{ id: 1, phrase: KATHERINE, asked_by: 'katherine' }], finishAsk: async (id, x) => done.push(x) };
  const drive = { ...nullDrive, async readMapFails() {} };
  const logs = [];
  await runOnce({ store, drive, fetch: noWeb, log: (l) => logs.push(l), canva: reader });
  assert.strictEqual(done[0].result.materials[0].status, 'FOUND');
  assert.ok(logs.some((l) => /^canva: \d+ design\(s\) checked this run$/.test(l)), logs.join('\n'));
});

// ------------------------------------------------------------ read-only, by construction

test('the Canva client sends GETs plus exactly two POSTs (the login trade and the export); no :write scope anywhere', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'canva.js'), 'utf8');
  assert.ok(!/:write/.test(src), 'a :write scope');
  const methods = [...src.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(methods)].sort(), ['GET', 'POST']);
  const posts = src.split('\n').filter((l) => /method:\s*'POST'/.test(l));
  assert.strictEqual(posts.length, 2, posts.join('\n'));
  assert.ok(posts.some((l) => l.includes('/oauth/token')) && posts.some((l) => l.includes("'/exports'")), posts.join('\n'));
  for (const bad of ['PUT', 'PATCH', 'DELETE']) assert.ok(!new RegExp(`method:\\s*'${bad}'`).test(src), bad);
  assert.strictEqual(C.SCOPES, 'design:meta:read design:content:read');
});

test('no token is ever logged or printed by the Box steps', async () => {
  const f = fakeCanva({ designs: { ECD1: { title: 'g', updated_at: 1, pdf: makePdf([GUIDE_LINE]) } } });
  const logs = [];
  const connects = C.createMemoryConnects();
  await connects.addConnect({ state: C.newState(), who: 'mimi@x', redirectUri: 'https://m/settings/canva/callback', verifier: 'V'.repeat(64) });
  const st = [...connects._connects.keys()][0];
  await connects.setCode(st, 'CODE123');
  assert.strictEqual(await C.tradeCodes({ connects, fetchImpl: f.fetchImpl, secrets: f.secrets, save: f.save, log: (l) => logs.push(l) }), 1);
  assert.ok(f.calls.includes('token authorization_code verifier'), 'the PKCE verifier went with the code');
  const reader = C.createReader({ fetchImpl: f.fetchImpl, secrets: f.secrets, save: f.save, cache: C.createMemoryCache(), log: (l) => logs.push(l), wait: async () => {} });
  await reader.read(mat('g', 'https://canva.link/ecd1'));
  const all = logs.join('\n');
  for (const secret of ['CSECRET', 'RT1', 'RT2', 'RT3', 'AT1', 'AT2', 'CODE123']) assert.ok(!all.includes(secret), secret);
  assert.strictEqual(connects._connects.get(st).code, null, 'the code is wiped');
  assert.strictEqual(connects._connects.get(st).verifier, null, 'the verifier is wiped');
  assert.strictEqual(connects._connects.get(st).outcome, 'connected');
});

// ------------------------------------------------------------ the sign-in link

test('the sign-in link: Canva\'s authorize URL, PKCE S256, read-only scopes, the dashboard callback', () => {
  const v = C.newVerifier();
  assert.ok(v.length >= 43 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v));
  const u = new URL(C.authorizeUrl({ clientId: 'CID', redirectUri: C.redirectUri({}), state: C.newState(), verifier: v }));
  assert.strictEqual(`${u.origin}${u.pathname}`, 'https://www.canva.com/api/oauth/authorize');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 's256');
  assert.strictEqual(u.searchParams.get('code_challenge'), crypto.createHash('sha256').update(v).digest('base64url'));
  assert.strictEqual(u.searchParams.get('scope'), 'design:meta:read design:content:read');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://marketing.infinityhospitalitygroup.com/settings/canva/callback');
  assert.match(u.searchParams.get('state'), /^CANVA\.[0-9a-f]{36}$/);
});

async function withServer(router, who, fn) {
  const app = express();
  app.use((req, res, next) => { if (who) req.mktUser = { email: who }; next(); });
  app.use(router);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('the routes: connect parks a state + verifier and sends the browser to Canva; the callback parks the code; signed-out is refused', async () => {
  const { createCanvaRouter } = require('../routes/canva');
  const connects = C.createMemoryConnects();
  const router = createCanvaRouter({ connects, env: { CANVA_CLIENT_ID: 'CID' } });
  await withServer(router, null, async (base) => {
    assert.strictEqual((await fetch(`${base}/settings/canva/connect`, { redirect: 'manual' })).status, 403);
    assert.strictEqual((await fetch(`${base}/settings/canva/callback?code=x&state=CANVA.${'a'.repeat(36)}`)).status, 403);
  });
  await withServer(router, 'mimi@infinityhospitality.net', async (base) => {
    const r = await fetch(`${base}/settings/canva/connect`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    const to = new URL(r.headers.get('location'));
    assert.strictEqual(to.hostname, 'www.canva.com');
    const state = to.searchParams.get('state');
    const row = connects._connects.get(state);
    assert.ok(row && row.verifier && row.asked_by === 'mimi@infinityhospitality.net');
    assert.strictEqual(to.searchParams.get('code_challenge'), C.challengeOf(row.verifier));
    const cb = await fetch(`${base}/settings/canva/callback?code=THECODE&state=${state}`);
    assert.strictEqual(cb.status, 200);
    assert.match(await cb.text(), /Canva sign-in received/);
    assert.strictEqual(row.code, 'THECODE');
    const again = await fetch(`${base}/settings/canva/callback?code=OTHER&state=${state}`);
    assert.match(await again.text(), /expired/);
    const list = await (await fetch(`${base}/api/canva/connects`)).json();
    assert.ok(!JSON.stringify(list).includes('THECODE') && !JSON.stringify(list).includes(row.verifier || 'zzz'), 'no code or verifier on the status API');
    const bad = await fetch(`${base}/settings/canva/callback?code=x&state=nope`);
    assert.strictEqual(bad.status, 400);
  });
  const notReady = createCanvaRouter({ connects, env: {} });
  await withServer(notReady, 'mimi@infinityhospitality.net', async (base) => {
    assert.strictEqual((await fetch(`${base}/settings/canva/connect`, { redirect: 'manual' })).status, 409);
  });
});
