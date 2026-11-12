'use strict';
// ORDER #2914: Katherine pushes back on one draft card ("this missed X", "redo
// it this way") and the same agent drafts ONE revised card for that item,
// through the same queue as Run now. The revised card names the original; the
// original is kept (rejected with her words), never deleted. Memory store, a
// fake model and a web that refuses every call: nothing goes out.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore, SCHEMA_SQL } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');
const { takeAndRun } = require('../jobs/agent_requests');
const { createAgentsRouter, REDO_MESSAGE } = require('../routes/agents');

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt2914-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = path.join(root, '07_Marketing_and_Brand', 'Venue_Review_Pulse_2026-10.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '# Review pulse 10.2026\n- The Bridge Building, Google, Ana P.: "Lovely night."');
  return { IHG_TREE: root };
}
function model(cards) {
  const calls = [];
  return { model: 'fake', calls, async complete(req) { calls.push(req); return JSON.stringify({ cards: cards(req) }); } };
}
function web() {
  const calls = [];
  const f = async (url) => { calls.push(String(url)); throw new Error('no network in this test'); };
  f.calls = calls;
  return f;
}
// #2977 made the Concierge's required source the live Google API (gbp_reviews), which this
// no-network test cannot reach. Like #1758's runs (#2977), keep gbp's REAL definition and
// swap only its sources for the pulse fixture above.
const gbpDef = () => ({ ...loadAgent('gbp'), sources: [{ type: 'file', newest: '07_Marketing_and_Brand/Venue_Review_Pulse_', required: true, label: 'the newest review pulse' }] });
const SEEN = { venue: 'The Bridge Building', reviewer: 'Ana P.', platform: 'Google', review_text: 'Lovely night.' };
const first = [{ title: 'Reply to Ana P. on Google', target: 'The Bridge Building', body: 'Thank you, Ana. We loved hosting you.', seen: SEEN }];
const revised = [{ title: 'Reply to Ana P. on Google (warmer)', target: 'The Bridge Building', body: 'Ana, thank you for the lovely words about your night on the rooftop.', seen: SEEN }];

function serve(app, t) {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, () => {
      t.after(() => srv.close());
      const port = srv.address().port;
      resolve(async (url, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, json: await r.json() };
      });
    });
  });
}
function app(store) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.mktUser = { email: 'katherine@infinityhospitality.net' }; next(); });
  a.use(createAgentsRouter({ store }));
  return a;
}

test('a redo on card N queues one run whose ask carries N\'s title and her words; the new card names N; N is kept', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t);
  const fetchImpl = web();
  const r1 = await runAgent({ def: gbpDef(), store, llm: model(() => first), env, fetchImpl, scheduled: true });
  assert.ok(r1.ok, r1.error);
  const n = r1.cards[0];

  const post = await serve(app(store), t);
  const out = await post(`/api/agents/gbp/cards/${n.id}/redo`, { words: 'This missed the rooftop. Make it warmer.' });
  assert.strictEqual(out.status, 200, JSON.stringify(out.json));
  assert.strictEqual(out.json.message, 'Redo asked. The new version lands here within about 15 minutes.');
  assert.strictEqual(store.requests.length, 1, 'exactly one queued run');
  const q = store.requests[0];
  assert.strictEqual(q.agent, 'gbp');
  assert.strictEqual(q.from_card, n.id);
  assert.match(q.ask, /Reply to Ana P\. on Google/, 'the ask carries the card title');
  assert.match(q.ask, /This missed the rooftop\. Make it warmer\./, 'the ask carries her words');
  assert.strictEqual(q.requested_by, 'katherine@infinityhospitality.net');

  // The same card again while one is waiting: refused, still one queued run.
  const again = await post(`/api/agents/gbp/cards/${n.id}/redo`, { words: 'and shorter' });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(store.requests.length, 1);
  // A waiting redo does not block an ordinary Run now.
  assert.ifError((await store.queueRun('gbp', null, 'katherine@infinityhospitality.net')).error);
  store.requests.pop();

  // The 15-minute job takes it. Same review, so without the redo the seen-skip would drop it.
  const llm = model(() => revised);
  await takeAndRun({ store, env: {}, log: () => {}, runOne: (slug, ask, o) => runAgent({ def: slug === 'gbp' ? gbpDef() : undefined, slug, store, llm, ask, env, fetchImpl, redoOf: o.redoOf }) });
  assert.strictEqual(q.status, 'done', q.note);
  assert.match(llm.calls[0].user, /REDO ONE CARD[\s\S]*Make it warmer/);
  assert.match(llm.calls[0].user, /Write at most 1 card/);
  const fresh = store.cards.find((c) => c.redo_of === n.id);
  assert.ok(fresh, 'a revised card that names the original');
  assert.strictEqual(fresh.agent, 'gbp');
  assert.strictEqual(fresh.status, 'draft', 'the revision is a draft');
  assert.match(fresh.body, /This replaces the draft "Reply to Ana P\. on Google"/);
  assert.strictEqual(store.cards.length, 2, 'one new card, nothing deleted');
  const orig = await store.get(n.id);
  assert.strictEqual(orig.status, 'rejected', 'the original is kept, rejected');
  assert.match(orig.reason, /^Redo asked: This missed the rooftop/);
  assert.strictEqual(orig.redo.new_card, fresh.id);
  assert.strictEqual(orig.body, n.body, 'the original text is untouched');
  assert.strictEqual(fetchImpl.calls.length, 0, 'nothing went out');
});

test('KNOWN-BAD: a redo on a card from another agent\'s slug is refused, and nothing is queued', async (t) => {
  const store = createMemoryStore({ lint });
  const c = await store.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'Reply draft', body: 'Thank you.' });
  const post = await serve(app(store), t);
  const out = await post(`/api/agents/pr-patty/cards/${c.id}/redo`, { words: 'redo it shorter' });
  assert.strictEqual(out.status, 400);
  assert.match(out.json.error, /another agent/);
  assert.strictEqual(store.requests.length, 0);
  assert.strictEqual((await store.get(c.id)).redo, undefined);
  // The runner refuses it too, should a mismatched request ever reach the queue.
  const r = await runAgent({ slug: 'pr-patty', store, llm: model(() => first), redoOf: c.id, fetchImpl: web() });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /another agent/);
  assert.strictEqual(store.cards.length, 1);
});

test('guards: no words, a non-draft card, an unknown card', async (t) => {
  const store = createMemoryStore({ lint });
  const c = await store.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'Reply draft', body: 'Thank you.' });
  const post = await serve(app(store), t);
  assert.strictEqual((await post(`/api/agents/gbp/cards/${c.id}/redo`, { words: '' })).status, 400);
  assert.strictEqual((await post('/api/agents/gbp/cards/999/redo', { words: 'redo it' })).status, 404);
  c.status = 'ready';
  assert.match((await post(`/api/agents/gbp/cards/${c.id}/redo`, { words: 'redo it' })).json.error, /only a draft/);
  assert.strictEqual(store.requests.length, 0);
});

test('schema is additive; the page says what happens next and shows no order numbers', () => {
  const add = SCHEMA_SQL.filter((q) => /redo/.test(q));
  assert.deepStrictEqual(add, ['ALTER TABLE agent_cards ADD COLUMN IF NOT EXISTS redo JSONB', 'ALTER TABLE agent_cards ADD COLUMN IF NOT EXISTS redo_of INTEGER']);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.ok(page.includes(REDO_MESSAGE), 'the card says what happens next');
  assert.match(page, /data-a="redo"/);
  // Visible text only: strip script comments and tags, then no "#2914" or "ORDER".
  const visible = page.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(visible, /#\d{3,}|ORDER/);
  const shown = page.match(/redo-note[^`]*`/);
  assert.ok(shown && !/#\d/.test(shown[0]));
});
