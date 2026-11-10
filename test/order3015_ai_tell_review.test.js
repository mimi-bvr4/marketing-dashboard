'use strict';
// ORDER #3015 (re-queue of #3010 item b): Approve and Reject on each proposed
// AI tell, on the Review tab, behind AI_TELL_HUNT (default OFF). The verdict is
// stored where the tab already stores card state (agent_cards); the Box pulls it
// into the hunt ledger through the existing decide(). No express here, so it runs in a worktree without node_modules; the
// route half is order3015_ai_tell_review_route.test.js. Approve records the
// verdict only: the ban list and lib/ai-tells.js stay a separate branch step.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const H = require('../lib/ai-tell-hunt');
const R = require('../lib/ai-tell-review');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

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
const press = (s, id, d) => s.decide(id, { who: 'katherine@x', ...d }); // what POST /api/review/cards/:id calls
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('the card says in plain words that Approve records the verdict only', () => {
  const row = R.cardRow(GOOD);
  assert.strictEqual(row.agent, R.AGENT);
  assert.strictEqual(row.seen_key, H.keyOf(GOOD.pattern));
  assert.deepStrictEqual(row.payload.ai_tell.proposal, GOOD);
  assert.match(row.body, /Approve records your verdict only\. It does not change the ban list or the lint check/);
  assert.match(row.body, /never proposed again/);
  assert.doesNotMatch(row.body, /Approve adds it to the ban list/, 'the old promise is gone from the posted card');
  const ours = row.body.split('\n').filter((l) => !/^- "/.test(l)).join('\n');
  assert.doesNotMatch(ours, /[—–]/, 'no dash in our own words');
});

test('Reject writes a reject row, and the next hunt does not propose that tell again', async (t) => {
  withSwitch(t, 'on');
  const f = tmpRoot(t);
  const s = createMemoryStore({ lint });
  const ask = async () => answer([GOOD]);
  const first = await R.postHunt({ ask, store: s, banText: BAN, ledgerFile: f.ledger, today: '2026-11-09', env: process.env });
  assert.strictEqual(first.posted.length, 1);
  const id = first.posted[0].id;
  const r = await press(s, id, { action: 'reject', reason: 'too common in real copy' });
  assert.ifError(r.error);
  assert.strictEqual(r.card.status, 'rejected');
  const pulled = await R.pullVerdicts({ store: s, ledgerFile: f.ledger });
  assert.strictEqual(pulled.added.length, 1);
  const rows = H.readLedger(f.ledger).filter((e) => e.kind === 'reject');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].who, 'katherine@x');
  assert.strictEqual(rows[0].key, H.keyOf(GOOD.pattern));
  assert.match(rows[0].note, new RegExp(`card ${id}`));
  const again = await R.postHunt({ ask: async () => answer([LATER]), store: s, banText: BAN, ledgerFile: f.ledger, today: '2026-11-16', env: process.env });
  assert.strictEqual(again.posted.length, 0, 'never proposed again');
  assert.ok(again.hunt.skipped.some((x) => /rejected/.test(x.why)));
  assert.strictEqual(s.cards.filter((c) => c.agent === R.AGENT).length, 1, 'no second card');
});

test('a tell already on the tab is not posted twice, even before its verdict is pulled', async (t) => {
  withSwitch(t, 'on');
  const f = tmpRoot(t);
  const s = createMemoryStore({ lint });
  const ask = async () => answer([GOOD]);
  await R.postHunt({ ask, store: s, banText: BAN, ledgerFile: f.ledger, today: '2026-11-09', env: process.env });
  const second = await R.postHunt({ ask: async () => answer([LATER]), store: s, banText: BAN, ledgerFile: f.ledger, today: '2026-11-16', env: process.env });
  assert.strictEqual(second.posted.length, 0);
  assert.ok(second.already.length === 1, 'skipped because its card is already on the tab');
  assert.strictEqual(s.cards.length, 1);
});

test('Approve writes an approve row and changes no ban-list or lint file', async (t) => {
  withSwitch(t, 'on');
  const f = tmpRoot(t);
  const LINT = path.join(__dirname, '..', 'lib', 'ai-tells.js');
  const DET = path.join(__dirname, '..', 'lib', 'ai-tell-detective.js');
  const before = [sha(f.ban), sha(LINT), sha(DET)];
  const s = createMemoryStore({ lint });
  const c = await s.insert(R.cardRow(DASHY));
  const r = await press(s, c.id, { action: 'approve' });
  assert.ifError(r.error, 'quoted evidence with dashes does not block the verdict');
  assert.strictEqual(r.card.status, 'ready');
  await R.pullVerdicts({ store: s, ledgerFile: f.ledger });
  const rows = H.readLedger(f.ledger).filter((e) => e.kind === 'approve');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].key, H.keyOf(DASHY.pattern));
  assert.deepStrictEqual([sha(f.ban), sha(LINT), sha(DET)], before, 'ban list, lint and LIST_UPDATED untouched');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f.ban)).sort(), ['AI_TELLS_BAN_LIST.md', 'AI_TELLS_HUNT_LEDGER.md'], 'no ban_list_after or other file');
});

test('pressing twice records one verdict, and pulling twice writes one row', async (t) => {
  withSwitch(t, 'on');
  const f = tmpRoot(t);
  const s = createMemoryStore({ lint });
  const c = await s.insert(R.cardRow(GOOD));
  assert.ifError((await press(s, c.id, { action: 'approve' })).error);
  const twice = await press(s, c.id, { action: 'approve' });
  assert.strictEqual(twice.status, 409);
  assert.match(twice.error, /already approved/);
  const flip = await press(s, c.id, { action: 'reject', reason: 'changed my mind' });
  assert.strictEqual(flip.status, 409, 'a verdict is not flipped by a second press');
  assert.strictEqual(c.status, 'ready');
  await R.pullVerdicts({ store: s, ledgerFile: f.ledger });
  await R.pullVerdicts({ store: s, ledgerFile: f.ledger });
  assert.strictEqual(H.readLedger(f.ledger).filter((e) => e.kind !== 'run').length, 1);
});

test('edit and redo are refused on a tell card; only approve or reject', async (t) => {
  withSwitch(t, 'on');
  const s = createMemoryStore({ lint });
  const c = await s.insert(R.cardRow(GOOD));
  const out = await s.decide(c.id, { action: 'edit', body: 'new words', who: 'k@x' });
  assert.match(out.error, /approved or rejected/);
  assert.strictEqual(c.status, 'draft');
});

test('posting needs the switch; the dry run keeps its no-write promise', async (t) => {
  withSwitch(t, null);
  const f = tmpRoot(t);
  const s = createMemoryStore({ lint });
  await assert.rejects(R.postHunt({ ask: async () => answer([GOOD]), store: s, banText: BAN, ledgerFile: f.ledger, today: '2026-11-09', env: process.env }), /AI_TELL_HUNT/);
  assert.strictEqual(s.cards.length, 0);
  assert.strictEqual(fs.existsSync(f.ledger), false);
  const job = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'ai_tell_hunt.js'), 'utf8');
  assert.match(job, /--dry-run/);
  assert.match(job, /pull-verdicts/);
});

test('a real posting run records one run row signed by the machine, not a person', async (t) => {
  withSwitch(t, 'on');
  const f = tmpRoot(t);
  const s = createMemoryStore({ lint });
  await R.postHunt({ ask: async () => answer([GOOD]), store: s, banText: BAN, ledgerFile: f.ledger, today: '2026-11-09', env: process.env });
  const runs = H.readLedger(f.ledger).filter((e) => e.kind === 'run');
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].ymd, '2026-11-09');
  assert.strictEqual(runs[0].who, R.MACHINE);
});

test('the switch OFF: a tell card takes no verdict at all', async (t) => {
  withSwitch(t, null);
  const s = createMemoryStore({ lint });
  const c = await s.insert(R.cardRow(GOOD));
  const r = await press(s, c.id, { action: 'approve' });
  assert.strictEqual(r.status, 404);
  assert.match(r.error, /AI_TELL_HUNT/);
  assert.strictEqual(c.status, 'draft');
});

test('an ordinary card is decided exactly as before (the tell rule touches only tell cards)', async (t) => {
  withSwitch(t, 'on');
  const s = createMemoryStore({ lint });
  const c = await s.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'reply', title: 'x', body: 'Thank you.' });
  assert.match((await press(s, c.id, { action: 'reject' })).error, /one-line reason/);
  assert.strictEqual((await press(s, c.id, { action: 'approve' })).card.status, 'ready');
  assert.strictEqual((await press(s, c.id, { action: 'approve' })).card.status, 'ready', 'a second approve on an ordinary card still answers as it did');
});
