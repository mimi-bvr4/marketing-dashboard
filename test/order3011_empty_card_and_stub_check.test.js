'use strict';
// ORDER #3011: Convention Charles's first 4-year run (11.05.2026 09:26 CT) saved
// a card whose body was only "...", and the Copywriter pre-pass passed it as
// "Ready to go out" while its own note said the draft "appears to be a stub".
// Acceptance: an empty/"..." body becomes a failed-run card; the Copywriter
// returns Needs changes on a stub; the Detective does too; the AI-tells
// rewrite can no longer turn a full card into "...".
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAgent, loadAgent, copyPrepass, rewriteLost } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { stubReason } = require('../lib/stub-text');
const detective = require('../lib/ai-tell-detective');

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3011-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\nA group of 400 meets downtown on 11.18.2026.\n');
  return { IHG_TREE: root };
}
const defFor = (slug, extra = {}) => ({ ...loadAgent(slug), copy_prepass: false, ...extra,
  sources: [{ type: 'file', path: 'notes.md', required: true, label: 'the notes' }] });
function model(answers) {
  const calls = [];
  return { model: 'fake', calls, lastStop: 'end_turn',
    async complete(req) { calls.push(req); return typeof answers === 'function' ? answers(req, calls.length) : answers[Math.min(calls.length - 1, answers.length - 1)]; } };
}
const noNet = async () => { throw new Error('no network'); };

const TABLE = '| Event | Dates | Host venue | Link |\n|---|---|---|---|\n'
  + '| Example Association annual meeting | 03.10.2027 to 03.12.2027 | Music City Center | https://example.org/2027 |\n\n'
  + '### 2028\n\nnone found for 2028\n\n### 2029\n\nnone found for 2029\n\n### 2030\n\nnone found for 2030';

test('stubReason: empty, "...", ellipsis and placeholders are stubs; a short real line is not', () => {
  for (const s of ['', '   ', '...', '…', ' . . . ', '## \n\n...', 'TBD', '[insert table here]', 'N/A', null]) assert.ok(stubReason(s), JSON.stringify(s));
  for (const s of ['Short.', 'A short note.', 'Nothing new this week.', TABLE]) assert.strictEqual(stubReason(s), null, s);
  assert.ok(/only "\.\.\."/.test(stubReason('...')));
});

test('KNOWN-BAD (11.05.2026): a "..." card is saved as "<agent> run produced an empty card", never as a draft', async (t) => {
  const store = createMemoryStore({ lint });
  const llm = model([JSON.stringify({ cards: [
    { title: 'Conventions coming to Nashville, 11.05.2026', target: 'sales', body: '...' },
    { title: 'Draft emails, 11.05.2026', target: 'sales', body: 'To: Example DMC, https://example.org/contact. Subject: Your reception in March.' }] })]);
  const lines = [];
  const r = await runAgent({ def: defFor('convention-connector'), store, llm, env: tree(t), log: (l) => lines.push(l), fetchImpl: noNet });
  assert.strictEqual(r.ok, true, r.error);
  const titles = r.cards.map((c) => c.title);
  // #3012 rebase: #3000 renamed the agent "Convention Charles"; the title uses the agent's own name.
  assert.deepStrictEqual(titles, [`${defFor('convention-connector').name} run produced an empty card`, 'Draft emails, 11.05.2026']);
  const empty = r.cards[0];
  assert.match(empty.body, /drafted "Conventions coming to Nashville, 11\.05\.2026" but the text is only "\.\.\."/);
  assert.match(empty.body, /not saved as a draft/);
  assert.strictEqual(empty.checks.empty_card, true);
  assert.ok(lines.some((l) => /empty card "Conventions coming to Nashville/.test(l)), lines.join('\n'));
  const runs = await store.listRuns ? await store.listRuns() : null;
  if (runs && runs.length) assert.match(String(runs[0].note || ''), /1 empty card saved as failed/);
});

test('the AI-tells rewrite that comes back as "..." is dropped and the full card is kept; it gets the agent\'s own length limit', async (t) => {
  const store = createMemoryStore({ lint });
  const full = { title: 'Conventions coming to Nashville, 11.05.2026', target: 'sales', body: TABLE + '\n\nLet us delve into the list.' };
  const llm = model((req, n) => (n === 1 ? JSON.stringify({ cards: [full] })
    : JSON.stringify({ cards: [{ title: full.title, target: 'sales', body: '...' }] })));
  const lines = [];
  const r = await runAgent({ def: defFor('convention-connector'), store, llm, env: tree(t), log: (l) => lines.push(l), fetchImpl: noNet });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(llm.calls.length, 2, 'one draft, one rewrite');
  assert.strictEqual(llm.calls[1].maxTokens, loadAgent('convention-connector').max_tokens, 'the rewrite has the agent\'s limit, not the 8000 default');
  assert.match(llm.calls[1].user, /never "\.\.\."/);
  assert.strictEqual(r.cards[0].title, full.title);
  assert.match(r.cards[0].body, /Example Association annual meeting/);
  assert.match(r.cards[0].body, /none found for 2030/);
  assert.ok(lines.some((l) => /rewrite dropped \(the text is only/.test(l)), lines.join('\n'));
});

test('rewriteLost: a rewrite that keeps under half of a long body is dropped; a normal rewrite is kept', () => {
  const long = { body: 'x'.repeat(1000) };
  assert.match(rewriteLost(long, { body: 'y'.repeat(300) }), /kept 300 of 1000/);
  assert.strictEqual(rewriteLost(long, { body: 'y'.repeat(900) }), null);
  assert.strictEqual(rewriteLost({ body: 'short one' }, { body: 'short' }), null);
});

test('Copywriter pre-pass: a stub is "Needs changes", without asking the model', async () => {
  const llm = model(['{"cards":[{"title":"Copy check","body":"Ready to go out"}]}']);
  const out = await copyPrepass({ title: 'Conventions coming to Nashville, 11.05.2026', body: '...' }, { llm, env: {}, fetchImpl: noNet, at: new Date(), dryRun: true });
  assert.strictEqual(out.check.ready, false);
  assert.strictEqual(out.check.stub, true);
  assert.strictEqual(out.check.summary, 'Copy check: Needs changes (1)');
  assert.match(out.section, /Needs changes \(1\)/);
  assert.doesNotMatch(out.section, /Ready to go out/);
  assert.strictEqual(llm.calls.length, 0);
});

test('KNOWN-BAD (11.05.2026): "Ready to go out" whose own note says the draft appears to be a stub becomes Needs changes', async () => {
  const llm = model([JSON.stringify({ cards: [{ title: 'Copy check', body: 'Ready to go out. 0 fails, 0 flags. Note: the draft appears to be a stub.' }] })]);
  const out = await copyPrepass({ title: 'Draft emails', body: 'To: Example DMC. Subject: your reception. A real body of words here.' }, { llm, env: {}, fetchImpl: noNet, at: new Date(), dryRun: true });
  assert.strictEqual(out.check.ran, true, out.check.why);
  assert.strictEqual(out.check.ready, false);
  assert.strictEqual(out.check.summary, 'Copy check: Needs changes (1)');
  assert.match(out.section, /appears to be a stub/);
});

test('a Ready verdict that says the draft is NOT a stub stays Ready', async () => {
  const llm = model([JSON.stringify({ cards: [{ title: 'Copy check', body: 'Ready to go out. The draft is not a stub; it is complete.' }] })]);
  const out = await copyPrepass({ title: 'Draft emails', body: 'To: Example DMC. Subject: your reception. A real body of words here.' }, { llm, env: {}, fetchImpl: noNet, at: new Date(), dryRun: true });
  assert.strictEqual(out.check.ready, true, out.section);
});

test('Detective: an empty or "..." text is Needs changes, never Sounds human; a short real line still checks normally', () => {
  for (const s of ['', '...', '  …  ']) {
    const r = detective.check(s);
    assert.strictEqual(r.verdict, 'Needs changes (1)', JSON.stringify(s));
    assert.strictEqual(r.stub, true);
    assert.ok(r.stub_reason);
  }
  assert.strictEqual(detective.check('It holds 300 guests.').stub, undefined);
  assert.strictEqual(detective.check('Ok.').verdict, 'Sounds human');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.match(page, /d\.count \|\| d\.stub \? 'bad' : 'good'/);
});

test('Convention Connector: 16000 output tokens, up to 3 cards, and the skill says split, never truncate', () => {
  const a = loadAgent('convention-connector');
  assert.strictEqual(a.max_tokens, 16000);
  assert.strictEqual(a.max_cards, 3);
  assert.match(a.skill, /Split, never truncate/);
  assert.match(a.skill, /later years/);
  assert.match(a.skill, /Rest of <that year>/, 'the months between the 9-month table and the next January get a heading (the 11.05.2026 dry run skipped 08.2027 to 12.2027)');
  assert.match(a.skill, /never kept with a note that its link is missing/);
});
