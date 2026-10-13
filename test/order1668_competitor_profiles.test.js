'use strict';
// ORDER #1668: Katherine's competitor sheet -> the Scout reads every top
// competitor -> a weekly profile for each, on the Competitors page.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const { pageGate } = require('../middleware/page-gate');
const { createCompetitorsRouter } = require('../routes/competitors');
const { createMemoryStore } = require('../lib/agent-store');
const { REGISTRY } = require('../lib/agent-sources');
const { parseSheet, brandOf } = require('../lib/competitor-sheet');
const C = require('../lib/competitor-profiles');
const { lint } = require('../lib/ai-tells');

function serve(a, t) {
  return new Promise((resolve) => { const s = http.createServer(a).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
}
function call(server, urlPath, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, json, text: t }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
const as = (email) => ({ Cookie: `mkt_session=${jwt.sign({ role: 'sso', email, mkt_access: true }, process.env.JWT_SECRET)}` });
const K = 'khowe@infinityhospitality.net';

// Fictional competitors only.
const TABS = [
  { title: 'TBB - Competitors', rows: [['Name', 'URL', 'Notes'], ['Downtown', ''], ['Riverline Hall', 'https://www.riverlinehall.com/', 'rooftop'], ['Glass Barn Co', 'glassbarn.co'], ['The Bridge Building', 'thebridgebuilding.com']] },
  { title: 'TBT - Competitors', rows: [['Competitor', 'URL', 'Top'], ['Riverline Hall', 'riverlinehall.com', ''], ['Oak Chapel', 'oakchapel.com', 'Y'], ['No Site Venue', '']] },
  { title: 'ECD - Competitors', rows: [['Name', 'URL'], ['Riverline Hall', 'riverlinehall.com/weddings'], ['Glass Barn Co', 'not a url']] },
  { title: 'Notes', rows: [['just text']] },
];

test('sheet: top = 3+ tabs or marked; our own skipped; segments and notes kept', () => {
  assert.strictEqual(brandOf('TBB - Competitors'), 'TBB');
  const p = parseSheet(TABS);
  const by = Object.fromEntries(p.competitors.map((c) => [c.site, c]));
  assert.deepStrictEqual(by['riverlinehall.com'].brands, ['TBB', 'TBT', 'ECD']);
  assert.strictEqual(by['riverlinehall.com'].top, true);
  assert.deepStrictEqual(by['riverlinehall.com'].segments, ['Downtown']);
  assert.deepStrictEqual(by['riverlinehall.com'].notes, ['rooftop']);
  assert.strictEqual(by['oakchapel.com'].top, true, 'marked Top');
  assert.strictEqual(by['glassbarn.co'].top, false);
  assert.ok(!by['thebridgebuilding.com']);
  assert.ok(p.ours.some((o) => /thebridgebuilding/.test(o)));
  assert.ok(p.skipped.some((s) => s.name === 'Glass Barn Co'));
  assert.strictEqual(p.competitors[0].site, 'riverlinehall.com', 'top first, most tabs first');
});

test('sync: a missing share is said plainly, never a crash; a good read fills the list', async () => {
  const store = createMemoryStore({ lint });
  const denied = { serviceAccount: 'sa@x.iam', getJson: async () => { throw new Error('Drive 403: The caller does not have permission'); } };
  const r1 = await C.syncFromSheet({ store, drive: denied });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.why, /not shared with sa@x\.iam/);
  assert.match((await C.syncFromSheet({ store, drive: null })).why, /no Google service account/);
  const drive = { getJson: async (url) => (/values:batchGet/.test(url)
    ? { valueRanges: TABS.map((t) => ({ values: t.rows })) } : { sheets: TABS.map((t) => ({ properties: { title: t.title } })) }) };
  const r2 = await C.syncFromSheet({ store, drive });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.top, 2);
  assert.strictEqual((await store.competitors()).length, 3);
});

function fakeWeb(sites) {
  return async (url) => {
    const u = new URL(url); const pages = sites[u.hostname];
    const res = (status, body, type) => ({ status, url, headers: { get: () => type }, text: async () => body });
    if (!pages) return res(404, '', 'text/html');
    if (u.pathname === '/sitemap.xml') return res(200, Object.keys(pages).map((p) => `<loc>https://${u.hostname}${p}</loc>`).join(''), 'application/xml');
    if (!(u.pathname in pages)) return res(404, '', 'text/html');
    return res(200, `<html><title>${pages[u.pathname].t}</title><body>${pages[u.pathname].b}</body></html>`, 'text/html');
  };
}

test('the Scout reads top sheet competitors too, and records what changed per site', async () => {
  const store = createMemoryStore({ lint });
  await store.syncCompetitors(parseSheet(TABS).competitors);
  const web = { 'riverlinehall.com': { '/': { t: 'Riverline Hall', b: 'A rooftop venue on the river for weddings and parties of every size.' } },
    'oakchapel.com': { '/': { t: 'Oak Chapel', b: 'A small chapel for ceremonies with a garden for photos after.' } } };
  const ctx = { store, agent: 'scout', lint, env: {}, fetch: fakeWeb(web) };
  const first = await REGISTRY.competitor_watch({ pages_per_site: 4 }, ctx);
  assert.ok(first.ok);
  assert.match(first.text, /Riverline Hall \(riverlinehall\.com\)/);
  assert.match(first.text, /Oak Chapel/);
  assert.doesNotMatch(first.text, /glassbarn/, 'not top, not watched');
  web['riverlinehall.com']['/'].b += ' New for 2027: a winter package with heated tents and a hot cocoa bar for guests.';
  await REGISTRY.competitor_watch({ pages_per_site: 4 }, ctx);
  const c = await store.competitor('riverlinehall.com');
  assert.match(c.last_changes, /winter package/);
});

const GOOD = C.HEADINGS.map((h) => `## ${h}\n- A plain fact from their site.`).join('\n\n');

test('profiles: every heading required, one retry, dashes replaced, versions kept', async () => {
  const store = createMemoryStore({ lint });
  await store.syncCompetitors(parseSheet(TABS).competitors);
  await store.saveSnapshots('scout', 'riverlinehall.com', [{ path: '/', title: 'Riverline Hall', hash: 'a', text: 'Rooftop weddings up to 200 guests.' }], []);
  await store.setKhNotes('oakchapel.com', 'Their chapel books out a year ahead.', K);
  const prompts = [];
  let n = 0;
  const llm = { model: 'fake', async complete(q) { prompts.push(q); n++; return n === 1 ? 'no headings at all' : GOOD.replace('A plain fact', 'A plain fact — quoted'); } };
  const w = await C.writeProfiles({ store, llm });
  assert.strictEqual(w.written, 2);
  assert.match(prompts[0].user, /Rooftop weddings up to 200 guests/);
  assert.match(prompts[1].user, /refused \(missing section/);
  assert.ok(prompts.some((p) => /Their chapel books out a year ahead/.test(p.user)), "Katherine's notes reach the writer");
  const c = await store.competitor('riverlinehall.com');
  assert.strictEqual(c.profile_version, 1);
  assert.doesNotMatch(c.profile_md, /—/);
  await C.writeProfiles({ store, llm });
  assert.strictEqual((await store.profileVersions('riverlinehall.com')).length, 2);
  assert.strictEqual((await C.writeProfiles({ store, llm: null })).why, 'no model key on this machine');
  assert.strictEqual(C.cleanProfile('## At a glance\nx').error.startsWith('missing section'), true);
});

test('routes: signed out refused; list, one competitor with versions, notes saved with who', async (t) => {
  const store = createMemoryStore({ lint });
  await store.syncCompetitors(parseSheet(TABS).competitors);
  await store.saveProfile('riverlinehall.com', GOOD);
  const a = express(); a.use(express.json()); a.use(pageGate); a.use(createCompetitorsRouter({ store }));
  const s = await serve(a, t);
  assert.notStrictEqual((await call(s, '/api/competitors')).status, 200);
  const list = await call(s, '/api/competitors', { headers: as(K) });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.json.top, 2);
  assert.strictEqual(list.json.competitors[0].has_profile, true);
  const one = await call(s, '/api/competitors/riverlinehall.com', { headers: as(K) });
  assert.match(one.json.profile_md, /## Where we win/);
  assert.strictEqual(one.json.versions.length, 1);
  assert.strictEqual((await call(s, '/api/competitors/nowhere.com', { headers: as(K) })).status, 404);
  assert.strictEqual((await call(s, '/api/competitors/not%20a%20site', { headers: as(K) })).status, 400);
  const saved = await call(s, '/api/competitors/oakchapel.com/notes', { headers: as(K), method: 'PUT', body: { notes: 'Call them out on parking.' } });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.json.competitor.kh_notes_by, K);
  assert.strictEqual((await call(s, '/api/competitors/oakchapel.com/notes', { headers: as(K), method: 'PUT', body: { notes: 'x'.repeat(4001) } })).status, 400);
  const page = await call(s, '/competitors', { headers: as(K) });
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /ihg-tokens\.css/);
});
