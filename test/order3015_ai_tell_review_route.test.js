'use strict';
// ORDER #3015, the Review route half (needs express). (Re-queue of #3010 item b): Approve and Reject on each proposed
// AI tell, on the Review tab, behind AI_TELL_HUNT (default OFF). The verdict is
// stored where the tab already stores card state (agent_cards); the Box pulls it
// into the hunt ledger through the existing decide(). Approve records the
// verdict only: the ban list and lib/ai-tells.js stay a separate branch step.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const H = require('../lib/ai-tell-hunt');
const R = require('../lib/ai-tell-review');
const { createMemoryStore } = require('../lib/agent-store');
const { createReviewRouter } = require('../routes/review');
const { pageGate } = require('../middleware/page-gate');
const { lint } = require('../lib/ai-tells');

const PAGE = path.join(__dirname, '..', 'public', 'review.html');
const BAN = `# AI TELLS
## THE 20
1. **Em dashes.**
7. **The AI vocabulary:** delve, tapestry, testament.

## CHANGELOG
- 10.09.2026 12:00 CT: list created (20 tells), Mimi.
`;
const GOOD = {
  pattern: 'Stacked negation openers ("No fluff. No filler. Just results.")',
  why: 'A chatbot cadence: three short negations before the claim.',
  examples: ['No fluff. No filler. Just results.', 'No stress. No guesswork. Just your day.'],
  sources: [{ title: 'Example style blog', url: 'https://example.org/ai-tells', date: '2026-10-20' }],
  lint: { kind: 'regex', pattern: '\\bNo \\w+\\. No \\w+\\. Just\\b' },
  fp_risk: 'low: real copy rarely stacks two "No X." fragments before "Just".',
};
// The examples are quoted evidence and may hold the very tells we ban.
const DASHY = { ...GOOD, pattern: 'Em dash pivots ("It is not a venue — it is a feeling")', examples: ['Not a venue — a feeling.', 'Not a party — a memory.'] };
const LATER = { ...GOOD, sources: [{ ...GOOD.sources[0], date: '2026-11-12' }] }; // fresh inside the next window
const answer = (list) => `\`\`\`json\n${JSON.stringify(list)}\n\`\`\``;

function withSwitch(t, value) {
  const was = process.env.AI_TELL_HUNT;
  if (value == null) delete process.env.AI_TELL_HUNT; else process.env.AI_TELL_HUNT = value;
  t.after(() => { if (was == null) delete process.env.AI_TELL_HUNT; else process.env.AI_TELL_HUNT = was; });
}
function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o3015-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ban = path.join(dir, 'AI_TELLS_BAN_LIST.md');
  fs.writeFileSync(ban, BAN);
  return { ban, ledger: path.join(dir, 'AI_TELLS_HUNT_LEDGER.md') };
}
function serve(app, t) {
  return new Promise((resolve) => { const s = http.createServer(app).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); }); });
}
function call(server, p, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
        let json = null; try { json = d ? JSON.parse(d) : null; } catch (e) { /* html */ }
        resolve({ status: res.statusCode, text: d, json });
      });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
function app(store, { who = 'Katherine@X' } = {}) {
  const a = express();
  a.use(express.json());
  if (who) a.use((req, res, next) => { req.mktUser = { email: who }; next(); });
  a.use(createReviewRouter({ store }));
  return a;
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('the switch OFF: the Review page is the file byte for byte, no tell API, no tell verdicts', async (t) => {
  withSwitch(t, null);
  const s = createMemoryStore({ lint });
  const c = await s.insert(R.cardRow(GOOD));
  const srv = await serve(app(s), t);
  const page = await call(srv, '/review');
  assert.strictEqual(page.status, 200);
  assert.strictEqual(page.text, fs.readFileSync(PAGE, 'utf8'), 'rendered HTML unchanged, byte for byte');
  assert.doesNotMatch(page.text, /review-ai-tell\.js/);
  assert.strictEqual((await call(srv, '/api/review/ai-tell-cards')).status, 404);
  const r = await call(srv, `/api/review/cards/${c.id}`, { method: 'POST', body: { action: 'approve' } });
  assert.strictEqual(r.status, 404, 'no verdict while the switch is off');
  assert.strictEqual(c.status, 'draft');
});

test('the switch ON: the page gains only the tell script, and the API names the tell cards', async (t) => {
  withSwitch(t, 'on');
  const s = createMemoryStore({ lint });
  const c = await s.insert(R.cardRow(GOOD));
  await s.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'x', body: 'Thank you.' });
  const srv = await serve(app(s), t);
  const page = await call(srv, '/review');
  assert.match(page.text, /<script src="\/review-ai-tell\.js" defer><\/script>/);
  assert.strictEqual(page.text.replace(R.SCRIPT_TAG, ''), fs.readFileSync(PAGE, 'utf8'), 'nothing else changed');
  const ids = await call(srv, '/api/review/ai-tell-cards');
  assert.deepStrictEqual(ids.json.ids, [c.id]);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'review-ai-tell.js'), 'utf8');
  assert.match(js, /Approve tell/); assert.match(js, /Reject tell/);
});

test('a non-approver is refused: no session at the gate, no person at the router', async (t) => {
  withSwitch(t, 'on');
  const s = createMemoryStore({ lint });
  const c = await s.insert(R.cardRow(GOOD));
  const gated = express();
  gated.use(express.json());
  gated.use(pageGate);
  gated.use(createReviewRouter({ store: s }));
  const g = await serve(gated, t);
  const r1 = await call(g, `/api/review/cards/${c.id}`, { method: 'POST', body: { action: 'approve' } });
  assert.strictEqual(r1.status, 401, 'the #1370 gate (exec or Katherine SSO) refuses first');
  const bare = await serve(app(s, { who: null }), t);
  const r2 = await call(bare, `/api/review/cards/${c.id}`, { method: 'POST', body: { action: 'reject', reason: 'x' } });
  assert.strictEqual(r2.status, 403);
  assert.strictEqual((await call(bare, '/api/review/ai-tell-cards')).status, 403);
  assert.strictEqual(c.status, 'draft', 'nothing recorded');
});

test('through the route: the verdict is recorded against the signed-in person, and a second press answers 409', async (t) => {
  withSwitch(t, 'on');
  const s = createMemoryStore({ lint });
  const c = await s.insert(R.cardRow(GOOD));
  const srv = await serve(app(s), t);
  const r = await call(srv, `/api/review/cards/${c.id}`, { method: 'POST', body: { action: 'reject', reason: 'common in real copy' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.card.decided_by, 'katherine@x');
  const again = await call(srv, `/api/review/cards/${c.id}`, { method: 'POST', body: { action: 'approve' } });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(c.status, 'rejected');
});
