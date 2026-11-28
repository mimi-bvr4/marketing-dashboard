'use strict';
// ORDER #3570 (Katherine 11.18.2026 via Mimi, "agreed, build it"): every Review
// card gets "Archive (no action)", and every card says in one plain line what
// Approve will do, from the card's actual next step in code. A card with no next
// step (a report, FYI or digest) shows "Got it" instead of Approve, which acts
// the same as Archive. Approve itself is unchanged.
//
// Each guard is shown refusing something wrong (iron rule 14).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createMemoryStore, decide } = require('../lib/agent-store');
const { createReviewRouter } = require('../routes/review');
const { lint } = require('../lib/ai-tells');
const AW = require('../lib/approve-will');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');

function store() { return createMemoryStore({ lint }); }
async function card(s, extra = {}) {
  return s.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'Reply draft: a venue', body: 'Thank you for the kind words.', ...extra });
}

// Every kind of card the agents produce, as the store holds it.
const KINDS = {
  plain: { agent: 'gbp', agent_name: 'Google Business' },
  post: { agent: 'bloggy-bob', agent_name: 'Bloggy Bob', payload: { post: { site: 'infinityhospitality.net', title: 'T', content_md: 'Post body.' } } },
  pin: { agent: 'pinterest-paul', agent_name: 'Pinterest Paul', payload: { pin: { board: 'Barn Weddings', title: 'Pin', description: 'd', image_url: 'https://x/i.jpg', link: 'https://x' } } },
  sales: { agent: 'convention-connector', agent_name: 'Convention Charles', payload: { sales: { company: 'Acme Assoc', subject: 'Hello', email: 'Hi there.' } } },
  topics: { agent: 'keyword-queen', agent_name: 'Keyword Queen', payload: { topics: [{ n: 1, topic: 'Barn weddings', keyword: 'barn wedding', venue: 'SWF' }] } },
  tell: { agent: 'ai-tell-hunt', agent_name: 'AI Tell Detective', payload: { ai_tell: { key: 'k', proposal: {} } } },
  report: { agent: 'site-health', agent_name: 'Site Health' },
  digest: { agent: 'digest', agent_name: 'Monday digest' },
};

// ---------- Archive: the store ----------

test('Archive moves a draft to Archived, records who and when, and touches nothing else', async () => {
  const s = store();
  const a = await card(s);
  const out = await s.decide(a.id, { action: 'archive', who: 'katherine@x' });
  assert.ifError(out.error);
  assert.strictEqual(out.card.status, 'archived');
  assert.strictEqual(out.card.decided_by, 'katherine@x');
  assert.ok(out.card.decided_at, 'when is recorded');
  assert.strictEqual(out.card.reason, null, 'not a rejection: no reason');
  assert.strictEqual(out.card.body, 'Thank you for the kind words.');
  assert.strictEqual(out.card.handoff, null, 'no handoff');
  assert.deepStrictEqual((await s.list({ status: 'archived' })).map((c) => c.id), [a.id], 'listed under Archived');
});

test('Archive leaves the backlog count down by one and the rejection stats unchanged', async () => {
  const s = store();
  const a = await card(s); await card(s, { title: 'second' }); const r = await card(s, { title: 'third' });
  await s.decide(r.id, { action: 'reject', reason: 'off brand', who: 'k@x' });
  const waiting = await s.draftsWaiting();
  const rejections = await s.lastRejections('gbp');
  const rejectedList = (await s.list({ status: 'rejected' })).map((c) => c.id);
  await s.decide(a.id, { action: 'archive', who: 'k@x' });
  assert.strictEqual(await s.draftsWaiting(), waiting - 1, 'an archived card is not waiting, so it never feeds the Producer hold');
  assert.deepStrictEqual(await s.lastRejections('gbp'), rejections, 'the agent is not taught "bad draft"');
  assert.deepStrictEqual((await s.list({ status: 'rejected' })).map((c) => c.id), rejectedList);
  const stats = (await s.weekStats()).cards.filter((x) => x.status === 'rejected');
  assert.deepStrictEqual(stats, [{ agent: 'gbp', status: 'rejected', n: 1 }]);
});

test('Archive triggers nothing: an archived card with a post, pin or Sales email is never handed off', async () => {
  const s = store();
  for (const k of ['post', 'pin', 'sales']) {
    const c = await card(s, KINDS[k]);
    await s.decide(c.id, { action: 'archive', who: 'k@x' });
  }
  assert.deepStrictEqual(await s.readyForHandoff(20), [], 'nothing for the Box to pin, post or send');
  assert.deepStrictEqual(await s.readyForHandoff(20, { viaMary: true }), []);
  assert.deepStrictEqual(await s.handoffDesk(), [], 'nothing on Mary\'s desk');
});

test('KNOWN-BAD: Archive is refused with no person, and on a card that is not a draft', async () => {
  const s = store();
  const a = await card(s);
  assert.match((await s.decide(a.id, { action: 'archive' })).error, /no person/);
  assert.strictEqual(a.status, 'draft');
  for (const st of ['ready', 'rejected', 'archived']) {
    a.status = st;
    assert.match((await s.decide(a.id, { action: 'archive', who: 'k@x' })).error, /only a draft/, st);
    assert.strictEqual(a.status, st, `${st} card left as it was`);
  }
});

test('an archived card can still be restored to Drafts', async () => {
  const s = store();
  const a = await card(s);
  await s.decide(a.id, { action: 'archive', who: 'k@x' });
  const out = await s.decide(a.id, { action: 'restore', who: 'k@x' });
  assert.strictEqual(out.card.status, 'draft');
});

// ---------- Approve is byte-identical ----------

test('Approve is unchanged: same fields for every kind of card, refused the same way', () => {
  for (const [k, extra] of Object.entries(KINDS)) {
    if (k === 'tell') continue; // the tell rule is its own (AI_TELL_HUNT) and is not touched
    const c = { id: 1, status: 'draft', title: 'A clean title', body: 'Clean body.', checks: {}, payload: null, ...extra };
    assert.deepStrictEqual(decide(c, { action: 'approve', who: 'k@x' }, lint), { fields: { status: 'ready', decided_by: 'k@x', reason: null } }, k);
    assert.deepStrictEqual(decide(c, { action: 'approve', who: 'k@x', reason: 'ok' }, lint), { fields: { status: 'ready', decided_by: 'k@x', reason: 'ok' } }, k);
  }
  const dash = { id: 1, status: 'draft', title: 'A title — with a dash', body: 'x', payload: null };
  assert.match(decide(dash, { action: 'approve', who: 'k@x' }, lint).error, /^Approve refused: /);
  assert.match(decide({ id: 1, status: 'archived', title: 't', body: 'b' }, { action: 'approve', who: 'k@x' }, lint).error, /archived; restore it/);
});

test('the page still posts Approve as exactly { action: "approve" }', () => {
  assert.ok(HTML.includes("if (b.dataset.a === 'approve') act({ action: 'approve' });"));
});

// ---------- Approve will ----------

test('every card kind gets an "Approve will:" line or a Got it button, never neither', () => {
  for (const [k, extra] of Object.entries(KINDS)) {
    const w = AW.approveWill({ status: 'draft', ...extra });
    assert.ok(w && (w.got_it === true || (typeof w.line === 'string' && w.line.length > 10)), k);
    if (w.got_it) assert.strictEqual(w.line, null, `${k}: Got it cards have no Approve line`);
  }
});

test('each line names the real next step', () => {
  const w = (extra, o) => AW.approveWill({ status: 'draft', ...extra }, o).line;
  assert.match(w(KINDS.post), /unpublished WordPress draft on infinityhospitality\.net/);
  assert.match(w(KINDS.post), /Nothing is published/);
  assert.match(w(KINDS.pin), /queue this pin for the Box's next run/);
  assert.match(w(KINDS.pin), /board Barn Weddings/);
  assert.match(w(KINDS.pin), /sandbox only until Pinterest grants Standard/);
  assert.match(w({ ...KINDS.sales, mary: { state: 'waiting', line: 'x' } }), /send this lead to Mary Topp's Sales Hand-off desk/);
  assert.match(w({ ...KINDS.sales, sales_owner: 'No salesperson set yet' }), /keep it in Ready/);
  assert.match(w({ ...KINDS.sales, sales_owner: 'Cameron Creasy' }), /one HubSpot task for Cameron Creasy with this email word for word, linked to Acme Assoc/);
  assert.match(w({ ...KINDS.sales, sales_owner: 'Cameron Creasy' }), /nothing is emailed from here/);
  assert.match(w(KINDS.topics), /file it as done/);
  assert.match(w(KINDS.topics), /Send button/);
  assert.match(w(KINDS.tell), /record your verdict only/);
  assert.match(w(KINDS.plain), /^file it as done/);
  assert.match(w(KINDS.plain), /Nothing is posted, sent or saved anywhere else/);
  for (const k of ['report', 'digest']) assert.strictEqual(AW.approveWill({ status: 'draft', ...KINDS[k] }).got_it, true, k);
});

test('KNOWN-BAD: a card with a payload is never a Got it card, whatever agent made it', () => {
  for (const k of ['post', 'pin', 'sales']) {
    const w = AW.approveWill({ status: 'draft', ...KINDS[k], agent: 'site-health' });
    assert.strictEqual(w.got_it, false, `${k} from a report agent still shows Approve`);
  }
});

test('no line on a card that is not a draft', () => {
  for (const st of ['ready', 'rejected', 'archived']) assert.strictEqual(AW.approveWill({ ...KINDS.plain, status: st }), null, st);
});

// ---------- the route ----------

function serve(app, t) {
  return new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
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

test('the Review route sends approve_will with each draft, and Archive records the person', async (t) => {
  const s = store();
  const a = await card(s); const r = await card(s, KINDS.report);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.mktUser = { email: 'Katherine@X' }; next(); });
  app.use(createReviewRouter({ store: s }));
  const srv = await serve(app, t);
  const drafts = (await call(srv, '/api/review/cards')).json.cards;
  assert.match(drafts.find((c) => c.id === a.id).approve_will.line, /^file it as done/);
  assert.strictEqual(drafts.find((c) => c.id === r.id).approve_will.got_it, true);
  const out = await call(srv, `/api/review/cards/${a.id}`, { method: 'POST', body: { action: 'archive' } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.json.card.status, 'archived');
  assert.strictEqual(out.json.card.decided_by, 'katherine@x');
  const again = await call(srv, `/api/review/cards/${a.id}`, { method: 'POST', body: { action: 'archive' } });
  assert.strictEqual(again.status, 400, 'an archived card cannot be archived twice');
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
const base = (extra) => ({ id: 1, status: 'draft', agent_name: 'Scout', job: 'ideas', title: 'A draft', body: 'Body.', sources: [], checks: {}, payload: null, handoff: null, ...extra });

test('a draft card shows "Approve will:" right above its buttons, and Archive (no action) beside Approve', () => {
  const { cardHtml } = renderers();
  const c = base({ agent: 'gbp' }); c.approve_will = AW.approveWill(c);
  const html = cardHtml(c);
  const line = html.indexOf('Approve will: file it as done');
  const buttons = html.indexOf('<div class="actions">');
  assert.ok(line > 0 && line < buttons, 'the line sits above the buttons');
  assert.ok(!html.slice(line, buttons).includes('<p'), 'nothing between the line and the buttons');
  assert.match(html, /data-a="approve">Approve</);
  // #3923 renamed the button "No action (archive)" so Katherine finds it.
  assert.match(html, /data-a="archive">No action \(archive\)</);
});

test('a report card shows Got it (which archives) and no Approve', () => {
  const { cardHtml } = renderers();
  const c = base({ agent: 'site-health' }); c.approve_will = AW.approveWill(c);
  const html = cardHtml(c);
  assert.match(html, /data-a="archive">Got it</);
  assert.doesNotMatch(html, /data-a="approve"/);
  assert.doesNotMatch(html, /Approve will:/);
  assert.ok(HTML.includes("if (b.dataset.a === 'archive') act({ action: 'archive' });"));
});

test('no Archive or Approve-will line on a card that is not a draft', () => {
  const { cardHtml } = renderers();
  for (const status of ['ready', 'rejected', 'archived']) {
    const html = cardHtml(base({ status }));
    assert.doesNotMatch(html, /data-a="archive"/, status);
    assert.doesNotMatch(html, /Approve will:/, status);
  }
});

test('the Archived filter says who archived it and when', () => {
  const { cardHtml } = renderers();
  const html = cardHtml(base({ status: 'archived', decided_by: 'katherine@x', decided_at: '2026-11-18T21:00:00Z' }));
  assert.match(html, /Archived by katherine@x 11\.18\.2026/);
});

test('no order number on anything she sees', () => {
  const shown = HTML.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(shown, /3570/);
});
