'use strict';
// ORDER #2993 (Mimi popups 11.05.2026): Katherine's handover reset. Every card
// made before HANDOVER_AT is a reference example: visible, openable, approvable,
// and never counted. With HANDOVER_AT unset, behavior is exactly as before.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../lib/handover');
const { createMemoryStore } = require('../lib/agent-store');
const { createReviewRouter } = require('../routes/review');
const { digestBody } = require('../lib/agent-digest');
const P = require('../lib/producer');
const W = require('../lib/reviewer-watch');
const { lint } = require('../lib/ai-tells');

const LINE = '2026-11-09T00:00:00-06:00';
const BEFORE = new Date('2026-11-05T15:00:00Z');
const AFTER = new Date('2026-11-09T15:00:00Z');

let saved;
beforeEach(() => { saved = process.env.HANDOVER_AT; delete process.env.HANDOVER_AT; });
afterEach(() => { if (saved === undefined) delete process.env.HANDOVER_AT; else process.env.HANDOVER_AT = saved; });

function storeAt(clock) { return createMemoryStore({ lint, now: () => clock.t }); }
async function seed() {
  const clock = { t: BEFORE };
  const s = storeAt(clock);
  const old1 = await s.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'old reply', body: 'Thank you for the kind words.' });
  const old2 = await s.insert({ agent: 'blog', agent_name: 'Bloggy Bob', job: 'post', title: 'old post', body: 'A post about fall weddings.' });
  const old3 = await s.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'old archived', body: 'Thanks again.' });
  old3.status = 'archived';
  clock.t = AFTER;
  const fresh = await s.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'new reply', body: 'We loved hosting you.' });
  await s.insert({ agent: 'digest', agent_name: 'Monday digest', job: 'weekly summary', title: 'digest', body: 'x' });
  return { s, old1, old2, old3, fresh };
}

test('the line: unset or unreadable means no handover; a card before it is a reference card', () => {
  assert.strictEqual(H.handoverAt({}), null);
  assert.strictEqual(H.handoverAt({ HANDOVER_AT: '  ' }), null);
  assert.strictEqual(H.handoverAt({ HANDOVER_AT: 'next monday' }), null, 'unreadable is treated as unset, never as a guess');
  const at = H.handoverAt({ HANDOVER_AT: LINE });
  assert.strictEqual(at.toISOString(), '2026-11-09T06:00:00.000Z', 'Nashville midnight');
  assert.strictEqual(H.isReference({ created_at: BEFORE }, at), true);
  assert.strictEqual(H.isReference({ created_at: AFTER }, at), false);
  assert.strictEqual(H.isReference({ created_at: at }, at), false, 'a card made exactly at the line counts');
  assert.strictEqual(H.isReference({ created_at: BEFORE }, null), false, 'no line, no reference cards');
});

test('ROLLBACK LEVER: with HANDOVER_AT unset every count is exactly as before', async () => {
  const { s } = await seed();
  assert.strictEqual(await s.draftsWaiting(), 3);
  assert.deepStrictEqual((await s.list({ status: 'draft' })).map((c) => c.title).filter((t) => t !== 'digest'), ['new reply', 'old post', 'old reply']);
  assert.deepStrictEqual(await s.referenceCards(), []);
  assert.strictEqual((await s.draftAges()).reduce((n, d) => n + d.n, 0), 3);
});

test('with HANDOVER_AT set: a card before the line is reference, after it counts', async () => {
  process.env.HANDOVER_AT = LINE;
  const { s, old1, old2, old3, fresh } = await seed();
  assert.strictEqual(await s.draftsWaiting(), 1, 'only the card made on/after 11.09 waits');
  assert.deepStrictEqual((await s.list({ status: 'draft' })).filter((c) => c.agent !== 'digest').map((c) => c.id), [fresh.id]);
  assert.deepStrictEqual((await s.draftAges()).map((d) => [d.agent, d.n]), [['gbp', 1]], 'the /agents board counts only after the line');
  const ref = (await s.referenceCards()).map((c) => c.id).sort();
  assert.deepStrictEqual(ref, [old1.id, old2.id, old3.id].sort(), 'reference = every status made before the line, digest left out');
  assert.ok(!ref.includes(fresh.id));
  // No card row was changed.
  assert.strictEqual(old1.status, 'draft'); assert.strictEqual(old3.status, 'archived');
  // Archived cards keep their own filter as before.
  assert.deepStrictEqual((await s.list({ status: 'archived' })).map((c) => c.id), [old3.id]);
});

test('the Producer hold releases: it reads the counted pile only', async () => {
  process.env.HANDOVER_AT = LINE;
  const clock = { t: BEFORE };
  const s = storeAt(clock);
  for (let i = 0; i < P.WAITING_HOLD + 5; i++) await s.insert({ agent: 'gbp', agent_name: 'G', job: 'j', title: `old ${i}`, body: 'b' });
  assert.strictEqual(await s.draftsWaiting(), 0);
  assert.strictEqual(P.decide({ agent: 'scout', waiting: await s.draftsWaiting(), used: 0, maxCards: 3 }).run, true, 'not held by old drafts');
  delete process.env.HANDOVER_AT;
  const n = await s.draftsWaiting();
  assert.strictEqual(n, P.WAITING_HOLD + 5);
  assert.strictEqual(P.decide({ agent: 'scout', waiting: n, used: 0, maxCards: 3 }).run, false, 'unset: held exactly as today');
});

test('the Monday digest pile leaves out reference cards', async () => {
  process.env.HANDOVER_AT = LINE;
  const { s } = await seed();
  const stats = await s.weekStats();
  const body = digestBody(stats, new Map([['gbp', 'Google Business'], ['blog', 'Bloggy Bob']]));
  assert.match(body, /\*\*1 draft waiting for review\*\*/);
});

test('Approve on a reference card works, is logged, and still never counts', async () => {
  process.env.HANDOVER_AT = LINE;
  const { s, old1 } = await seed();
  const out = await s.decide(old1.id, { action: 'approve', who: 'katherine@infinityhospitality.net' });
  assert.ifError(out.error);
  assert.strictEqual(out.card.status, 'ready');
  assert.strictEqual(out.card.decided_by, 'katherine@infinityhospitality.net', 'logged against the person');
  assert.ok(out.card.decided_at);
  assert.strictEqual(await s.draftsWaiting(), 1, 'the counted pile is unchanged');
  assert.ok((await s.referenceCards()).some((c) => c.id === old1.id), 'still listed as a reference example');
  // The reviewer facts leave it out of the counted week.
  const sc = W.scorecard({ dept: W.department('marketing'), now: new Date('2026-11-16T15:00:00Z'), handoverAt: H.handoverAt(),
    rows: { cards: [{ ...old1, decided_at: '2026-11-10T15:00:00Z' }], runs: [], asks: [], settings: [], visits: [] } });
  assert.strictEqual(sc.week.approved, 0, 'approving a reference card is not counted');
  assert.strictEqual(sc.week.before_handover, false);
});

test('reviewer facts: the first counted week is 11.09; earlier weeks keep their numbers, labeled Before handover; visits from 11.09', () => {
  const at = H.handoverAt({ HANDOVER_AT: LINE });
  const dept = W.department('marketing');
  const old = { id: 1, agent: 'gbp', title: 't', status: 'ready', decided_by: 'katherine@infinityhospitality.net', created_at: '2026-11-03T15:00:00Z', decided_at: '2026-11-04T15:00:00Z' };
  const draftOld = { id: 2, agent: 'gbp', title: 'old draft', status: 'draft', created_at: '2026-11-03T15:00:00Z' };
  const draftNew = { id: 3, agent: 'gbp', title: 'new draft', status: 'draft', created_at: '2026-11-10T15:00:00Z' };
  const visits = [{ dept: 'marketing', page: '/review', email: 'katherine@infinityhospitality.net', at: '2026-11-06T15:00:00Z' }];
  const rows = { cards: [old, draftOld, draftNew], runs: [], asks: [], settings: [], visits };
  // The week of 11.02 ended at the line: its own numbers, labeled.
  const before = W.scorecard({ dept, rows, now: new Date('2026-11-09T15:00:00Z'), handoverAt: at });
  assert.strictEqual(before.week_start, '2026-11-02');
  assert.strictEqual(before.week.before_handover, true);
  assert.strictEqual(before.week.approved, 1, 'an earlier week stays viewable with its own numbers');
  assert.match(W.renderMarkdown([before]), /Before handover: this week ended before the handover/);
  // The week of 11.09 is the first counted week.
  const first = W.scorecard({ dept, rows, now: new Date('2026-11-16T15:00:00Z'), handoverAt: at });
  assert.strictEqual(first.week_start, '2026-11-09');
  assert.strictEqual(first.week.before_handover, false);
  assert.strictEqual(first.prior.before_handover, true);
  assert.strictEqual(first.now.drafts_waiting, 1, 'only the draft made after the line waits');
  assert.deepStrictEqual(first.now.oldest_untouched.map((u) => u.id), [3]);
  assert.strictEqual(first.now.visits_recorded, false, 'a visit before 11.09 is not counted');
  const md = W.renderMarkdown([first]);
  assert.match(md, /Counted from the handover on 11\.09\.2026/);
  assert.match(md, /prior-week numbers are before handover/);
  assert.deepStrictEqual(W.labelWords(md), [], 'still facts only');
  // Unset: exactly as before.
  const off = W.scorecard({ dept, rows, now: new Date('2026-11-16T15:00:00Z'), handoverAt: null });
  assert.strictEqual(off.now.drafts_waiting, 2);
  assert.strictEqual(off.handover_at, null);
  assert.doesNotMatch(W.renderMarkdown([off]), /handover/i);
});

function serve(app, t) {
  return new Promise((resolve) => { const s = http.createServer(app).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
}
function call(server, p, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
async function app(t, s) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.mktUser = { email: 'katherine@infinityhospitality.net' }; next(); });
  a.use(createReviewRouter({ store: s }));
  return serve(a, t);
}

test('the Review route: reference tab grouped by agent newest first; Drafts shows only the counted pile; Approve works on a reference card', async (t) => {
  process.env.HANDOVER_AT = LINE;
  const { s, old1, old2, old3, fresh } = await seed();
  const srv = await app(t, s);
  const h = await call(srv, '/api/review/handover');
  assert.strictEqual(h.json.on, true);
  assert.strictEqual(h.json.header, "What each agent can do. These don't count toward your pile.");
  const ref = await call(srv, '/api/review/cards?status=reference');
  assert.strictEqual(ref.status, 200);
  assert.strictEqual(ref.json.header, H.REFERENCE_HEADER);
  assert.ok(ref.json.cards.every((c) => c.reference === true));
  const groups = Object.fromEntries(ref.json.groups.map((g) => [g.agent, g.ids]));
  assert.deepStrictEqual(groups.gbp, [old3.id, old1.id], 'newest first inside the agent');
  assert.deepStrictEqual(groups.blog, [old2.id]);
  const drafts = await call(srv, '/api/review/cards');
  assert.deepStrictEqual(drafts.json.cards.filter((c) => c.agent !== 'digest').map((c) => c.id), [fresh.id]);
  const ok = await call(srv, `/api/review/cards/${old1.id}`, { method: 'POST', body: { action: 'approve' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.card.decided_by, 'katherine@infinityhospitality.net');
  assert.strictEqual(await s.draftsWaiting(), 1);
});

test('the Review route with HANDOVER_AT unset: no reference tab, Drafts as today', async (t) => {
  const { s } = await seed();
  const srv = await app(t, s);
  assert.strictEqual((await call(srv, '/api/review/handover')).json.on, false);
  assert.deepStrictEqual((await call(srv, '/api/review/cards?status=reference')).json.cards, []);
  assert.strictEqual((await call(srv, '/api/review/cards')).json.cards.filter((c) => c.agent !== 'digest').length, 3);
});

test('the page: the tab is hidden until the line is set, shows the header, and no order number', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.match(html, /<button data-s="reference" aria-pressed="false" id="refTab" hidden>Examples from before handover<\/button>/);
  assert.match(html, /\/api\/review\/handover/);
  assert.match(html, /approving one still works and is recorded, and it never counts/);
  const shown = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(shown, /2993/, 'no order number Katherine can see');
});

test('the pg store filters by created_at only when the line is set (no data rewrite)', async () => {
  const { createPgStore } = require('../lib/agent-store');
  if (!createPgStore) return;
  const seen = [];
  const pool = { query: async (sql, args) => { seen.push({ sql, args }); return { rows: [{ n: 0 }] }; } };
  const s = createPgStore(pool, { lint });
  await s.draftsWaiting(); await s.list({ status: 'draft' }); await s.weekStats();
  assert.ok(seen.every((q) => !/created_at >= \$/.test(q.sql)), 'unset: no new filter');
  assert.deepStrictEqual(await s.referenceCards(), []);
  seen.length = 0;
  process.env.HANDOVER_AT = LINE;
  await s.draftsWaiting(); await s.list({ status: 'draft' }); await s.list({ status: 'ready' }); await s.weekStats(); await s.referenceCards();
  assert.match(seen[0].sql, /created_at >= \$1/); assert.strictEqual(seen[0].args[0].toISOString(), '2026-11-09T06:00:00.000Z');
  assert.match(seen[1].sql, /created_at >= \$2/);
  assert.doesNotMatch(seen[2].sql, /created_at >=/, 'only Drafts is filtered; Ready lists as before');
  assert.match(seen[3].sql, /FROM agent_cards[\s\S]*created_at >= \$1/, 'the digest card counts');
  assert.doesNotMatch(seen[4].sql, /created_at/, 'the digest run counts are unchanged');
  assert.match(seen[5].sql, /created_at < \$1/);
  assert.ok(seen.every((q) => /^\s*SELECT/i.test(q.sql)), 'reads only, never an UPDATE');
});
