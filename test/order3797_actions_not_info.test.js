'use strict';
// ORDER #3797 (Mimi 11.24.2026, after working with Katherine): marketing agent
// cards are ACTIONS, not information. Every Review card leads with ONE plain
// action line saying what Approve will do; the detail is folded below; the
// action line and the "Approve will:" line (#3570) agree; a report card says
// there is nothing to approve; "reads like AI" says WHERE and WHAT with a
// replacement, never a bare count; an approved card shows its result.
//
// Each guard is shown refusing something wrong (iron rule 14).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createMemoryStore } = require('../lib/agent-store');
const { createReviewRouter } = require('../routes/review');
const { lint } = require('../lib/ai-tells');
const AW = require('../lib/approve-will');
const CA = require('../lib/card-action');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');

const POST_MD = Array.from({ length: 1000 }, (_, i) => (i % 12 === 11 ? 'dinner.\n\n' : 'rehearsal')).join(' ');
const KINDS = {
  plain: { agent: 'gbp', agent_name: 'Google Business', title: 'Reply draft: Sarah K', status: 'draft' },
  post: { agent: 'bloggy-bob', agent_name: 'Bloggy Bob', title: 'Blog draft', status: 'draft', payload: { post: { site: 'TBB', title: 'Rehearsal dinners at TBB', content_md: POST_MD } } },
  pin: { agent: 'pinterest-paul', agent_name: 'Pinterest Paul', title: 'Pin', status: 'draft', payload: { pin: { board: 'Barn Weddings', title: 'Barn at dusk', description: 'd' } } },
  sales: { agent: 'convention-connector', agent_name: 'Convention Charles', title: 'Lead', status: 'draft', payload: { sales: { company: 'Acme Assoc', subject: 'Hello', email: 'Hi there.' } } },
  topics: { agent: 'keyword-queen', agent_name: 'Keyword Queen', title: 'Topics', status: 'draft', payload: { topics: [{ n: 1 }, { n: 2 }, { n: 3 }] } },
  tell: { agent: 'ai-tell-hunt', agent_name: 'AI Tell Detective', title: 'Proposed tell: "truly"', status: 'draft', payload: { ai_tell: { key: 'k', proposal: {} } } },
  report: { agent: 'site-health', agent_name: 'Site Health', title: 'Site health this week', status: 'draft' },
};

// ---------- the action line ----------

test('the order\'s own example: a blog card leads with "Save a 1,000-word blog post ... to TBB"', () => {
  const a = CA.actionLine(KINDS.post);
  assert.strictEqual(a.line, 'Save a 1,000-word blog post "Rehearsal dinners at TBB" to TBB as an unpublished WordPress draft.');
  assert.strictEqual(a.info_only, false);
});

test('every card kind gets one action line, and it agrees with the Approve will: line', () => {
  for (const [k, c] of Object.entries(KINDS)) {
    const a = CA.actionLine(c);
    assert.ok(a.line && !a.line.includes('\n'), `${k}: one line`);
    assert.ok(CA.agrees(c), `${k}: action line and Approve will: agree`);
    assert.strictEqual(a.kind, AW.approveWill(c).kind, k);
  }
  assert.match(CA.actionLine(KINDS.pin).line, /^Queue the pin "Barn at dusk" for the Barn Weddings board/);
  assert.match(CA.actionLine({ ...KINDS.sales, mary: { state: 'waiting' } }).line, /^Send Acme Assoc to Mary Topp's Sales Hand-off desk/);
  assert.match(CA.actionLine({ ...KINDS.sales, sales_owner: 'No salesperson set yet' }).line, /^Keep Acme Assoc in Ready/);
  assert.match(CA.actionLine({ ...KINDS.sales, sales_owner: 'Cameron Creasy' }).line, /^Make one HubSpot task for Cameron Creasy to email Acme Assoc\./);
  assert.match(CA.actionLine(KINDS.topics).line, /^File 3 blog topic ideas/);
  assert.match(CA.actionLine(KINDS.plain).line, /^Mark "Reply draft: Sarah K" ready for you to use\. Nothing is posted or sent\.$/);
});

test('KNOWN-BAD: a report card is never dressed up as an action', () => {
  const a = CA.actionLine(KINDS.report);
  assert.strictEqual(a.info_only, true);
  assert.match(a.line, /^Nothing to approve: "Site health this week" is information only/);
  assert.strictEqual(AW.approveWill(KINDS.report).got_it, true, 'and it shows Got it, not Approve');
  // a report agent's card WITH a payload is an action again
  assert.strictEqual(CA.actionLine({ ...KINDS.report, payload: { post: { site: 'x', content_md: 'y' } } }).info_only, false);
});

// ---------- reads like AI: where and what ----------

test('an AI tell names its place, quotes the words and suggests a replacement', () => {
  const body = '## Why the rooftop works\n\nThe view is wide.\n\nThe skyline view is breathtaking at night.';
  const d = CA.tellsDetail({ title: 'Rooftop', body });
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].where, 'Card text, under "Why the rooftop works", paragraph 2');
  assert.strictEqual(d[0].quote, 'breathtaking');
  assert.match(d[0].fix, /Say "striking" instead of "breathtaking"/);
});

test('an em dash is quoted with its words and the line comes back without it', () => {
  const d = CA.tellsDetail({ title: 'x', body: 'Plain line.', payload: { post: { site: 'TBB', content_md: 'Intro.\n\nDinner starts at six — then toasts begin.' } } });
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].where, 'Blog post, paragraph 2');
  assert.match(d[0].quote, /six — then/);
  assert.strictEqual(d[0].blocks_ready, true);
  assert.match(d[0].fix, /^Write it as ".*six, then toasts begin\."\.$/);
});

test('KNOWN-BAD: a clean card has no tells list, and no hit is ever a bare count', () => {
  assert.deepStrictEqual(CA.tellsDetail({ title: 'Plain', body: 'Dinner is at six.' }), []);
  const d = CA.tellsDetail({ title: 'A', body: 'A stunning room.\n\nA stunning view.\n\nIt boasts a bar.' });
  assert.ok(d.length >= 2);
  for (const h of d) {
    assert.ok(h.where && h.quote && h.fix, 'where, what and a fix on every hit');
    assert.doesNotMatch(h.quote, /^AI-tells/);
  }
  assert.ok(d.some((h) => /stunning \(2 times\)/.test(h.quote) && /paragraph 1/.test(h.where)));
});

test('the appended sections the Box writes under a card are not checked as the agent\'s words', () => {
  const d = CA.tellsDetail({ title: 'x', body: 'Dinner is at six.\n\n### Sources unavailable this run\n\nThe realm of x.' });
  assert.deepStrictEqual(d, []);
});

// ---------- the route ----------

function serve(app, t) {
  return new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
}
function get(server, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

test('the Review route sends action and tells_detail on every card, any status', async (t) => {
  const s = createMemoryStore({ lint });
  const a = await s.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'Reply draft', body: 'Our team will delve into it.' });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.mktUser = { email: 'k@x' }; next(); });
  app.use(createReviewRouter({ store: s }));
  const srv = await serve(app, t);
  const c = (await get(srv, '/api/review/cards')).cards.find((x) => x.id === a.id);
  assert.match(c.action.line, /^Mark "Reply draft" ready/);
  assert.strictEqual(c.tells_detail[0].quote, 'delve');
  await s.decide(a.id, { action: 'approve', who: 'k@x' });
  const ready = (await get(srv, '/api/review/cards?status=ready')).cards.find((x) => x.id === a.id);
  assert.ok(ready.action, 'a decided card keeps its action line');
});

// ---------- the page ----------

function renderers() {
  const start = HTML.indexOf('  const esc = ');
  const end = HTML.indexOf('  let cache = [];');
  assert.ok(start > 0 && end > start);
  const ctx = vm.createContext({});
  vm.runInContext(`${HTML.slice(start, end)}; this.cardHtml = cardHtml;`, ctx);
  return ctx;
}
const base = (extra) => ({ id: 1, status: 'draft', agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'A draft', body: 'Body text here.', sources: [{ label: 'Reviews', ok: true }], checks: {}, payload: null, handoff: null, ...extra });
const shaped = (c) => ({ ...c, approve_will: AW.approveWill(c), action: CA.actionLine(c), tells_detail: CA.tellsDetail(c) });

test('the card leads with the action line; sources and body are folded below it', () => {
  const { cardHtml } = renderers();
  const html = cardHtml(shaped(base({ payload: KINDS.post.payload, agent: 'bloggy-bob' })));
  const action = html.indexOf('<p class="action"');
  const title = html.indexOf('<h3');
  const fold = html.indexOf('<details class="detail">');
  const body = html.indexOf('<div class="body">');
  assert.ok(action > 0 && action < title, 'action line comes before the title');
  assert.ok(fold > title && body > fold, 'the body sits inside the folded Details');
  assert.ok(html.indexOf('Sources:') > fold, 'sources are folded too');
  assert.match(html, /<strong>Action:<\/strong> Save a 1,000-word blog post/);
});

test('KNOWN-BAD: a card without an action line (an old page answer) is not folded shut', () => {
  const { cardHtml } = renderers();
  const html = cardHtml(base({}));
  assert.match(html, /<details class="detail" open>/);
  assert.doesNotMatch(html, /<p class="action"/);
});

test('a report card says "No action", never "Action"', () => {
  const { cardHtml } = renderers();
  const html = cardHtml(shaped(base({ agent: 'site-health' })));
  assert.match(html, /<strong>No action:<\/strong> Nothing to approve/);
  assert.doesNotMatch(html, /<strong>Action:<\/strong>/);
});

test('the AI tells list shows where, the quoted words and the fix', () => {
  const { cardHtml } = renderers();
  const html = cardHtml(shaped(base({ body: 'The view is breathtaking.' })));
  assert.match(html, /Reads like AI: 1 spot to fix/);
  assert.match(html, /Card text, paragraph 1<\/span>: "breathtaking"\. Say &quot;striking&quot; instead of &quot;breathtaking&quot;\./);
});

test('an approved plain card shows its result; a post, pin or sales card keeps its own result line', () => {
  const { cardHtml } = renderers();
  const html = cardHtml(shaped(base({ status: 'ready', decided_by: 'k@x', decided_at: '2026-11-25T16:00:00Z' })));
  assert.match(html, /<span class="badge good">Result<\/span> Filed 11\.25\.2026/);
  const post = cardHtml(shaped(base({ status: 'ready', agent: 'bloggy-bob', payload: KINDS.post.payload })));
  assert.doesNotMatch(post, /class="meta result"/, 'the WordPress line is the result for a post');
  assert.doesNotMatch(cardHtml(shaped(base({}))), /class="meta result"/, 'KNOWN-BAD: a draft has no result yet');
});
