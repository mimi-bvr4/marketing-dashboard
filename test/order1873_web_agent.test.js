'use strict';
// ORDER #1873: Katherine's Web Agent. Her HTML in, a WordPress DRAFT out: CSS
// scoped to the page, core blocks where safe, cleared photos uploaded and
// uncleared ones held, QA on the read-back, a Review card, and a publish
// switch that is built but OFF (attempts refused and logged).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.JWT_SECRET = 'marketing-test-secret-not-real';
delete process.env.WEB_AGENT_PUBLISH;

const { pageGate } = require('../middleware/page-gate');
const C = require('../lib/web-convert');
const Q = require('../lib/web-qa');
const W = require('../lib/web-wp');
const P = require('../lib/web-publish');
const { createMemoryStore } = require('../lib/web-store');
const { createMemoryStore: createAgentStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { createWebRouter, checkRequest } = require('../routes/web');
const { runOnce } = require('../jobs/web_run');

const EM = String.fromCharCode(0x2014);
const K = 'khowe@infinityhospitality.net';
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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

const SAMPLE = `<!doctype html><html><head><title>Rehearsal Dinners</title>
<link rel="stylesheet" href="https://fonts.example.com/x.css">
<style>
@import url("https://fonts.example.com/y.css");
body { margin: 0; font-family: Georgia, serif; }
.hero, .hero h1 { color: #111; }
@media (max-width: 600px) { .hero { padding: 1rem; } }
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
</style></head><body>
<section class="hero"><h1>Rehearsal dinners at the Bridge</h1><img src="images/terrace.jpg" alt="The terrace at dusk"></section>
<h2>Dinner with a view</h2>
<p>Plated or family style, from our own kitchen. <a href="/contact-new/">Ask about a date</a>.</p>
<p><img src="img/held.jpg" alt="A table set for twelve"></p>
<div class="grid" style="display:grid"><p>Getting here: 2 Victory Ave, Suite 100.</p></div>
<script>alert('x')</script>
<script src="https://js.hsforms.net/forms/embed/v2.js"></script>
<script>hbspt.forms.create({ portalId: "49701209", formId: "ae15d217-0623-4158-9463-2d0a617d358e" });</script>
</body></html>`;

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

// A WordPress that records every call. Pages and media in memory.
function fakeWp({ readBackStatus = 'draft' } = {}) {
  const pages = {
    9257: { id: 9257, status: 'publish', modified_gmt: '2026-10-01T00:00:00', title: { raw: 'Social' }, content: { raw: '<p>Old social copy.</p><p>Plated or family style, from our own kitchen. <a href="/contact-new/">Ask about a date</a>.</p>', rendered: '<p>Old social copy.</p><p>Plated or family style, from our own kitchen. <a href="/contact-new/">Ask about a date</a>.</p>' }, link: 'https://thebridgebuilding.com/events/social/', parent: 9200 },
    9235: { id: 9235, status: 'publish', modified_gmt: '2026-10-10T00:21:32', title: { raw: 'Home' }, content: { raw: '', rendered: '' }, link: 'https://thebridgebuilding.com/', parent: 0 },
  };
  const media = []; const calls = []; let next = 20000;
  const res = (status, data, hdr = {}) => ({ status, text: async () => JSON.stringify(data), headers: { get: (k) => hdr[k.toLowerCase()] || null } });
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url); const method = opts.method || 'GET';
    calls.push({ method, path: u.pathname, search: u.search, body: opts.body });
    const p = u.pathname.replace('/wp-json/wp/v2', '');
    if (method === 'GET' && p === '/pages') return res(200, Object.values(pages).map((x) => ({ id: x.id, status: x.status, modified_gmt: x.modified_gmt, title: { rendered: x.title.raw }, link: x.link })), { 'x-wp-totalpages': '1' });
    let m;
    if (method === 'GET' && (m = p.match(/^\/pages\/(\d+)$/))) { const x = pages[m[1]]; return x ? res(200, { ...x, status: x.id >= 20000 ? readBackStatus : x.status }) : res(404, { code: 'rest_post_invalid_id', message: 'Invalid post ID.' }); }
    if (method === 'POST' && p === '/pages') {
      const b = JSON.parse(opts.body); const id = next++;
      pages[id] = { id, status: b.status, modified_gmt: '2026-10-15T20:00:00', title: { raw: b.title }, content: { raw: b.content, rendered: b.content }, link: `https://thebridgebuilding.com/?page_id=${id}`, parent: b.parent || 0 };
      return res(201, pages[id]);
    }
    if (method === 'POST' && (m = p.match(/^\/pages\/(\d+)$/))) {
      const b = JSON.parse(opts.body); const x = pages[m[1]];
      if (b.content !== undefined) x.content = { raw: b.content, rendered: b.content };
      if (b.title !== undefined) x.title = { raw: b.title };
      if (b.status) x.status = b.status;
      x.modified_gmt = '2026-10-15T21:00:00';
      return res(200, x);
    }
    if (method === 'POST' && p === '/media') { const id = next++; media.push({ id, name: opts.headers['Content-Disposition'] }); return res(201, { id, source_url: `https://thebridgebuilding.com/wp-content/uploads/2026/10/m${id}.jpg` }); }
    if (method === 'POST' && (m = p.match(/^\/media\/(\d+)$/))) return res(200, { id: Number(m[1]) });
    return res(404, { code: 'nope' });
  }
  return { fetchImpl, calls, pages, media, login: () => ({ user: 'brain@', pass: 'not-a-real-password' }) };
}

test('convert: CSS scoped to the page, @import dropped, plain headings and paragraphs as core blocks, the rest as Custom HTML', () => {
  const out = C.convert(SAMPLE, { scope: 'ihg-web-r7', assets: [{ name: 'terrace.jpg', cleared: true, url: 'https://x/terrace.jpg', id: 31 }, { name: 'held.jpg', cleared: false }] });
  const css = out.content.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /^\.ihg-web-r7\{margin: 0; font-family: Georgia, serif;\}/);
  assert.match(css, /\.ihg-web-r7 \.hero,\.ihg-web-r7 \.hero h1\{/);
  assert.match(css, /@media \(max-width: 600px\)\{\.ihg-web-r7 \.hero\{padding: 1rem;\}\}/);
  assert.match(css, /@keyframes fade\{/);
  assert.ok(!/@import/.test(css));
  assert.ok(out.notes.some((n) => /@import/.test(n)) && out.notes.some((n) => /outside stylesheet/.test(n)));
  assert.ok(out.notes.some((n) => /1 script\(s\) removed/.test(n)), 'the alert script is removed');
  assert.match(out.content, /js\.hsforms\.net/, 'the HubSpot embed stays');
  assert.match(out.content, /<!-- wp:heading -->\n<h2 class="wp-block-heading">Dinner with a view<\/h2>/);
  assert.match(out.content, /<!-- wp:paragraph -->\n<p>Plated or family style/);
  assert.match(out.content, /<!-- wp:html -->\n<section class="hero">/);
  assert.match(out.content, /<!-- wp:group \{"className":"ihg-web-r7"\} -->\n<div class="wp-block-group ihg-web-r7">/);
  assert.match(out.content, /src="https:\/\/x\/terrace\.jpg"/);
  assert.match(out.content, /PHOTO HELD, not cleared for the web: held\.jpg/);
  assert.deepStrictEqual(out.held, [{ name: 'held.jpg', why: 'not marked cleared' }]);
  assert.strictEqual(out.title, 'Rehearsal Dinners');
  assert.ok(out.tally.core >= 2 && out.tally.custom_html >= 2);
  // every selector anywhere carries the scope: nothing can reach the theme
  for (const m of css.matchAll(/(?:^|[{}])([^{}@]+)\{/g)) {
    const sel = m[1].trim();
    if (/^(from|to|\d+%)$/.test(sel)) continue;
    for (const one of sel.split(',')) assert.match(one, /^\.ihg-web-r7\b/, one);
  }
});

test('convert: a heading with its own class stays as she wrote it; an unknown image is held; an outside image is flagged', () => {
  const out = C.convert('<h2 class="big">Hi</h2><img src="nope.png" alt="x"><img src="https://cdn.example.com/a.jpg" alt="y">', { scope: 's' });
  assert.match(out.content, /<!-- wp:html -->\n<h2 class="big">Hi<\/h2>/);
  assert.deepStrictEqual(out.held.map((h) => h.why), ['the file was not uploaded with the HTML']);
  assert.deepStrictEqual(out.external, ['https://cdn.example.com/a.jpg']);
});

test('QA is RED-first: a bad page turns every check RED; a clean one is GREEN', () => {
  const bad = `<h1>One</h1><h1>Two</h1><img src="a.jpg"><p>Truly breathtaking ${EM} holds up to 1,200 guests.</p>
    <p>Find us at 175 Cherokee Dock Rd, or at the TBB, at Saddlewood Farm.</p><form action="https://evil.example.com/post"></form>`;
  const r = Q.runQa(bad, { site: 'TBB' });
  const v = Object.fromEntries(r.rows.map((x) => [x.check, x.verdict]));
  assert.deepStrictEqual(v, {
    'Exactly one H1': 'RED', 'Every image has alt text': 'RED', 'No em dashes or AI tells': 'RED', 'No hard capacity numbers': 'RED',
    'No venue code shown as a name': 'RED', 'Venue facts match Venue_Master': 'RED', 'Forms post to the existing HubSpot form': 'RED',
    "Photos cleared and in this site's Media Library": 'GREEN',
  });
  const good = Q.runQa('<h1>Rehearsal dinners</h1><img src="x.jpg" alt="The terrace"><p>2 Victory Ave, Suite 100, Nashville.</p><script>hbspt.forms.create({ portalId: "49701209" })</script>', { site: 'TBB' });
  assert.strictEqual(good.red, 0, JSON.stringify(good.rows));
  assert.strictEqual(Q.runQa('<h1>x</h1>', { site: 'NEB' }).rows.find((x) => x.check === 'Venue facts match Venue_Master').verdict, 'NOT CHECKED');
  assert.strictEqual(Q.checkForms('<script>hbspt.forms.create({ portalId: "123" })</script>').verdict, 'RED');
});

test('the Box run, NEW page: cleared photo uploaded with alt text, one DRAFT page created, proof = only that page changed, card on the Review tab', async () => {
  const wp = fakeWp(); const store = createMemoryStore(); const cards = createAgentStore({ lint });
  await store.queue({ site: 'TBB', new_title: 'Rehearsal Dinners', html: SAMPLE, assets: [{ name: 'terrace.jpg', type: 'image/jpeg', data: PNG, cleared: true }, { name: 'held.jpg', type: 'image/jpeg', data: PNG, cleared: false }] }, K);
  const logs = [];
  const n = await runOnce({ store, cards, fetchImpl: wp.fetchImpl, login: wp.login, now: new Date('2026-10-15T20:00:00Z'), log: (l) => logs.push(l) });
  assert.strictEqual(n, 1);
  const req = await store.get(1);
  assert.strictEqual(req.status, 'done', req.error);
  const r = req.result;
  assert.strictEqual(r.status, 'draft');
  assert.strictEqual(r.title, 'DRAFT (Web Agent) 10.15.2026: Rehearsal Dinners');
  assert.deepStrictEqual(r.changed, [r.draft_id]);
  assert.strictEqual(r.proof_ok, true);
  assert.strictEqual(wp.media.length, 1, 'only the cleared photo went up');
  assert.match(wp.pages[r.draft_id].content.raw, /wp-content\/uploads\/2026\/10\/m20000\.jpg/);
  assert.match(wp.pages[r.draft_id].content.raw, /PHOTO HELD/);
  // writes: one media upload, its alt text, one new page. Nothing else.
  const writes = wp.calls.filter((c) => c.method !== 'GET').map((c) => c.path.replace('/wp-json/wp/v2', ''));
  assert.deepStrictEqual(writes, ['/media', '/media/20000', '/pages']);
  assert.strictEqual(JSON.parse(wp.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pages')).body).status, 'draft');
  assert.strictEqual(wp.pages[9257].modified_gmt, '2026-10-01T00:00:00');
  // the write log carries every post id
  assert.deepStrictEqual(store.logRows.map((l) => [l.action, l.post_id]), [['media uploaded', 20000], ['media alt text set', 20000], ['draft page created', r.draft_id], ['read-back proof', r.draft_id]]);
  // the Review card
  const [card] = await cards.list({ status: 'draft' });
  assert.strictEqual(card.agent, 'web-agent');
  assert.strictEqual(card.title, `TBB: Rehearsal Dinners (draft #${r.draft_id})`);
  assert.deepStrictEqual(card.payload.web, { request_id: 1, site: 'TBB', draft_id: r.draft_id, replaces: null, preview_link: `https://thebridgebuilding.com/?page_id=${r.draft_id}&preview=true`, edit_link: `https://thebridgebuilding.com/wp-admin/post.php?post=${r.draft_id}&action=edit` });
  assert.match(card.body, /Saved as a DRAFT on The Bridge Building/);
  assert.match(card.body, /\| Exactly one H1 \| GREEN \|/);
  assert.match(card.body, /\| Photos cleared and in this site's Media Library \| AMBER \| held\.jpg \(not marked cleared\)/);
  assert.match(card.body, /Screenshots[\s\S]*Not taken: no browser/);
  assert.ok(!card.body.includes(EM));
  assert.match(logs[0], /web 1 TBB: draft #20001 \(draft\)/);
});

test('the Box run, EXISTING page: the live page is only read; the draft says what it replaces; the card says what changed; shots taken when a browser is there', async () => {
  const wp = fakeWp(); const store = createMemoryStore(); const cards = createAgentStore({ lint });
  await store.queue({ site: 'TBB', page_id: 9257, html: SAMPLE, assets: [] }, K);
  // a browser that is not installed: one short line on the card, never the banner
  const broken = async () => { throw new Error('browserType.launch: Executable does not exist\n╔══ banner ══╗'); };
  const s0 = createMemoryStore(); await s0.queue({ site: 'TBB', new_title: 'B', html: '<h1>B</h1>', assets: [] }, K);
  await runOnce({ store: s0, cards: createAgentStore({ lint }), fetchImpl: fakeWp().fetchImpl, login: wp.login, shooter: broken, log: () => {} });
  assert.strictEqual((await s0.get(1)).result.shots.why, 'the browser failed: browserType.launch: Executable does not exist');
  const shots = [];
  const shooter = async (x) => { shots.push(x.url ? 'url' : 'html'); return { mobile: PNG, desktop: PNG }; };
  await runOnce({ store, cards, fetchImpl: wp.fetchImpl, login: wp.login, shooter, now: new Date('2026-10-15T20:00:00Z'), log: () => {} });
  const r = (await store.get(1)).result;
  assert.strictEqual(r.replaces, 9257);
  assert.match(r.title, /: Social \(replaces page 9257\)$/);
  assert.strictEqual(wp.pages[r.draft_id].parent, 9200);
  assert.ok(!wp.calls.some((c) => c.method === 'POST' && /\/pages\/\d+$/.test(c.path)), 'never a write to an existing page');
  assert.strictEqual(wp.pages[9257].content.raw.startsWith('<p>Old social copy.'), true);
  assert.strictEqual(r.diff.removed, 1);
  assert.ok(r.diff.kept >= 1);
  assert.deepStrictEqual(shots, ['html', 'url']);
  const [card] = await cards.list({ status: 'draft' });
  assert.match(card.body, /Replaces: \[Social\]\(https:\/\/thebridgebuilding\.com\/events\/social\/\) \(page 9257\)/);
  assert.match(card.body, /gone: "Old social copy\."/);
  assert.match(card.body, /Phone 390px and desktop 1280px are on the \[Web page\]\(\/web#r1\), with the live page beside them/);
});

test('ALARM: a draft that reads back as anything but draft is reported, never quietly kept', async () => {
  const wp = fakeWp({ readBackStatus: 'publish' }); const store = createMemoryStore(); const cards = createAgentStore({ lint });
  await store.queue({ site: 'TBB', new_title: 'X', html: '<h1>X</h1>', assets: [] }, K);
  await runOnce({ store, cards, fetchImpl: wp.fetchImpl, login: wp.login, log: () => {} });
  const req = await store.get(1);
  assert.strictEqual(req.status, 'failed');
  assert.match(req.error, /ALARM: read back with status "publish"/);
  const [card] = await cards.list({ status: 'draft' });
  assert.match(card.title, /\(ALARM, page #20000 is "publish"\)/);
  assert.match(card.body, /^\*\*ALARM: read back with status "publish", not draft\. Check page #20000 in WordPress now\.\*\*/);
});

test('THE FENCE: the draft writer sends only the DRAFT status and never writes to an existing page id', () => {
  const src = read('lib/web-wp.js');
  assert.match(src, /const body = \{ title: [^}]*, status: DRAFT \};/);
  assert.strictEqual((src.match(/JSON\.stringify\(body\)/g) || []).length, 1, 'one page body is ever sent');
  assert.ok(!/'(publish|future|private|pending)'/.test(src));
  assert.ok(!/post\(`\/pages\/\$\{/.test(src) && !/post\('\/pages\/'/.test(src), 'no POST to /pages/<id>');
  assert.ok(!/method:\s*'(DELETE|PUT|PATCH)'/.test(src));
  for (const f of ['lib/web-convert.js', 'lib/web-qa.js', 'lib/web-store.js', 'routes/web.js', 'jobs/web_run.js']) assert.ok(!/\/pages\/\$\{[^}]+\}`,\s*JSON/.test(read(f)), f);
});

test('PUBLISH IS OFF: the route refuses and logs; the Box refuses too; only the exact value "on" opens it', async (t) => {
  for (const v of [undefined, '', 'true', 'ON', 'on ']) assert.strictEqual(P.publishOn({ WEB_AGENT_PUBLISH: v }), false, String(v));
  assert.strictEqual(P.publishOn({ WEB_AGENT_PUBLISH: 'on' }), true);
  const wp = fakeWp(); const store = createMemoryStore(); const cards = createAgentStore({ lint });
  await store.queue({ site: 'TBB', page_id: 9257, html: SAMPLE, assets: [] }, K);
  await runOnce({ store, cards, fetchImpl: wp.fetchImpl, login: wp.login, env: {}, log: () => {} });
  const a = express(); a.use(pageGate); a.use(createWebRouter({ store, env: {} }));
  const s = await serve(a, t);
  const before = wp.calls.length;
  const res = await call(s, '/api/web/requests/1/publish', { headers: as(K), method: 'POST', body: {} });
  assert.strictEqual(res.status, 409);
  assert.match(res.json.why, /Publish is OFF/);
  assert.deepStrictEqual(store.logRows.slice(-1).map((l) => [l.action, l.detail, l.who]), [['publish refused', 'switch OFF', K]]);
  assert.strictEqual((await store.get(1)).status, 'done', 'not queued');
  // A request that somehow reached the queue is refused by the Box's own switch.
  (await store.get(1)).status = 'publish_queued';
  await runOnce({ store, cards, fetchImpl: wp.fetchImpl, login: wp.login, env: { WEB_AGENT_PUBLISH: 'yes' }, log: () => {} });
  assert.strictEqual(wp.calls.length, before, 'no WordPress call at all');
  assert.strictEqual(store.logRows.slice(-1)[0].detail, 'switch OFF on the Box');
  assert.strictEqual(wp.pages[9257].content.raw.startsWith('<p>Old social copy.'), true);
  const detail = await call(s, '/api/web/requests/1', { headers: as(K) });
  assert.strictEqual(detail.json.publish, 'off');
  assert.ok(detail.json.log.some((l) => l.action === 'publish refused'));
});

test('publish, when Mimi turns it ON (not today): backs up the live page first, and rollback puts it back', async () => {
  const wp = fakeWp(); const c = W.client({ site: 'TBB', fetchImpl: wp.fetchImpl, login: wp.login });
  const d = await W.createDraftPage(c, { title: 'D', content: '<p>New.</p>' }, () => {});
  const log = []; const env = { WEB_AGENT_PUBLISH: 'on' };
  const out = await P.publish({ c, request: { result: { draft_id: d.id, replaces: 9257 } }, env, log: (e) => log.push(e) });
  assert.ok(out.ok);
  assert.strictEqual(wp.pages[9257].content.raw, '<p>New.</p>');
  assert.deepStrictEqual(log.map((l) => l.action), ['live page backed up', 'live page replaced from draft']);
  assert.match(log[0].detail, /Old social copy/);
  const rb = await P.rollback({ c, backup: out.backup, env, log: (e) => log.push(e) });
  assert.ok(rb.ok);
  assert.match(wp.pages[9257].content.raw, /^<p>Old social copy\./);
  const off = await P.rollback({ c, backup: out.backup, env: {}, log: (e) => log.push(e) });
  assert.ok(off.refused);
});

test('routes: signed out refused; Squarespace, both/neither page, bad photo refused; an upload queues; 3 waiting max', async (t) => {
  const store = createMemoryStore();
  const fetchImpl = async (url) => ({ status: 200, text: async () => JSON.stringify(url.includes('thebridgebuilding.com/wp-json/wp/v2/pages') ? [{ id: 9248, title: { rendered: 'Weddings &amp; More' }, link: 'https://thebridgebuilding.com/events/weddings/' }] : []) });
  const a = express(); a.use(pageGate); a.use(createWebRouter({ store, env: {}, fetchImpl }));
  const s = await serve(a, t);
  assert.strictEqual((await call(s, '/api/web')).status, 401);
  const home = await call(s, '/api/web', { headers: as(K) });
  assert.strictEqual(home.json.publish, 'off');
  assert.deepStrictEqual(home.json.sites.map((x) => x.code), ['TBB', 'TBT', 'ECD', 'SWF', 'NEB', 'IHG', 'DEC', 'DD']);
  assert.deepStrictEqual((await call(s, '/api/web/pages?site=TBB&q=wed', { headers: as(K) })).json.pages, [{ id: 9248, title: 'Weddings & More', link: 'https://thebridgebuilding.com/events/weddings/' }]);
  assert.match(checkRequest({ site: 'COR', new_title: 'x', html: '<p>x</p>' }).error, /Squarespace/);
  assert.match(checkRequest({ site: 'TBB', html: '<p>x</p>' }).error, /one, not both/);
  assert.match(checkRequest({ site: 'TBB', page_id: 5, new_title: 'x', html: '<p>x</p>' }).error, /one, not both/);
  assert.match(checkRequest({ site: 'TBB', new_title: 'x', html: '<p>x</p>', assets: [{ name: 'a.svg', type: 'image/svg+xml', data: 'AA==' }] }).error, /only JPG/);
  assert.strictEqual(checkRequest({ site: 'tbb', new_title: ' x ', html: '<p>x</p>', assets: [{ name: 'C:\\pics\\a.jpg', type: 'image/jpeg', data: PNG, cleared: 'yes' }] }).request.assets[0].cleared, false, 'only true is cleared');
  const big = '<p>' + 'x'.repeat(3 * 1024 * 1024) + '</p>';
  const photo = 'A'.repeat(5 * 1024 * 1024);
  const ok = await call(s, '/api/web/requests', { headers: as(K), method: 'POST', body: { site: 'TBB', new_title: 'Big photo', html: '<h1>x</h1>', assets: [{ name: 'p.jpg', type: 'image/jpeg', data: photo, cleared: true }] } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual((await call(s, '/api/web/requests', { headers: as(K), method: 'POST', body: { site: 'TBB', new_title: 'x', html: big } })).status, 400);
  for (let i = 0; i < 2; i++) await call(s, '/api/web/requests', { headers: as(K), method: 'POST', body: { site: 'TBB', new_title: 'p' + i, html: '<p>x</p>' } });
  assert.strictEqual((await call(s, '/api/web/requests', { headers: as(K), method: 'POST', body: { site: 'TBB', new_title: 'one more', html: '<p>x</p>' } })).status, 429);
  const list = await call(s, '/api/web', { headers: as(K) });
  assert.strictEqual(list.json.requests.length, 3);
  assert.ok(!('html' in list.json.requests[0]) && !('assets' in list.json.requests[0]));
});

test('server: the upload route skips the 2 MB parser and is mounted below the gate; the page, nav link and files are clean', () => {
  const server = read('server.js');
  assert.match(server, /req\.path === '\/api\/web\/requests' \? next\(\) : jsonBody/);
  assert.ok(server.indexOf("require('./routes/web')") > server.indexOf('app.use(pageGate)'));
  assert.ok(server.indexOf("require('./routes/web')") < server.indexOf('app.use(express.static'));
  assert.match(read('public/index.html'), /href="\/web"/);
  assert.match(read('jobs/agents_handoff.sh'), /node jobs\/web_run\.js/);
  const vm = require('node:vm');
  const html = read('public/web.html');
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1]));
  for (const f of ['lib/web-convert.js', 'lib/web-qa.js', 'lib/web-wp.js', 'lib/web-publish.js', 'lib/web-store.js', 'lib/web-shots.js', 'routes/web.js', 'jobs/web_run.js', 'public/web.html']) {
    assert.ok(!read(f).includes(EM), `${f} has an em dash`);
  }
});
