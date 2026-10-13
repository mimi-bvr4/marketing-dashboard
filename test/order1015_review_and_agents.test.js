'use strict';
// ORDER #1015: the Review tab and the agent runner, end to end.
//
// Real Express app, THE REAL page gate (#654/#1370) and the real
// routes/review.js over a real socket; a memory store with the pg store's
// decision rule; a fake model and a fake web. Each guard is shown refusing
// something wrong (iron rule 14).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const { pageGate } = require('../middleware/page-gate');
const { createReviewRouter } = require('../routes/review');
const { createMemoryStore, SCHEMA_SQL } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent, listAgents, parseCards } = require('../lib/agent-runner');
const { gather } = require('../lib/agent-sources');
const { dueAgents, main } = require('../jobs/agent_run');

const EM = '—';

function serve(a, t) {
  return new Promise((resolve) => {
    const s = http.createServer(a).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); });
  });
}
function call(server, urlPath, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(buf); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const as = (email) => ({ Cookie: `mkt_session=${jwt.sign({ role: 'sso', email, mkt_access: true }, process.env.JWT_SECRET)}` });

function app(store) {
  const a = express();
  a.use(express.json());
  a.use(pageGate);
  a.use(createReviewRouter({ store }));
  return a;
}

// ------------------------------------------------------------- the lint

test('lint: one em dash fails the draft; a clean sentence passes', () => {
  assert.strictEqual(lint(`We met at the river ${EM} it rained.`).fails.length, 1);
  assert.strictEqual(lint('We met at the river. It rained, and the tent held.').clean, true);
  assert.strictEqual(lint('Doors at 5 – 7 p.m.').fails[0].rule, 'spaced en dash');
});

test('lint: banned words, filler openers, title case headings, repeated gush', () => {
  const r = lint('## The Most Stunning Riverfront Venue\nIt is nestled downtown.\nAdditionally, stunning views and a stunning bar.');
  const rules = r.flags.map((f) => f.rule);
  assert.ok(rules.includes('banned phrase'));
  assert.ok(rules.includes('filler opener'));
  assert.ok(rules.includes('title case heading'));
  assert.ok(rules.includes('gush repeated'));
});

test('lint: a hard capacity is flagged; a range or "depending on" is not', () => {
  assert.strictEqual(lint('The ballroom holds up to 300 guests.').flags[0].rule, 'hard capacity');
  assert.strictEqual(lint('The ballroom seats 150 to 220 guests.').flags.length, 0);
  assert.strictEqual(lint('About 300 seated, depending on your floor plan. Holds 300 with a dance floor.').flags.length, 0);
});

// ------------------------------------------------------------- the store's one rule

test('store: approve refuses a draft with an em dash; reject needs a reason; edit re-lints', async () => {
  const s = createMemoryStore({ lint });
  const bad = await s.insert({ agent: 'x', agent_name: 'X', job: 'j', title: 't', body: `a ${EM} b` });
  assert.match((await s.decide(bad.id, { action: 'approve', who: 'k@x' })).error, /em dash/);
  assert.match((await s.decide(bad.id, { action: 'reject', who: 'k@x', reason: '  ' })).error, /reason/);
  assert.match((await s.decide(bad.id, { action: 'approve' })).error, /no person/);
  const ed = await s.decide(bad.id, { action: 'edit', who: 'k@x', body: 'a, b' });
  assert.strictEqual(ed.card.edited, true);
  assert.strictEqual(ed.card.checks.ai_tells.clean, true);
  const ok = await s.decide(bad.id, { action: 'approve', who: 'k@x' });
  assert.strictEqual(ok.card.status, 'ready');
  assert.strictEqual(ok.card.decided_by, 'k@x');
});

test('schema: idempotent statements only (this Postgres is in the nightly backup set)', () => {
  for (const q of SCHEMA_SQL) assert.match(q, /IF NOT EXISTS/);
  assert.match(SCHEMA_SQL.join(' '), /CHECK \(status IN \('draft', 'ready', 'rejected'\)\)/);
});

// ------------------------------------------------------------- the routes, through the real gate

test('routes: signed out is refused; a staff session without mkt_access is refused', async (t) => {
  const s = await serve(app(createMemoryStore({ lint })), t);
  assert.strictEqual((await call(s, '/api/review/cards')).status, 401);
  const staff = { Cookie: `mkt_session=${jwt.sign({ role: 'sso', email: 'sales@x' }, process.env.JWT_SECRET)}` };
  assert.strictEqual((await call(s, '/api/review/cards', { headers: staff })).status, 401);
  assert.strictEqual((await call(s, '/api/review/lint', { method: 'POST', body: { text: 'x' } })).status, 401);
});

test('routes: leadership lists drafts, rejects with a reason, approves, and the decision names the person', async (t) => {
  const store = createMemoryStore({ lint });
  await store.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'review replies', title: 'Reply draft', body: 'Thank you, Ana.' });
  await store.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'review replies', title: 'Bad', body: `We ${EM} thank you` });
  const s = await serve(app(store), t);
  const k = as('KHowe@infinityhospitality.net');
  const list = await call(s, '/api/review/cards', { headers: k });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.json.cards.length, 2);
  const blocked = await call(s, '/api/review/cards/2', { headers: k, method: 'POST', body: { action: 'approve' } });
  assert.strictEqual(blocked.status, 400);
  const noReason = await call(s, '/api/review/cards/2', { headers: k, method: 'POST', body: { action: 'reject' } });
  assert.strictEqual(noReason.status, 400);
  const rej = await call(s, '/api/review/cards/2', { headers: k, method: 'POST', body: { action: 'reject', reason: 'em dash' } });
  assert.strictEqual(rej.json.card.status, 'rejected');
  const ok = await call(s, '/api/review/cards/1', { headers: k, method: 'POST', body: { action: 'approve' } });
  assert.strictEqual(ok.json.card.status, 'ready');
  assert.strictEqual(ok.json.card.decided_by, 'khowe@infinityhospitality.net');
  assert.strictEqual((await call(s, '/api/review/cards?status=ready', { headers: k })).json.cards.length, 1);
  assert.strictEqual((await call(s, '/api/review/cards/99', { headers: k, method: 'POST', body: { action: 'approve' } })).status, 404);
  assert.strictEqual((await call(s, '/api/review/cards/abc', { headers: k, method: 'POST', body: { action: 'approve' } })).status, 400);
  const l = await call(s, '/api/review/lint', { headers: k, method: 'POST', body: { text: `a ${EM} b, seamless` } });
  assert.strictEqual(l.json.clean, false);
  const page = await call(s, '/review', { headers: k });
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /It never publishes, posts, sends or spends/);
});

test('routes: nothing in routes/review.js can publish, post or send', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'review.js'), 'utf8');
  for (const bad of ['wp-json', 'fetch(', 'mybusiness', 'gmail', 'sendMail', 'status: \'publish']) assert.ok(!src.includes(bad), bad);
});

// ------------------------------------------------------------- the runner

function fakeModel(answers) {
  const calls = [];
  return { model: 'fake', calls, async complete(req) { calls.push(req); const a = answers.shift(); if (a instanceof Error) throw a; return a; } };
}
const DEF = { slug: 'demo', name: 'Demo Agent', job: 'demo job', max_cards: 2, skill: '# Demo\nWrite cards.',
  sources: [{ type: 'request', required: true, label: 'the request' }, { type: 'pending', label: 'Some API', why: 'not approved yet' }] };

test('runner: a card with an em dash is sent back to the model once, then stored clean with the credit line', async () => {
  const store = createMemoryStore({ lint });
  const llm = fakeModel([
    JSON.stringify({ cards: [{ title: 'One', target: 'TBT', body: `Great day ${EM} truly.` }] }),
    'Sure: {"cards":[{"title":"One","target":"TBT","body":"Great day, truly."}]}',
  ]);
  const r = await runAgent({ def: DEF, store, llm, ask: 'write one' });
  assert.ok(r.ok);
  assert.strictEqual(llm.calls.length, 2);
  assert.match(llm.calls[1].user, /em dash/);
  const c = store.cards[0];
  assert.strictEqual(c.checks.ai_tells.clean, true);
  assert.match(c.body, /Drafted by Demo Agent \(the Box\)/);
  assert.match(c.body, /Some API: not approved yet/);
  assert.match(llm.calls[0].system, /OUTPUT CONTRACT/);
  assert.strictEqual(store.runList[0].status, 'done');
});

test('runner: a missing REQUIRED source writes a "could not run" card and never calls the model', async () => {
  const store = createMemoryStore({ lint });
  const llm = fakeModel([]);
  const r = await runAgent({ def: DEF, store, llm, ask: null });
  assert.strictEqual(llm.calls.length, 0);
  assert.match(store.cards[0].title, /could not run/);
  assert.match(store.cards[0].body, /this agent needs a request/);
  assert.ok(r.ok);
});

test('runner: no model key still records the measured evidence; a model error is a failed run with a card (never silent)', async () => {
  const s1 = createMemoryStore({ lint });
  await runAgent({ def: DEF, store: s1, llm: null, ask: 'x' });
  assert.match(s1.cards[0].title, /no model key/);
  const s2 = createMemoryStore({ lint });
  const r = await runAgent({ def: DEF, store: s2, llm: fakeModel([new Error('model answered 529')]), ask: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(s2.cards[0].title, /run failed/);
  assert.strictEqual(s2.runList[0].status, 'failed');
});

test('runner: recent rejection reasons are handed to the next run', async () => {
  const store = createMemoryStore({ lint });
  const old = await store.insert({ agent: 'demo', agent_name: 'Demo Agent', job: 'j', title: 'Old draft', body: 'x' });
  await store.decide(old.id, { action: 'reject', who: 'k@x', reason: 'too long, name the space' });
  const llm = fakeModel([JSON.stringify({ cards: [{ title: 'New', body: 'Short.' }] })]);
  await runAgent({ def: DEF, store, llm, ask: 'x' });
  assert.match(llm.calls[0].user, /too long, name the space/);
});

test('parseCards: JSON inside chatter is found; caps at max; drops cards with no body', () => {
  const t = 'Here you go:\n{"cards":[{"title":"a","body":"b"},{"title":"c"},{"title":"d","body":"e"},{"title":"f","body":"g"}]}\nThanks';
  assert.deepStrictEqual(parseCards(t, 2).map((c) => c.title), ['a', 'd']);
  assert.throws(() => parseCards('no json here'), /no JSON/);
});

// ------------------------------------------------------------- sources

function fakeWeb(pages) {
  return async (url) => {
    const p = pages[url];
    if (!p) return { status: 404, url, headers: { get: () => 'text/html' }, text: async () => 'missing' };
    return { status: p.status || 200, url: p.final || url, headers: { get: () => (url.endsWith('.xml') ? 'application/xml' : 'text/html') }, text: async () => p.body };
  };
}

test('site_crawl: measures 404s, missing descriptions, H1 count, duplicate titles, off-site redirects and AI tells', async () => {
  const html = (title, desc, body) => `<html><head><title>${title}</title>${desc ? `<meta name="description" content="${desc}">` : ''}</head><body><h1>H</h1>${body}</body></html>`;
  const web = fakeWeb({
    'https://a.com/': { body: html('Home', 'd', 'Welcome.') },
    'https://a.com/sitemap.xml': { body: '<urlset><url><loc>https://a.com/x</loc></url><url><loc>https://a.com/gone</loc></url><url><loc>https://a.com/y</loc></url><url><loc>https://a.com/z</loc></url></urlset>' },
    'https://a.com/x': { body: html('Same', '', `A seamless day ${EM} wow.`) },
    'https://a.com/y': { body: html('Same', 'd', 'ok') },
    'https://a.com/z': { body: html('Z', 'd', 'ok'), final: 'https://other.com/z' },
    'https://b.com/': { status: 503, body: '' },
  });
  const { got, unavailable } = await gather([{ type: 'site_crawl', sites: ['a.com', 'b.com'] }], { env: {}, fetch: web, lint });
  assert.strictEqual(unavailable.length, 0);
  const t = got[0].table;
  assert.match(t, /\| a\.com \| \/gone \| 404 \|/);
  assert.match(t, /\/x \| no meta description/);
  assert.match(t, /\/x \| 1 em\/en dash in page copy/);
  assert.match(t, /AI-tell words: seamless/);
  assert.match(t, /same title \| "Same"/);
  assert.match(t, /redirects off-site to https:\/\/other\.com\/z/);
  assert.match(t, /\| b\.com \| \/ \| home page 503 \|/);
});

test('site_crawl: no site answering is "unavailable", not an empty clean report', async () => {
  const { got, unavailable } = await gather([{ type: 'site_crawl', sites: ['a.com'] }], { env: {}, fetch: fakeWeb({}), lint });
  assert.strictEqual(got.length, 0);
  assert.match(unavailable[0].why, /no site answered/);
});

test('file source: reads inside the tree, picks the newest matching file, refuses paths outside it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  fs.mkdirSync(path.join(root, 'M'));
  fs.writeFileSync(path.join(root, 'M', 'Pulse_2026-09.md'), 'september');
  fs.writeFileSync(path.join(root, 'M', 'Pulse_2026-10.md'), 'october');
  const env = { IHG_TREE: root };
  const r = await gather([{ type: 'file', newest: 'M/Pulse_' }, { type: 'file', path: '../etc/passwd' }, { type: 'file', path: 'M/none.md' }], { env, lint });
  assert.strictEqual(r.got[0].text, 'october');
  assert.match(r.unavailable[0].why, /outside the tree/);
  assert.match(r.unavailable[1].why, /not found/);
});

test('dashboard source: no fleet key is "unavailable"; with one it sends the key as a Bearer', async () => {
  const none = await gather([{ type: 'dashboard', paths: ['/api/ga4/summary'] }], { env: {}, lint, keychain: () => '' });
  assert.match(none.unavailable[0].why, /marketing-fleet-key/);
  let seen;
  const web = async (url, opt) => { seen = opt.headers.Authorization; return { status: 200, json: async () => ({ sessions: 5 }) }; };
  const ok = await gather([{ type: 'dashboard', paths: ['/api/ga4/summary'] }], { env: { MARKETING_FLEET_KEY: 'mkt_test' }, fetch: web, lint });
  assert.strictEqual(seen, 'Bearer mkt_test');
  assert.match(ok.got[0].text, /"sessions":5/);
});

// ------------------------------------------------------------- the eight agents (#1666 Scout) and the schedule

test('every agent folder loads, has a SKILL.md with a name and description, and no em dash', () => {
  const slugs = listAgents();
  assert.deepStrictEqual(slugs, ['bloggy-bob', 'citations', 'collateral-cadet', 'gbp', 'listings', 'monthly-report', 'paid-ads', 'scout', 'site-health']); // #1688 adds the Cadet
  for (const s of slugs) {
    const a = loadAgent(s);
    assert.match(a.skill, new RegExp(`^---\\nname: ${s}\\ndescription: .+\\n---`), s);
    assert.ok(a.name && a.job && a.cadence && Array.isArray(a.sources) && a.sources.length, s);
    assert.ok(!a.skill.includes(EM), `${s} SKILL.md has an em dash`);
  }
  assert.throws(() => loadAgent('../etc'), /bad agent name/);
});

test('schedule: Google Business daily; Mondays add Site Health and Paid Ads; 3rd, 15th, quarter starts', () => {
  assert.deepStrictEqual(dueAgents('2026-10-13'), ['gbp']);                         // Tuesday
  assert.deepStrictEqual(dueAgents('2026-10-12'), ['gbp', 'site-health', 'paid-ads', 'scout']); // Monday (#1666 adds the Scout)
  assert.ok(dueAgents('2026-11-03').includes('monthly-report'));
  assert.ok(dueAgents('2026-10-15').includes('citations'));
  assert.ok(dueAgents('2027-01-04').includes('listings'));                          // first Monday of a quarter
  assert.ok(!dueAgents('2027-01-11').includes('listings'));
  for (const d of ['2026-10-12', '2026-11-03', '2027-01-04']) assert.ok(!dueAgents(d).includes('bloggy-bob'));
});

test('job: --dry writes nothing and prints the cards; no database and no --dry refuses to run', async () => {
  const lines = [];
  const code = await main({ argv: ['paid-ads', '--dry'], log: (l) => lines.push(l), llm: null, env: {} });
  assert.strictEqual(code, 0);
  assert.match(lines.join('\n'), /could not run/);
  const out = [];
  assert.strictEqual(await main({ argv: ['site-health'], log: (l) => out.push(l), llm: null, env: {} }), 3);
  assert.match(out.join('\n'), /NOT RUN: MARKETING_DATABASE_URL/);
});
