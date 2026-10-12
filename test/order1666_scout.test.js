'use strict';
// ORDER #1666: the Scout. Katherine lists competitor sites; each Monday it
// reports only what changed since last week, plus new wedding and event trends
// from web search with links. Baseline first, never news.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const { pageGate } = require('../middleware/page-gate');
const { createAgentsRouter } = require('../routes/agents');
const { createMemoryStore } = require('../lib/agent-store');
const { REGISTRY } = require('../lib/agent-sources');
const W = require('../lib/agent-watch');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');
const { dueAgents } = require('../jobs/agent_run');

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
const K = 'khowe@infinityhospitality.net';
function app(store) { const a = express(); a.use(express.json()); a.use(pageGate); a.use(createAgentsRouter({ store })); return a; }

// A tiny fake web: site -> { path: html }, with a sitemap built from the keys.
function fakeWeb(sites) {
  return async (url) => {
    const u = new URL(url);
    const pages = sites[u.hostname];
    const res = (status, body, type) => ({ status, url, headers: { get: () => type }, text: async () => body });
    if (!pages) return res(404, '', 'text/html');
    if (u.pathname === '/sitemap.xml') return res(200, Object.keys(pages).map((p) => `<loc>https://${u.hostname}${p}</loc>`).join(''), 'application/xml');
    if (!(u.pathname in pages)) return res(404, '', 'text/html');
    return res(200, `<html><title>${pages[u.pathname].t}</title><body><h1>x</h1>${pages[u.pathname].b}</body></html>`, 'text/html');
  };
}

test('site check: plain domains in, junk and private names out', () => {
  assert.strictEqual(W.checkSite('https://www.Example-Venue.com/weddings?x=1').site, 'example-venue.com');
  assert.strictEqual(W.checkSite('barn.co.uk').site, 'barn.co.uk');
  for (const bad of ['', 'not a site', 'localhost', 'box.local', 'http://10', 'example']) assert.ok(W.checkSite(bad).error, bad);
});

test('page pick: home first, then pricing/package/wedding pages, then the rest; own host only', () => {
  const p = W.pickPages('v.com', ['https://v.com/about', 'https://v.com/pricing', 'https://other.com/pricing', 'https://v.com/weddings', 'https://v.com/'], 3);
  assert.deepStrictEqual(p, ['https://v.com/', 'https://v.com/pricing', 'https://v.com/weddings']);
});

test('routes: Katherine adds and removes competitors on the Scout only; 15 max; empty list shows under Waiting on', async (t) => {
  const store = createMemoryStore({ lint });
  const s = await serve(app(store), t);
  assert.strictEqual((await call(s, '/api/agents/scout/watch', { method: 'POST', body: { site: 'a.com' } })).status, 401);
  let scout = (await call(s, '/api/agents', { headers: as(K) })).json.agents.find((a) => a.slug === 'scout');
  assert.deepStrictEqual(scout.watch, []);
  assert.match(scout.character.needs[0], /competitor websites/);
  assert.strictEqual((await call(s, '/api/agents', { headers: as(K) })).json.agents.find((a) => a.slug === 'gbp').watch, null);
  const add = await call(s, '/api/agents/scout/watch', { headers: as(K), method: 'POST', body: { site: 'https://www.Rival.com/', label: 'Rival Barn' } });
  assert.strictEqual(add.status, 200);
  assert.strictEqual(add.json.watch.site, 'rival.com');
  assert.strictEqual((await call(s, '/api/agents/scout/watch', { headers: as(K), method: 'POST', body: { site: 'rival.com' } })).status, 409);
  assert.strictEqual((await call(s, '/api/agents/scout/watch', { headers: as(K), method: 'POST', body: { site: 'nope' } })).status, 400);
  assert.strictEqual((await call(s, '/api/agents/gbp/watch', { headers: as(K), method: 'POST', body: { site: 'x.com' } })).status, 404);
  scout = (await call(s, '/api/agents', { headers: as(K) })).json.agents.find((a) => a.slug === 'scout');
  assert.strictEqual(scout.watch.length, 1);
  assert.ok(!scout.character.needs.some((n) => /competitor websites/.test(n)));
  for (let i = 0; i < 14; i++) await store.addWatch('scout', `site${i}.com`, null, K);
  assert.match((await call(s, '/api/agents/scout/watch', { headers: as(K), method: 'POST', body: { site: 'one-more.com' } })).json.error, /full/);
  assert.strictEqual((await call(s, `/api/agents/scout/watch/${add.json.watch.id}`, { headers: as(K), method: 'DELETE' })).json.removed, 'rival.com');
});

test('competitor watch: first run is a baseline; next run reports only new pages, new lines and gone pages', async () => {
  const store = createMemoryStore({ lint });
  await store.addWatch('scout', 'rival.com', 'Rival Barn', K);
  await store.addWatch('scout', 'down.com', null, K);
  const web = { 'rival.com': { '/': { t: 'Rival', b: 'Welcome to the barn on the river in Franklin.' }, '/pricing': { t: 'Pricing', b: 'Our Saturday package includes the barn and the lawn for ten hours.' }, '/old': { t: 'Old', b: 'An old page that will go away soon enough.' } } };
  const ctx = { store, agent: 'scout', lint, env: {}, fetch: fakeWeb(web) };
  const first = await REGISTRY.competitor_watch({ pages_per_site: 12 }, ctx);
  assert.ok(first.ok);
  assert.match(first.text, /Rival Barn \(rival\.com\) \| baseline taken \| 3/);
  assert.match(first.text, /down\.com \| not reached/);
  assert.ok(!/CHANGED|NEW PAGE/.test(first.text), 'a baseline is never news');

  web['rival.com']['/pricing'].b = 'Our Saturday package includes the barn and the lawn for ten hours. New for 2027: a winter weekday rate with bar service included.';
  web['rival.com']['/winter'] = { t: 'Winter weddings', b: 'Cozy winter weddings by the fire in our new lodge.' };
  delete web['rival.com']['/old'];
  const second = await REGISTRY.competitor_watch({ pages_per_site: 12 }, ctx);
  assert.match(second.text, /NEW PAGE \/winter "Winter weddings"/);
  assert.match(second.text, /CHANGED \/pricing: 1 new line/);
  assert.match(second.text, /> New for 2027: a winter weekday rate with bar service included\./);
  assert.match(second.text, /PAGE GONE \/old/);
  assert.ok(!/CHANGED \/(?!pricing)/.test(second.text), 'unchanged pages are not reported');
  const third = await REGISTRY.competitor_watch({ pages_per_site: 12 }, ctx);
  assert.match(third.text, /No change since last run/);
});

test('competitor watch: dry runs never move the baseline; no list or no database is unavailable, not a failure', async () => {
  const store = createMemoryStore({ lint });
  assert.match((await REGISTRY.competitor_watch({}, { store, agent: 'scout' })).why, /no competitors listed yet/);
  assert.match((await REGISTRY.competitor_watch({}, { agent: 'scout' })).why, /no database/);
  await store.addWatch('scout', 'rival.com', null, K);
  const web = { 'rival.com': { '/': { t: 'Rival', b: 'Welcome to the barn on the river in Franklin.' } } };
  await REGISTRY.competitor_watch({}, { store, agent: 'scout', lint, env: {}, fetch: fakeWeb(web), dryRun: true });
  assert.strictEqual(store.snaps.length, 0);
});

test('trends: Claude with web search, last 14 days, links required; no key is unavailable', async () => {
  const sent = [];
  const fetch = async (url, opt) => { const b = JSON.parse(opt.body); sent.push(b); return { status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'Sage velvet linens (Brides, 10.08.2026) https://example.org/a' }] }) }; };
  const r = await REGISTRY.web_trends({ queries: ['wedding trends'] }, { env: {}, fetch, findApiKey: () => ({ key: 'k', source: 'test' }), now: () => new Date('2026-10-12T15:00:00Z') });
  assert.ok(r.ok);
  assert.ok(sent[0].tools && sent[0].tools[0].type.startsWith('web_search'));
  assert.match(sent[0].messages[0].content, /Today is October 12, 2026[\s\S]*last 14 days[\s\S]*link/);
  assert.match(r.text, /https:\/\/example\.org\/a/);
  const none = await REGISTRY.web_trends({ queries: ['x'] }, { env: {}, fetch, findApiKey: () => null });
  assert.match(none.why, /no Claude key/);
});

test('the Scout: Monday, one card, read-only, Katherine-facing; a run with no list still files trends', async () => {
  assert.ok(dueAgents('2026-10-12').includes('scout'));
  assert.ok(!dueAgents('2026-10-13').includes('scout'));
  const d = loadAgent('scout');
  assert.strictEqual(d.max_cards, 1);
  assert.match(d.skill, /never contact anyone and never change anything/);
  const store = createMemoryStore({ lint });
  const llm = { model: 'fake', async complete() { return JSON.stringify({ cards: [{ title: 'Scout report, week of 10.12.2026', body: 'Trends only this week.' }] }); } };
  const def = { ...d, sources: [d.sources[0], { type: 'request', label: 'stand-in for trends' }] };
  await runAgent({ def, store, llm, ask: 'trend text' });
  const card = store.cards[store.cards.length - 1];
  assert.strictEqual(card.agent, 'scout');
  assert.ok(card.sources.some((x) => !x.ok && /no competitors listed yet/.test(x.why)));
});
