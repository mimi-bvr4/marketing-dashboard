'use strict';
// ORDER #1688: the Collateral Cadet, step 1. Reads Katherine's Collateral Map
// with each cell's link, answers "where does this phrase appear?" across the
// materials and our 11 websites (anything unread is NOT CHECKED, never clean),
// and fills a Dispatch Change Log entry for Katherine to post. Read-only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const { pageGate } = require('../middleware/page-gate');
const M = require('../lib/collateral-map');
const C = require('../lib/cadet-search');
const { createMemoryStore } = require('../lib/cadet-store');
const { createCadetRouter, changeLogUrl } = require('../routes/cadet');
const { runOnce } = require('../jobs/cadet_run');
const { createAgentsRouter } = require('../routes/agents');
const { createMemoryStore: createAgentStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { loadAgent } = require('../lib/agent-runner');

const EM = String.fromCharCode(0x2014);
const K = 'khowe@infinityhospitality.net';

function serve(a, t) {
  return new Promise((resolve) => { const s = http.createServer(a).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
}
function call(server, urlPath, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
const as = (email) => ({ Cookie: `mkt_session=${jwt.sign({ role: 'sso', email, mkt_access: true }, process.env.JWT_SECRET)}` });

// The sheet as the Sheets API returns it: row 1 the section headings, titles below.
const cell = (v, extra = {}) => ({ formattedValue: v, ...extra });
const TABS = [
  { title: 'IHG', rows: [
    [cell('Venue Guides'), cell(''), cell('Misc. Sales')],
    [cell('TBB Venue Guide', { hyperlink: 'https://docs.google.com/document/d/DOC_TBB_0001/edit' }), {}, cell('IHG Rental Catalog', { textFormatRuns: [{ format: { link: { uri: 'https://drive.google.com/file/d/PDF_RENT_001/view' } } }] })],
    [cell('TBT Venue Guide', { chipRuns: [{ chip: { richLinkProperties: { uri: 'https://www.canva.com/design/DAF123abc/edit' } } }] }), {}, cell('Corporate Branding Lookbook (Archived)')],
    [cell('SWF Venue Guide')],
  ] },
  { title: 'NLP', rows: [[cell('Misc. Sales')], [cell('NLP Audio Package Flyer')]] },
];

// A Drive the Brain can see: two Google files, one PDF Drive has indexed, one it has not.
function fakeDrive({ index = ['PDF_RENT_001'], indexFails = false } = {}) {
  const files = {
    DOC_TBB_0001: { id: 'DOC_TBB_0001', name: 'TBB Venue Guide', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/DOC_TBB_0001' },
    PDF_RENT_001: { id: 'PDF_RENT_001', name: 'IHG Rental Catalog.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/PDF_RENT_001' },
    SLD_SWF_0001: { id: 'SLD_SWF_0001', name: 'SWF Venue Guide', mimeType: 'application/vnd.google-apps.presentation', webViewLink: 'https://docs.google.com/presentation/d/SLD_SWF_0001' },
  };
  const text = {
    DOC_TBB_0001: 'Bar packages\nOur signature toast is a glass of Sparkling White Wine for every guest.\nCapacity 300 seated.',
    SLD_SWF_0001: 'Saddle Woods Farm\nThe barn seats 250.',
  };
  const calls = [];
  return {
    calls,
    async getJson(url) { calls.push(['getJson', url]); if (!/^https:\/\/sheets\.googleapis\.com\//.test(url)) throw new Error('refused'); return { sheets: TABS.map((t) => ({ properties: { title: t.title }, data: [{ rowData: t.rows.map((r) => ({ values: r })) }] })) }; },
    async getFile(id) { calls.push(['getFile', id]); if (!files[id]) throw new Error('Drive 404: File not found'); return files[id]; },
    async exportText(id, mime) { calls.push(['export', id, mime]); return text[id]; },
    async listPage(p) {
      calls.push(['list', p.q]);
      if (/^fullText/.test(p.q)) { if (indexFails) throw new Error('Drive 403'); return { files: index.map((id) => ({ id })) }; }
      const m = p.q.match(/^name = '(.+?)' and/);
      return { files: Object.values(files).filter((f) => m && f.name === m[1].replace(/\\'/g, "'")) };
    },
  };
}

// Our 11 sites: WordPress search JSON + pages, Squarespace sitemaps + pages.
function fakeWeb({ down = [] } = {}) {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    const u = new URL(url);
    const host = u.hostname;
    const res = (status, body) => ({ status, url, text: async () => body });
    if (down.includes(host)) return res(503, '');
    if (u.pathname === '/wp-json/wp/v2/search') {
      return res(200, host === 'thebridgebuilding.com' ? JSON.stringify([{ url: 'https://thebridgebuilding.com/bar/', title: 'Bar', subtype: 'page' }, { url: 'https://thebridgebuilding.com/old/', title: 'Old', subtype: 'post' }]) : '[]');
    }
    if (url === 'https://thebridgebuilding.com/bar/') return res(200, '<html><title>Bar &amp; Drinks</title><body><p>Toast with sparkling white wine &amp; berries.</p></body></html>');
    if (url === 'https://thebridgebuilding.com/old/') return res(200, '<html><title>Old</title><body><p>Wine, white and sparkling, in a list.</p></body></html>');
    if (u.pathname === '/sitemap.xml') return res(200, `<urlset><url><loc>https://${host}/</loc></url><url><loc>https://${host}/faqs</loc></url></urlset>`);
    if (host === 'thecordelle.com' && u.pathname === '/faqs') return res(200, '<html><title>FAQs</title><body>Yes! We pour Sparkling White Wine at every wedding.</body></html>');
    return res(200, '<html><title>Home</title><body>Welcome.</body></html>');
  };
  return { fetch, seen };
}

test('the map: row 1 is the sections, titles below; links from the cell, part of its text, or a chip', () => {
  const { materials } = M.parseMap(TABS);
  assert.deepStrictEqual(materials.map((m) => `${m.company}|${m.section}|${m.title}`), [
    'IHG|Venue Guides|TBB Venue Guide', 'IHG|Venue Guides|TBT Venue Guide', 'IHG|Venue Guides|SWF Venue Guide',
    'IHG|Misc. Sales|IHG Rental Catalog', 'IHG|Misc. Sales|Corporate Branding Lookbook (Archived)', 'NLP|Misc. Sales|NLP Audio Package Flyer']);
  const by = Object.fromEntries(materials.map((m) => [m.title, m.link]));
  assert.deepStrictEqual(by['TBB Venue Guide'], { kind: 'drive', type: 'doc', id: 'DOC_TBB_0001', uri: 'https://docs.google.com/document/d/DOC_TBB_0001/edit' });
  assert.strictEqual(by['IHG Rental Catalog'].id, 'PDF_RENT_001');
  assert.strictEqual(by['TBT Venue Guide'].kind, 'canva');
  assert.strictEqual(by['SWF Venue Guide'].kind, 'none');
  assert.ok(materials.find((m) => m.title.includes('Lookbook')).archived);
  const s = M.summarize(materials);
  assert.deepStrictEqual({ total: s.total, linked: s.linked, by: s.by }, { total: 6, linked: 3, by: { drive: 2, canva: 1, other: 0, none: 3 } });
  assert.deepStrictEqual(s.unlinked.map((u) => u.title), ['SWF Venue Guide', 'Corporate Branding Lookbook (Archived)', 'NLP Audio Package Flyer']);
});

test('link kinds: folders, ?id= links, Canva and anything else', () => {
  assert.strictEqual(M.linkKind('https://drive.google.com/drive/folders/FOLDER_ABCDEF12').type, 'folder');
  assert.strictEqual(M.linkKind('https://drive.google.com/open?id=FILE_ABCDEF1234').id, 'FILE_ABCDEF1234');
  assert.strictEqual(M.linkKind('https://docs.google.com/presentation/d/SLIDES_ABCDEF12/edit').type, 'slides');
  assert.strictEqual(M.linkKind('https://canva.link/xyz').kind, 'canva');
  assert.strictEqual(M.linkKind('https://example.com/menu.pdf').kind, 'other');
  assert.strictEqual(M.linkKind('').kind, 'none');
});

test('phrase lines: any case, smart quotes, long lines cut around the phrase; entities decoded', () => {
  assert.deepStrictEqual(C.findLines('A glass of Sparkling White Wine.\nNothing here.', 'sparkling white wine'), { lines: ['A glass of Sparkling White Wine.'], count: 1 });
  assert.strictEqual(C.findLines('We’re pouring prosecco', "we're pouring").count, 1);
  const long = `${'x'.repeat(400)} sparkling white wine ${'y'.repeat(400)}`;
  const [q] = C.findLines(long, 'sparkling white wine').lines;
  assert.ok(q.length <= 230 && q.includes('sparkling white wine') && q.startsWith('...') && q.endsWith('...'));
  assert.deepStrictEqual(C.findLines('nothing', 'wine'), { lines: [], count: 0 });
  const many = C.findLines(Array.from({ length: 8 }, (_, i) => `Line ${i} has wine.`).join('\n'), 'wine');
  assert.deepStrictEqual([many.lines.length, many.count], [5, 8]);
  assert.strictEqual(C.decode('Bar &amp; Drinks &mdash; &#8212; &rsquo;'), "Bar & Drinks - - '");
  assert.strictEqual(C.findLines(C.decode('We&#8217;re pouring'), "we're pouring").count, 1);
  assert.ok(C.checkPhrase(' ').error);
  assert.ok(C.checkPhrase('x'.repeat(121)).error);
  assert.strictEqual(C.checkPhrase('  sparkling   white wine ').phrase, 'sparkling white wine');
});

test('materials: Google files read and quoted; PDF found only by the index; Canva, unshared and unread are NOT CHECKED, never clean', async () => {
  const { materials } = M.parseMap(TABS);
  const drive = fakeDrive();
  const out = await C.searchMaterials(materials, 'sparkling white wine', drive);
  const by = Object.fromEntries(out.map((m) => [m.title, m]));
  assert.strictEqual(by['TBB Venue Guide'].status, 'FOUND');
  assert.deepStrictEqual(by['TBB Venue Guide'].files[0].lines, ['Our signature toast is a glass of Sparkling White Wine for every guest.']);
  assert.strictEqual(by['IHG Rental Catalog'].status, 'FOUND');
  assert.match(by['IHG Rental Catalog'].files[0].why, /text index matched/);
  assert.strictEqual(by['TBT Venue Guide'].status, 'NOT CHECKED');
  assert.match(by['TBT Venue Guide'].why, /Canva/);
  assert.strictEqual(by['SWF Venue Guide'].status, 'NOT FOUND', 'a Slides file found by its exact name was read');
  assert.strictEqual(by['SWF Venue Guide'].via, 'name');
  assert.strictEqual(by['NLP Audio Package Flyer'].status, 'NOT CHECKED');
  assert.match(by['NLP Audio Package Flyer'].why, /no link on the Collateral Map, and no file with this exact name/);
  // A PDF Drive's index does not match is not proof it is clean.
  const noIdx = await C.searchMaterials(materials, 'sparkling white wine', fakeDrive({ index: [] }));
  assert.strictEqual(noIdx.find((m) => m.title === 'IHG Rental Catalog').status, 'NOT CHECKED');
  const idxDown = await C.searchMaterials(materials, 'sparkling white wine', fakeDrive({ indexFails: true }));
  assert.match(idxDown.find((m) => m.title === 'IHG Rental Catalog').files[0].why, /could not be asked/);
  // An unshared link and no Drive at all.
  const gone = await C.searchMaterials([{ company: 'IHG', section: 'S', title: 'Gone', link: M.linkKind('https://docs.google.com/document/d/NOT_SHARED_01/edit') }], 'x y', drive);
  assert.strictEqual(gone[0].status, 'NOT CHECKED');
  assert.match(gone[0].why, /not shared with the Brain/);
  const none = await C.searchMaterials(materials, 'wine', null);
  assert.ok(none.every((m) => m.status === 'NOT CHECKED'));
  // Read-only: Drive was only read.
  assert.ok(drive.calls.every(([k]) => ['getJson', 'getFile', 'export', 'list'].includes(k)));
});

test('websites: all 11 asked; WordPress hits must hold the exact phrase; a site that does not answer is NOT CHECKED', async () => {
  const web = fakeWeb({ down: ['saddlewoodsfarm.com'] });
  const sites = await C.searchSites('sparkling white wine', { fetch: web.fetch });
  assert.strictEqual(sites.length, 11);
  const by = Object.fromEntries(sites.map((s) => [s.site, s]));
  assert.strictEqual(by['thebridgebuilding.com'].status, 'FOUND');
  assert.deepStrictEqual(by['thebridgebuilding.com'].pages.map((p) => [p.page, p.title, p.lines[0]]), [['/bar/', 'Bar & Drinks', 'Toast with sparkling white wine & berries.']]);
  assert.strictEqual(by['saddlewoodsfarm.com'].status, 'NOT CHECKED');
  assert.strictEqual(by['thebelltower.com'].status, 'NOT FOUND');
  assert.match(by['thebelltower.com'].how, /headers, footers and menus are not searched/);
  assert.strictEqual(by['thecordelle.com'].status, 'FOUND');
  assert.strictEqual(by['thecordelle.com'].pages[0].page, '/faqs');
  assert.strictEqual(by['estellenashville.com'].status, 'NOT FOUND');
  assert.ok(web.seen.every((u) => u.startsWith('https://')), 'public pages only');
});

test('Change Log: the button fills Dispatch /changes in the URL fragment with the places found; nothing is posted', async () => {
  const { materials } = M.parseMap(TABS);
  const r = await C.search({ phrase: 'sparkling white wine', materials, drive: fakeDrive(), fetch: fakeWeb().fetch, now: () => new Date('2026-10-13T16:00:00Z') });
  assert.deepStrictEqual(r.tally.materials, { found: 2, not_found: 1, not_checked: 3 });
  const url = changeLogUrl(r, { bucket: 'menus' });
  assert.ok(url.startsWith('https://dispatch.infinityhospitalitygroup.com/changes#submit?cadet='));
  const draft = JSON.parse(decodeURIComponent(url.split('cadet=')[1]));
  assert.strictEqual(draft.bucket, 'menus');
  assert.strictEqual(draft.before, 'sparkling white wine');
  assert.deepStrictEqual(draft.collateral, [{ company: 'IHG', title: 'TBB Venue Guide' }, { company: 'IHG', title: 'IHG Rental Catalog' }]);
  assert.deepStrictEqual(draft.places, ['thebridgebuilding.com/bar/', 'thecordelle.com/faqs']);
  assert.strictEqual(JSON.parse(decodeURIComponent(changeLogUrl(r, { bucket: 'nope' }).split('cadet=')[1])).bucket, 'marketing');
});

test('routes: signed out refused; Katherine asks, the Box answers, the answer carries both Change Log links; 3 waiting max', async (t) => {
  const store = createMemoryStore();
  const a = express(); a.use(express.json()); a.use(pageGate); a.use(createCadetRouter({ store }));
  const s = await serve(a, t);
  assert.strictEqual((await call(s, '/api/cadet')).status, 401);
  assert.strictEqual((await call(s, '/api/cadet/ask', { method: 'POST', body: { phrase: 'wine' } })).status, 401);
  assert.strictEqual((await call(s, '/api/cadet/ask', { headers: as(K), method: 'POST', body: { phrase: ' ' } })).status, 400);
  const asked = await call(s, '/api/cadet/ask', { headers: as(K), method: 'POST', body: { phrase: 'sparkling white wine' } });
  assert.strictEqual(asked.status, 200);
  assert.strictEqual(asked.json.ask.status, 'queued');
  const waiting = await call(s, `/api/cadet/asks/${asked.json.ask.id}`, { headers: as(K) });
  assert.strictEqual(waiting.json.result, null);
  assert.strictEqual(waiting.json.change_log, undefined);

  const logs = [];
  const ran = await runOnce({ store, drive: fakeDrive(), fetch: fakeWeb().fetch, log: (l) => logs.push(l) });
  assert.strictEqual(ran, 1);
  assert.match(logs[0], /map: 6 titles, 3 with a link/);
  const done = await call(s, `/api/cadet/asks/${asked.json.ask.id}`, { headers: as(K) });
  assert.strictEqual(done.json.status, 'done');
  assert.strictEqual(done.json.result.tally.materials.found, 2);
  assert.match(done.json.change_log.marketing, /#submit\?cadet=/);
  assert.match(done.json.change_log.menus, /%22bucket%22%3A%22menus%22/);
  const list = await call(s, '/api/cadet', { headers: as(K) });
  assert.strictEqual(list.json.map.summary.linked, 3);
  assert.strictEqual(list.json.asks[0].tally.sites.found, 2);
  for (let i = 0; i < 3; i++) await call(s, '/api/cadet/ask', { headers: as(K), method: 'POST', body: { phrase: `p${i}x` } });
  assert.strictEqual((await call(s, '/api/cadet/ask', { headers: as(K), method: 'POST', body: { phrase: 'one more' } })).status, 429);
});

test('the Box run: a map that cannot be read falls back to the last read; a failed search is recorded, not lost', async () => {
  const store = createMemoryStore();
  await store.saveMap({ materials: M.parseMap(TABS).materials, summary: { total: 6 } });
  await store.queueAsk('sparkling white wine', K);
  const drive = fakeDrive();
  drive.getJson = async () => { throw new Error('Drive 403'); };
  const logs = [];
  await runOnce({ store, drive, fetch: async () => { throw new Error('offline'); }, log: (l) => logs.push(l) });
  assert.match(logs[0], /map: NOT READ \(Drive 403\); using the last read \(6 titles\)/);
  const a = await store.ask(1);
  assert.strictEqual(a.status, 'done');
  assert.ok(a.result.sites.every((x) => x.status === 'NOT CHECKED'), 'offline sites are not checked, never clean');
});

test('the Cadet on Katherine\'s team: a character with his own ask page; Run now refuses him; no em dash', async (t) => {
  const d = loadAgent('collateral-cadet');
  assert.strictEqual(d.ask_page, '/cadet');
  assert.match(d.character.traits[0].cant, /Change a material/);
  for (const f of ['agents/collateral-cadet/SKILL.md', 'agents/collateral-cadet/agent.json', 'public/cadet.html', 'lib/cadet-search.js', 'routes/cadet.js']) {
    assert.ok(!fs.readFileSync(path.join(__dirname, '..', f), 'utf8').includes(EM), `${f} has an em dash`);
  }
  const a = express(); a.use(express.json()); a.use(pageGate); a.use(createAgentsRouter({ store: createAgentStore({ lint }) }));
  const s = await serve(a, t);
  const list = await call(s, '/api/agents', { headers: as(K) });
  const cadet = list.json.agents.find((x) => x.slug === 'collateral-cadet');
  assert.strictEqual(cadet.name, 'Collateral Cadet');
  assert.strictEqual(cadet.ask_page, '/cadet');
  assert.strictEqual(list.json.agents.find((x) => x.slug === 'scout').ask_page, null);
  const run = await call(s, '/api/agents/collateral-cadet/run', { headers: as(K), method: 'POST', body: {} });
  assert.strictEqual(run.status, 409);
  assert.match(run.json.error, /\/cadet/);
});

test('pages: the Cadet page and the team page scripts parse; the dashboard links to the Cadet', () => {
  const vm = require('node:vm');
  for (const f of ['cadet.html', 'agents.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length, f);
    for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s), f);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'), /href="\/cadet"/);
});

test('read-only: the Cadet\'s code never writes to Drive or a website', () => {
  const src = ['lib/cadet-search.js', 'lib/collateral-map.js', 'jobs/cadet_run.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(src));
  const client = fs.readFileSync(path.join(__dirname, '..', 'lib', 'drive-client.js'), 'utf8');
  assert.match(client, /refused: text exports only/);
});
