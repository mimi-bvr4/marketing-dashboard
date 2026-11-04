'use strict';
// ORDER #2908 (Mimi 11.03.2026, "Archive cards older than 14 days"): a card can
// be 'archived'. Hidden from Drafts, not counted as waiting, listed under the
// Archived filter, restorable to draft, never deleted. Each guard is shown
// refusing something wrong (iron rule 14).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createMemoryStore, SCHEMA_SQL } = require('../lib/agent-store');
const { createReviewRouter } = require('../routes/review');
const { judge, backNote, alreadyList } = require('../lib/agent-seen');
const { lint } = require('../lib/ai-tells');

function store() { return createMemoryStore({ lint }); }
async function card(s, extra = {}) {
  return s.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'Reply draft: a venue', body: 'Thank you for the kind words.', ...extra });
}

test('schema: the live CHECK is widened to archived, once, and the fresh-table CREATE is unchanged', () => {
  const sql = SCHEMA_SQL.join('\n');
  assert.match(sql, /CHECK \(status IN \('draft', 'ready', 'rejected'\)\)/, 'the CREATE keeps its original CHECK');
  const widen = SCHEMA_SQL.find((q) => q.includes("'archived'"));
  assert.ok(widen, 'a statement adds archived');
  assert.match(widen, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/, 'guarded, so a reboot does not re-validate the table');
  assert.match(widen, /CHECK \(status IN \('draft', 'ready', 'rejected', 'archived'\)\)/);
  assert.doesNotMatch(sql, /DELETE FROM agent_cards/i, 'nothing deletes a card');
});

test('an archived card is not on Drafts, is not waiting, and is listed under Archived', async () => {
  const s = store();
  const a = await card(s); const b = await card(s, { title: 'Profile post idea' });
  await card(s, { agent: 'digest', agent_name: 'Monday digest' });
  assert.strictEqual(await s.draftsWaiting(), 2);
  a.status = 'archived'; // what the apply paste does, row by row
  assert.strictEqual(await s.draftsWaiting(), 1, 'archived is not waiting');
  assert.deepStrictEqual((await s.list({ status: 'draft' })).map((c) => c.id).filter((id) => id !== 3), [b.id]);
  assert.deepStrictEqual((await s.list({ status: 'archived' })).map((c) => c.id), [a.id]);
});

test('restore puts an archived card back on Drafts, as it was, and records who', async () => {
  const s = store();
  const a = await card(s);
  a.status = 'archived';
  const out = await s.decide(a.id, { action: 'restore', who: 'katherine@x' });
  assert.ifError(out.error);
  assert.strictEqual(out.card.status, 'draft');
  assert.strictEqual(out.card.decided_by, 'katherine@x');
  assert.strictEqual(out.card.body, 'Thank you for the kind words.', 'body untouched');
  assert.strictEqual(out.card.reason, null, 'reason untouched');
});

test('guards: restore only from archived; approve, reject and edit refused on an archived card', async () => {
  const s = store();
  const a = await card(s);
  assert.match((await s.decide(a.id, { action: 'restore', who: 'k@x' })).error, /only an archived card/);
  a.status = 'archived';
  for (const d of [{ action: 'approve' }, { action: 'reject', reason: 'old' }, { action: 'edit', body: 'new' }]) {
    const out = await s.decide(a.id, { ...d, who: 'k@x' });
    assert.match(out.error, /archived; restore it/, `${d.action} refused`);
  }
  assert.strictEqual(a.status, 'archived', 'still archived, nothing approved or rejected on her behalf');
  assert.match((await s.decide(a.id, { action: 'restore' })).error, /no person/);
});

test('seen-before: an archived item is not redrafted unless its source changed, and is never called rejected', () => {
  const earlier = [{ id: 1, status: 'archived', seen_source: { rating: '5' }, reason: null, decided_at: '2026-11-04T05:00:00Z' }];
  const same = judge(earlier, { rating: '5' });
  assert.strictEqual(same.keep, false);
  assert.match(same.why, /archived unread/);
  const moved = judge(earlier, { rating: '2' });
  assert.strictEqual(moved.keep, true);
  assert.match(backNote(moved.back), /archived unread on/);
  assert.doesNotMatch(backNote(moved.back), /rejected/);
  assert.match(alreadyList([{ seen_key: 'k', status: 'archived' }]), /k \(archived unread\)/);
  // A rejected card reads as before.
  const rej = judge([{ ...earlier[0], status: 'rejected', reason: 'off brand' }], { rating: '2' });
  assert.match(backNote(rej.back), /rejected on .*"off brand"/);
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

test('the Review route serves the Archived filter and the Restore action', async (t) => {
  const s = store();
  const a = await card(s); await card(s, { title: 'still a draft' });
  a.status = 'archived';
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.mktUser = { email: 'Katherine@X' }; next(); });
  app.use(createReviewRouter({ store: s }));
  const srv = await serve(app, t);
  const arch = await call(srv, '/api/review/cards?status=archived');
  assert.deepStrictEqual(arch.json.cards.map((c) => c.id), [a.id]);
  const drafts = await call(srv, '/api/review/cards');
  assert.ok(!drafts.json.cards.some((c) => c.id === a.id), 'hidden from Drafts by default');
  const r = await call(srv, `/api/review/cards/${a.id}`, { method: 'POST', body: { action: 'restore' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.card.status, 'draft');
  assert.strictEqual(r.json.card.decided_by, 'katherine@x');
  const again = await call(srv, `/api/review/cards/${a.id}`, { method: 'POST', body: { action: 'restore' } });
  assert.strictEqual(again.status, 400, 'a draft cannot be restored');
});

test('the page has the Archived filter and a Restore button, and no order number', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.match(html, /<button data-s="archived" aria-pressed="false">Archived<\/button>/);
  assert.match(html, /data-a="restore">Restore to Drafts</);
  assert.match(html, /action: 'restore'/);
  const shown = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(shown, /2908/, 'no order number Katherine can see');
});
