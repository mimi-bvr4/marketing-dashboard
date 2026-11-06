'use strict';
// ORDER #3010: the AI Tell Detective's Monday trend hunt (#3008 part B).
// No express and no network here, so it runs in a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = require('../lib/ai-tell-hunt');
const D = require('../lib/ai-tell-detective');

const BAN = `# AI TELLS
## THE 20
1. **Em dashes.**
7. **The AI vocabulary:** delve, tapestry, testament.

## KEEPING IT CURRENT
words

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

const answer = (list) => `Here is what I found.\n\`\`\`json\n${JSON.stringify(list)}\n\`\`\``;

test('the switch: AI_TELL_HUNT, default OFF', () => {
  assert.strictEqual(H.FLAG, 'AI_TELL_HUNT');
  assert.strictEqual(H.huntOn({}), false);
  assert.strictEqual(H.huntOn({ AI_TELL_HUNT: 'off' }), false);
  assert.strictEqual(H.huntOn({ AI_TELL_HUNT: 'on' }), true);
});

test('the first run backfills from 10.09.2026; later runs start at the last run', () => {
  assert.strictEqual(H.BACKFILL_FROM, '2026-10-09');
  assert.strictEqual(H.sinceDate([]), '2026-10-09');
  assert.strictEqual(H.sinceDate([{ kind: 'run', ymd: '2026-11-09' }, { kind: 'run', ymd: '2026-11-02' }]), '2026-11-09');
});

test('the prompt names the window, the known tells and the decided ones, and asks for JSON with links', () => {
  const p = H.huntPrompt({ today: 'November 9, 2026', since: '2026-10-09', known: ['delve'], decided: ['stacked negation openers'] });
  assert.match(p, /published since 10\.09\.2026/);
  assert.match(p, /delve/);
  assert.match(p, /stacked negation openers/);
  assert.match(p, /```json/);
  assert.match(p, /Never list a tell without a link you actually found/);
});

test('parse: a good proposal survives; every bad one is dropped with its reason', () => {
  const bad = [
    { ...GOOD, examples: ['only one'] },
    { ...GOOD, sources: [] },
    { ...GOOD, sources: [{ title: 'x', url: 'http://example.org/', date: '2026-10-20' }] },
    { ...GOOD, sources: [{ title: 'x', url: 'https://example.org/', date: '' }] },
    { ...GOOD, sources: [{ title: 'x', url: 'https://example.org/', date: '2026-09-01' }] },
    { ...GOOD, lint: { kind: 'regex', pattern: '([' } },
    { ...GOOD, fp_risk: '' },
  ];
  const r = H.parseProposals(answer([GOOD, ...bad]), { since: '2026-10-09' });
  assert.strictEqual(r.proposals.length, 1);
  assert.strictEqual(r.proposals[0].pattern, GOOD.pattern);
  assert.strictEqual(r.dropped.length, bad.length);
  for (const d of r.dropped) assert.ok(d.why && d.why.length > 3, 'each drop says why');
  assert.deepStrictEqual(H.parseProposals('nothing new found').proposals, []);
  assert.strictEqual(H.parseProposals('nothing new found').none, true);
});

test('a cut-off answer (the asker caps tokens) keeps every complete proposal and drops the broken tail', () => {
  const full = JSON.stringify([GOOD, { ...GOOD, pattern: 'Second tell' }], null, 2);
  const cut = `Notes first [X] matters here.\n\`\`\`json\n${full.slice(0, full.lastIndexOf('"examples"') + 20)}`;
  const r = H.parseProposals(cut, { since: '2026-10-09' });
  assert.deepStrictEqual(r.proposals.map((p) => p.pattern), [GOOD.pattern]);
  assert.strictEqual(r.truncated, true);
});

test('one tell under two names is one card: a leading quoted phrase is the key; examples lose wrapping quotes', async () => {
  assert.strictEqual(H.keyOf('"from X to Y" breadth construction, e.g. "from a to b"'), 'from x to y');
  assert.strictEqual(H.keyOf('"From X to Y" false-range sweep'), 'from x to y');
  const a = { ...GOOD, pattern: '"from X to Y" breadth construction', examples: ['"From a to b, we do it."', '"From c to d."'] };
  const b = { ...GOOD, pattern: '"From X to Y" false-range sweep' };
  const r = await H.huntDry({ ask: async () => answer([a, b]), banText: BAN, ledger: [], today: '2026-11-09', queries: ['q'] });
  assert.strictEqual(r.cards.length, 1);
  assert.deepStrictEqual(r.cards[0].proposal.examples, ['From a to b, we do it.', 'From c to d.']);
});

test('a "human check" lint is allowed; MM.DD.YYYY dates are read too', () => {
  const p = { ...GOOD, lint: { kind: 'human check' }, sources: [{ title: 't', url: 'https://example.org/', date: '10.21.2026' }] };
  const r = H.parseProposals(answer([p]), { since: '2026-10-09' });
  assert.strictEqual(r.proposals.length, 1);
  assert.strictEqual(r.proposals[0].sources[0].date, '2026-10-21');
});

test('known tells and decided tells are never proposed again', () => {
  const known = H.knownTells(BAN);
  assert.ok(known.includes('delve'));
  const delve = { ...GOOD, pattern: 'delve' };
  const ledger = [{ kind: 'reject', key: H.keyOf(GOOD.pattern), ymd: '2026-11-09', who: 'Katherine' }];
  const r = H.fresh([GOOD, delve], { known, ledger });
  assert.deepStrictEqual(r.keep, []);
  assert.deepStrictEqual(r.skipped.map((s) => s.why).sort(), ['already on the ban list', 'rejected 11.09.2026, never proposed again']);
});

test('the Review card carries the pattern, 2 examples, dated source links, the lint rule and the false-positive risk', () => {
  const c = H.cardOf(GOOD);
  assert.match(c.title, /^New AI tell\? /);
  for (const e of GOOD.examples) assert.ok(c.body.includes(e));
  assert.match(c.body, /https:\/\/example\.org\/ai-tells/);
  assert.match(c.body, /10\.20\.2026/);
  assert.match(c.body, /Proposed lint rule/);
  assert.match(c.body, /False-positive risk: low/);
  assert.match(c.body, /Approve adds it to the ban list/);
  assert.strictEqual(c.key, H.keyOf(GOOD.pattern));
  assert.match(H.cardOf({ ...GOOD, lint: { kind: 'human check' } }).body, /human check/);
});

test('the card text itself passes the AI-tell lint (no em dash in what we show)', () => {
  const c = H.cardOf(GOOD);
  assert.doesNotMatch(c.title + c.body.replace(/"[^"]*"/g, ''), /—/);
});

test('decide: reject is logged; approve is logged; a second verdict on the same tell is refused', () => {
  let ledger = [];
  const r1 = H.decide({ ledger, proposal: GOOD, verdict: 'reject', who: 'Katherine', ymd: '2026-11-09' });
  assert.strictEqual(r1.entry.kind, 'reject');
  ledger = r1.ledger;
  const again = H.decide({ ledger, proposal: GOOD, verdict: 'approve', who: 'Mimi', ymd: '2026-11-09' });
  assert.match(again.error, /already rejected/);
  assert.throws(() => H.decide({ ledger: [], proposal: GOOD, verdict: 'maybe', who: 'x', ymd: '2026-11-09' }));
  assert.throws(() => H.decide({ ledger: [], proposal: GOOD, verdict: 'approve', who: '', ymd: '2026-11-09' }));
});

test('approve: the ban list gains a dated ADDED section above the CHANGELOG, and a CHANGELOG line', () => {
  const out = H.applyApproved(BAN, [{ proposal: GOOD, who: 'Katherine', ymd: '2026-11-09' }]);
  assert.match(out, /## ADDED 11\.09\.2026\n- \*\*Stacked negation openers/);
  assert.ok(out.indexOf('## ADDED 11.09.2026') < out.indexOf('## CHANGELOG'));
  assert.match(out, /- 11\.09\.2026: 1 tell added from the Monday hunt \(approved by Katherine\)/);
  assert.ok(out.startsWith(BAN.split('## CHANGELOG')[0].trimEnd().slice(0, 20)));
  // idempotent for the same tell
  assert.strictEqual(H.applyApproved(out, [{ proposal: GOOD, who: 'Katherine', ymd: '2026-11-09' }]), out);
});

test('LIST_UPDATED must move with the CHANGELOG: the guard names the date it needs', () => {
  const out = H.applyApproved(BAN, [{ proposal: GOOD, who: 'Katherine', ymd: '2026-11-09' }]);
  assert.strictEqual(H.lastChangelogDate(BAN), '10.09.2026');
  assert.strictEqual(H.lastChangelogDate(out), '11.09.2026');
  assert.strictEqual(H.listUpdatedOk(BAN, D.LIST_UPDATED), true);
  assert.strictEqual(H.listUpdatedOk(out, D.LIST_UPDATED), false, 'an approved tell without a LIST_UPDATED bump is caught');
});

test('the ledger file: read and append round-trip, missing file is an empty ledger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h3010-'));
  const f = path.join(dir, 'ledger.md');
  assert.deepStrictEqual(H.readLedger(f), []);
  H.appendLedger(f, { kind: 'run', ymd: '2026-11-09', who: 'hunt', key: '', note: '3 proposed' });
  H.appendLedger(f, { kind: 'reject', ymd: '2026-11-09', who: 'Katherine', key: H.keyOf(GOOD.pattern), note: 'too common in real copy' });
  const l = H.readLedger(f);
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l[1].kind, 'reject');
  assert.strictEqual(l[1].note, 'too common in real copy');
  assert.strictEqual(H.sinceDate(l), '2026-11-09');
});

test('the dry run: never writes the ban list, the lint or a card store; reports honestly when nothing is found', async () => {
  const none = await H.huntDry({ ask: async () => 'nothing new found', banText: BAN, ledger: [], today: '2026-11-09' });
  assert.strictEqual(none.cards.length, 0);
  assert.match(none.summary, /no new AI tells found since 10\.09\.2026/i);
  const some = await H.huntDry({ ask: async () => answer([GOOD, { ...GOOD, pattern: 'delve' }]), banText: BAN, ledger: [], today: '2026-11-09' });
  assert.strictEqual(some.cards.length, 1);
  assert.strictEqual(some.skipped.length, 1);
  assert.match(some.summary, /1 proposed-tell card/);
  const failed = await H.huntDry({ ask: async () => { throw new Error('answered 529'); }, banText: BAN, ledger: [], today: '2026-11-09' });
  assert.strictEqual(failed.ok, false);
  assert.match(failed.summary, /could not search: answered 529/);
});

test('it is not on the Producer calendar in this branch (a schedule change is Mimi\'s paste)', () => {
  const P = require('../lib/producer');
  assert.ok(!P.DEFAULT_WEEK.some((e) => e.agent === 'ai-tell-hunt'));
  // #3045: slice 2 shipped the card WITH its voice. It is a card only, so it is never on the calendar either.
  assert.ok(!P.DEFAULT_WEEK.some((e) => e.agent === 'ai-tell-detective'));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'agent-voices', 'ai-tell-detective_01.mp3')), 'the card ships with its voice');
});
