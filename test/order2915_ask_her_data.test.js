'use strict';
// ORDER #2915: Katherine asks a question about her own team's data on /agents
// and gets a plain answer with links to the cards it used. Read only; answers
// come only from the store (her team's cards and runs), never the web.
// Fixture store, a fixed clock: Wednesday 11.04.2026 noon in Nashville.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { answer, windowOf } = require('../lib/ask-data');
const { createAgentsRouter } = require('../routes/agents');

const NOW = new Date('2026-11-04T18:00:00Z'); // 12:00 CST
const K = 'katherine@infinityhospitality.net';
const at = (ymd, hh = '17:00') => new Date(`${ymd}T${hh}:00Z`);
const MEMBERS = [
  { slug: 'scout', name: 'Scout', default_name: 'Scout' },
  { slug: 'gbp', name: 'Google Business', default_name: 'Google Business' },
  { slug: 'pr-patty', name: 'PR Patty', default_name: 'PR Patty' },
];

async function fixture() {
  const store = createMemoryStore({ lint });
  const add = (c) => store.insert({ job: 'x', body: 'Body.', agent_name: c.agent, ...c });
  // Scout: two made last week (one still waiting, one approved), one this week, one the week before.
  await add({ agent: 'scout', title: 'Rival A raised prices', created_at: at('2026-10-27') });
  await add({ agent: 'scout', title: 'Rival B new venue', created_at: at('2026-10-29'), status: 'ready', decided_by: K, decided_at: at('2026-10-30') });
  await add({ agent: 'scout', title: 'Rival C open house', created_at: at('2026-11-03') });
  await add({ agent: 'scout', title: 'Rival D old news', created_at: at('2026-10-20'), status: 'rejected', reason: 'old', decided_by: K, decided_at: at('2026-10-21') });
  // Google Business: two waiting, one approved by Katherine this month.
  await add({ agent: 'gbp', title: 'Reply to Ana', created_at: at('2026-11-02') });
  await add({ agent: 'gbp', title: 'Reply to Ben', created_at: at('2026-11-02') });
  await add({ agent: 'gbp', title: 'Reply to Cara', created_at: at('2026-11-01'), status: 'ready', decided_by: K, decided_at: at('2026-11-03') });
  // PR Patty: approved by Katherine on the 1st, and one approved by someone else.
  await add({ agent: 'pr-patty', title: 'Pitch to the Scene', created_at: at('2026-10-31'), status: 'ready', decided_by: K, decided_at: at('2026-11-01', '16:00') });
  await add({ agent: 'pr-patty', title: 'Pitch to the Banner', created_at: at('2026-10-31'), status: 'ready', decided_by: 'mimi@infinityhospitality.net', decided_at: at('2026-11-02') });
  // The digest never counts.
  await add({ agent: 'digest', title: 'Monday digest', created_at: at('2026-11-02') });
  store.runList.push({ id: 1, agent: 'scout', status: 'done', cards: 2, started_at: at('2026-10-26', '14:00') });
  store.runList.push({ id: 2, agent: 'scout', status: 'done', cards: 1, started_at: at('2026-11-02', '14:00') });
  return store;
}

const ask = async (store, question, who = K) => answer({ question, store, members: MEMBERS, who, now: NOW });

test('the two example questions return the right counts, with links to the cards used', async () => {
  const store = await fixture();
  const w = await ask(store, 'how many drafts are waiting');
  assert.strictEqual(w.understood, true);
  assert.match(w.answer, /^4 drafts are waiting\./);
  assert.match(w.answer, /Scout 2/);
  assert.match(w.answer, /Google Business 2/);
  assert.strictEqual(w.cards.length, 4);
  assert.ok(w.cards.every((c) => c.status === 'waiting' && /^\/review\?status=draft#card-\d+$/.test(c.link)));
  assert.ok(!w.cards.some((c) => c.title === 'Monday digest'));

  const s = await ask(store, 'what did Scout find last week');
  assert.strictEqual(s.understood, true);
  assert.deepStrictEqual(s.window, { from: '2026-10-26', to: '2026-11-01', label: 'last week' });
  assert.strictEqual(s.answer, 'Scout made 2 cards last week: 1 waiting, 1 approved.');
  assert.deepStrictEqual(s.cards.map((c) => c.title).sort(), ['Rival A raised prices', 'Rival B new venue']);
  assert.ok(s.cards.find((c) => c.title === 'Rival B new venue').link.startsWith('/review?status=ready#card-'));
});

test('which cards did I approve this month: hers only, decided this month', async () => {
  const store = await fixture();
  const r = await ask(store, 'which cards did I approve this month');
  assert.strictEqual(r.answer, 'You approved 2 cards this month.');
  assert.deepStrictEqual(r.cards.map((c) => c.title), ['Reply to Cara', 'Pitch to the Scene']);
  const team = await ask(store, 'what was approved this month');
  assert.strictEqual(team.answer, 'Your team approved 3 cards this month.');
});

test('rejections and runs', async () => {
  const store = await fixture();
  assert.strictEqual((await ask(store, 'what did I reject last month')).answer, 'You rejected 1 card last month.');
  const run = await ask(store, 'when did Scout last run');
  assert.match(run.answer, /^Scout last ran 11\.02\.2026, 8:00 AM and made 1 card\.$/);
  assert.strictEqual(run.runs.length, 2);
  assert.match((await ask(store, 'when did PR Patty last run')).answer, /PR Patty has not run/);
});

test('a question it cannot answer says so and says what it can answer instead', async () => {
  const store = await fixture();
  for (const q of ["what's the weather in Nashville", 'who won the game', '']) {
    const r = await ask(store, q);
    assert.strictEqual(r.understood, false, q);
    assert.ok(r.can_answer.length >= 3, q);
    assert.deepStrictEqual(r.cards, []);
  }
  const r = await ask(store, 'who won the game');
  assert.match(r.answer, /can't answer that from your team's cards and runs/);
  assert.ok(r.can_answer.includes('How many drafts are waiting?'));
});

test('windows are Nashville dates; weeks start Monday', () => {
  assert.deepStrictEqual(windowOf('this week', '2026-11-04'), { from: '2026-11-02', to: '2026-11-04', label: 'this week' });
  assert.deepStrictEqual(windowOf('last month', '2026-11-04'), { from: '2026-10-01', to: '2026-10-31', label: 'last month' });
  assert.deepStrictEqual(windowOf('last 7 days', '2026-11-04'), { from: '2026-10-29', to: '2026-11-04', label: 'in the last 7 days' });
  assert.strictEqual(windowOf('how many drafts', '2026-11-04'), null);
});

// ---- the route -----------------------------------------------------------
function serve(a, t) {
  return new Promise((resolve) => {
    const srv = http.createServer(a).listen(0, () => {
      t.after(() => srv.close());
      const port = srv.address().port;
      resolve(async (url, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, json: await r.json() };
      });
    });
  });
}
function appFor(store, who = K) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { if (who) req.mktUser = { email: who }; next(); });
  a.use(createAgentsRouter({ store, clock: () => NOW }));
  return a;
}

// Every store method the answer may call. Anything else (insert, decide, queue…) is a write.
const READS = new Set(['list', 'runHistory', 'profiles']);

test('read only: the route calls nothing on the store but reads, and no row changes', async (t) => {
  const store = await fixture();
  const before = JSON.stringify({ cards: store.cards, runs: store.runList, requests: store.requests, asks: store.asks, settings: store.settings });
  const called = new Set();
  const spy = new Proxy(store, { get(o, k) {
    const v = o[k];
    if (typeof v !== 'function') return v;
    return (...args) => { called.add(k); if (!READS.has(k)) throw new Error(`write attempted: ${String(k)}`); return v.apply(o, args); };
  } });
  const post = await serve(appFor(spy), t);
  for (const question of ['how many drafts are waiting', 'what did Scout find last week', 'which cards did I approve this month',
    'what did I reject last week', 'when did Scout last run', 'what is the weather']) {
    const r = await post('/api/team/question', { question });
    assert.strictEqual(r.status, 200, question);
  }
  assert.ok([...called].every((k) => READS.has(k)), [...called].join(','));
  assert.ok(called.has('list'));
  assert.strictEqual(JSON.stringify({ cards: store.cards, runs: store.runList, requests: store.requests, asks: store.asks, settings: store.settings }), before);
});

test('the route answers the example over HTTP; signed out is refused', async (t) => {
  const store = await fixture();
  const post = await serve(appFor(store), t);
  const r = await post('/api/team/question', { question: 'how many drafts are waiting' });
  assert.strictEqual(r.status, 200);
  assert.match(r.json.answer, /^4 drafts are waiting/);
  const out = await serve(appFor(store, null), t);
  assert.strictEqual((await out('/api/team/question', { question: 'how many drafts are waiting' })).status, 403);
});

test('no order numbers on anything she sees', async () => {
  const store = await fixture();
  for (const q of ['how many drafts are waiting', 'what did Scout find last week', 'which cards did I approve this month', 'nonsense']) {
    const r = await ask(store, q);
    const shown = [r.answer, ...(r.can_answer || []), ...r.cards.map((c) => `${c.title} ${c.member} ${c.status}`)].join(' ');
    assert.doesNotMatch(shown, /#\d|\border\b/i, q);
  }
  // The page's visible strings for the box (comments aside) carry no order number.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
  const box = html.slice(html.indexOf('function questionHtml'), html.indexOf('async function askTeam'));
  assert.doesNotMatch(box, /#\d{3,}/);
  assert.match(box, /Ask about your team/);
  assert.match(box, /Nothing is changed by asking/);
});

test('nothing in the answerer reaches the web or a model', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ask-data.js'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|https?:\/\/|require\(['"](node:)?https?['"]\)|anthropic|complete\(/i);
});
