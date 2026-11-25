'use strict';
// ORDER #3826 (Mimi popup 11.25.2026, "Yes, top 5 daily"): "Katherine's Today"
// at the top of /review. At most 5 lines, each a card's action line (#3797)
// and its agent; ranked hard deadlines, then anything blocking a live thing,
// then the highest-payoff drafts (Search Console gaps first); a "why these"
// line; refreshed at 07:00 CT and again when a card is acted on; "Nothing
// needs you today." when clear.
//
// Each guard is shown refusing something wrong (iron rule 14).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const { createReviewRouter } = require('../routes/review');
const { lint } = require('../lib/ai-tells');
const CA = require('../lib/card-action');
const T = require('../lib/today-top5');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
// 11.25.2026 14:00 CT (UTC-6)
const NOW = new Date('2026-11-25T20:00:00Z');

let nextId = 1;
const card = (o) => ({ id: nextId++, status: 'draft', created_at: '2026-11-20T12:00:00Z', ...o });
const pitch = (due, o = {}) => card({ agent: 'pr-patty', agent_name: 'PR Patty', title: `Pitch Brides: winter venues, due ${due}`, ...o });
const post = (o = {}) => card({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', title: 'Blog draft', payload: { post: { site: 'TBB', title: 'Rehearsal dinners', content_md: 'one two three' } }, ...o });
const ad = (kinds) => card({ agent: 'paid-ads', agent_name: 'Paid Ads Auditor', title: 'Google Ads midday check: 1 new flag (2026-11-25)', payload: { ads_monitor: { keys: ['k'], kinds } } });
const report = (o = {}) => card({ agent: 'seo', agent_name: 'SEO', title: 'SEO this week', ...o });

// ---------- ranking ----------

test('deadlines first (soonest first), then a live blocker, then drafts', () => {
  const late = pitch('12.04.2026');
  const soon = pitch('11.27.2026');
  const blog = post();
  const broken = ad(['disapproved']);
  const out = T.today([blog, broken, late, soon], { now: NOW });
  assert.deepStrictEqual(out.items.map((i) => i.id), [soon.id, late.id, broken.id, blog.id]);
  assert.deepStrictEqual(out.items.map((i) => i.tier), [1, 1, 2, 3]);
  assert.strictEqual(out.items[0].deadline, '2026-11-27');
  assert.strictEqual(out.items[0].agent_name, 'PR Patty');
});

test('Gala Scout and Convention Charles count as deadlines; an undated assign sits after the dated ones', () => {
  const charles = card({ agent: 'convention-connector', agent_name: 'Convention Charles', title: 'Lead', payload: { sales: { company: 'Acme Assoc', email: 'Hi.' } }, sales_owner: 'Cameron Creasy' });
  const gala = card({ agent: 'gala-scout', agent_name: 'Gala Scout', title: 'Hope Gala 12.10.2026: pitch the ballroom' });
  const blocker = ad(['url']);
  const out = T.today([blocker, charles, gala], { now: NOW });
  assert.deepStrictEqual(out.items.map((i) => i.id), [gala.id, charles.id, blocker.id]);
});

test('KNOWN-BAD: a press deadline already past is not ranked as a deadline', () => {
  const missed = pitch('11.20.2026');
  const broken = ad(['paused']);
  const out = T.today([missed, broken], { now: NOW });
  assert.deepStrictEqual(out.items.map((i) => [i.id, i.tier]), [[broken.id, 2], [missed.id, 3]]);
});

test('drafts: a Search Console gap card beats a plain blog post; the bigger gap first', () => {
  const plainBlog = post({ created_at: '2026-11-01T00:00:00Z' });
  const small = post({ payload: { post: { site: 'TBB', content_md: 'x' }, gsc_gap: { query: 'a', impressions: 100 } } });
  const big = post({ payload: { post: { site: 'TBB', content_md: 'x' }, gsc_gap: { query: 'b', impressions: 900 } } });
  const named = post({ title: 'Blog draft from the Search Console content gap list' });
  const other = card({ agent: 'gbp', agent_name: 'Google Business', title: 'Reply draft' });
  const out = T.today([other, plainBlog, small, named, big], { now: NOW });
  assert.deepStrictEqual(out.items.map((i) => i.id), [big.id, small.id, named.id, plainBlog.id, other.id]);
});

test('at most 5 lines, and each line is the card\'s #3797 action line word for word', () => {
  const cards = Array.from({ length: 8 }, () => post());
  const out = T.today(cards, { now: NOW });
  assert.strictEqual(out.items.length, 5);
  for (const i of out.items) assert.strictEqual(i.line, CA.actionLine(cards.find((c) => c.id === i.id)).line);
});

test('KNOWN-BAD: information-only cards stay out; a blocking report says what to fix, never "Nothing to approve"', () => {
  const info = report();
  const digest = card({ agent: 'digest', title: 'Weekly', body: '**3 drafts waiting for review**' });
  const notBlocking = ad(['limited']);
  const broken = ad(['disapproved']);
  const guard = card({ agent: 'site-guardian', agent_name: 'Site Guardian', title: 'FLAGGED: tbb.com new admin' });
  const out = T.today([info, digest, notBlocking, broken, guard], { now: NOW });
  assert.deepStrictEqual(out.items.map((i) => i.id).sort(), [broken.id, guard.id].sort());
  for (const i of out.items) assert.doesNotMatch(i.line, /Nothing to approve/);
  assert.match(out.items.find((i) => i.id === broken.id).line, /^Fix in Google Ads .*a disapproved ad/);
  assert.match(out.items.find((i) => i.id === guard.id).line, /Night Watch alerts go to Mimi first/);
});

test('only Drafts count: a card acted on drops out and the next one moves up', () => {
  const a = pitch('11.26.2026');
  const b = pitch('11.28.2026');
  assert.strictEqual(T.today([a, b], { now: NOW }).items[0].id, a.id);
  const out = T.today([{ ...a, status: 'ready' }, b], { now: NOW });
  assert.deepStrictEqual(out.items.map((i) => i.id), [b.id]);
});

test('when she is clear: "Nothing needs you today."; fewer than 5 shows only those', () => {
  const none = T.today([report()], { now: NOW });
  assert.deepStrictEqual(none.items, []);
  assert.strictEqual(none.empty, 'Nothing needs you today.');
  const two = T.today([post(), post()], { now: NOW });
  assert.strictEqual(two.items.length, 2);
  assert.strictEqual(two.empty, null);
});

test('the day turns at 07:00 CT, and the next refresh is the next 07:00 CT', () => {
  assert.strictEqual(T.dayOf(new Date('2026-11-25T12:59:00Z')), '2026-11-24'); // 06:59 CT
  assert.strictEqual(T.dayOf(new Date('2026-11-25T13:00:00Z')), '2026-11-25'); // 07:00 CT
  assert.strictEqual(T.nextRefresh(NOW), '2026-11-26T13:00:00.000Z');
  assert.strictEqual(T.nextRefresh(new Date('2026-11-25T12:30:00Z')), '2026-11-25T13:00:00.000Z');
  // before 07:00 a deadline dated "today" by the calendar is still yesterday's Today's future
  const early = new Date('2026-11-26T11:00:00Z'); // 05:00 CT 11.26
  assert.strictEqual(T.today([pitch('11.25.2026')], { now: early }).items[0].tier, 1);
});

test('the why line says the rule, and no line carries an em dash or a dollar figure', () => {
  const out = T.today([pitch('11.27.2026'), ad(['disapproved']), post()], { now: NOW });
  assert.match(out.why, /deadlines first.*blocking a live thing.*Search Console/);
  for (const s of [out.why, out.empty || '', ...out.items.map((i) => i.line), T.NONE]) {
    assert.doesNotMatch(s, /—/);
    assert.doesNotMatch(s, /\$\d/);
  }
});

// ---------- the route and the page ----------

function serve(app, t) {
  return new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
}
function get(server, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    }).on('error', reject);
  });
}

test('GET /api/review/today ranks the live Drafts pile and drops a card once it is approved', async (t) => {
  const s = createMemoryStore({ lint });
  const blog = await s.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'blog', title: 'Blog draft', body: 'Plain words.', payload: { post: { site: 'TBB', title: 'Rehearsal dinners', content_md: 'one two' } } });
  const p = await s.insert({ agent: 'pr-patty', agent_name: 'PR Patty', job: 'haro', title: 'Pitch Brides: winter venues, due 12.31.2099', body: 'Plain words.' });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.mktUser = { email: 'khowe@infinityhospitality.net' }; next(); });
  app.use(createReviewRouter({ store: s }));
  const srv = await serve(app, t);
  const one = await get(srv, '/api/review/today');
  assert.strictEqual(one.status, 200);
  assert.deepStrictEqual(one.body.items.map((i) => i.id), [p.id, blog.id]);
  assert.match(one.body.items[1].line, /^Save a 2-word blog post "Rehearsal dinners" to TBB/);
  await s.decide(p.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
  const two = await get(srv, '/api/review/today');
  assert.deepStrictEqual(two.body.items.map((i) => i.id), [blog.id]);
});

test('KNOWN-BAD: /api/review/today refuses a request with no signed-in person', async (t) => {
  const s = createMemoryStore({ lint });
  const app = express();
  app.use(createReviewRouter({ store: s }));
  const srv = await serve(app, t);
  assert.strictEqual((await get(srv, '/api/review/today')).status, 403);
});

test('the page: a "Today" box above the list, lines that jump to their card, reloaded after an action and at 07:00 CT', () => {
  const box = HTML.indexOf('id="today"');
  assert.ok(box > 0, 'the Today box is on the page');
  assert.ok(box < HTML.indexOf('id="list"'), 'and it sits above the cards');
  assert.match(HTML, />Today</);
  assert.match(HTML, /\/api\/review\/today/);
  assert.match(HTML, /href="#card-\$\{/, 'each line links to its card');
  assert.match(HTML, /await loadToday\(\)/, 'reloaded after a card is acted on');
  assert.match(HTML, /next_refresh/, 'and again at the next 07:00 CT');
  assert.doesNotMatch(HTML.slice(box - 200, box + 400), /—/);
});
