'use strict';
// ORDER #3158: Scout and Pinterest Paul showed red "last run failed" lines with
// the parser's own words on Katherine's home brief. Both failures happened
// BEFORE #2910 landed (Pinterest Paul 10.28, Scout 11.02 06:00; #2910 merged
// 11.03) and neither agent had run again, so the brief kept showing them.
// This test proves:
//   - each logged error, rebuilt at its exact position, is repaired or ends
//     in one honest failure, never a crash;
//   - the home brief, the Producer board and the failed run's card say it in
//     plain words, never "in JSON at position";
//   - an unreadable answer logs the bytes around its break, so the next one
//     can be quoted (the 10.28 and 11.02 answers were kept nowhere).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseModelJson, excerptAt } = require('../lib/agent-json');
const { runAgent, loadAgent, parseCards, draftCards } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const P = require('../lib/producer');
const TB = require('../public/team-brief');

const PAUL_LOGGED = "Expected ',' or ']' after array element in JSON at position 2092 (line 1 column 2093)";
const SCOUT_LOGGED = "Expected ',' or '}' after property value in JSON at position 10934 (line 1 column 10935)";

// Pinterest Paul, 10.28: a quote inside a keyword the model did not escape,
// placed so the parser stops at character 2093, as logged.
function paulText() {
  const head = '{"cards":[{"title":"Pin idea: the barn at golden hour","body":"';
  const tail = '","pin":{"title":"Barn weddings","keywords":["the ';
  const fill = 'Golden hour at the barn. '.repeat(100).slice(0, 2091 - head.length - tail.length);
  return head + fill + tail + '"best barn" in town"]}}]}';
}
// Scout, 11.02: the same shape #2910 rebuilt, break at character 10935.
function scoutText() {
  const prefix = '{"cards":[{"title":"Scout: rooftop venues this week","target":"saddlewoodsfarm.com","body":"';
  const filler = 'Venue note for the week. '.repeat(500).slice(0, 10933 - prefix.length);
  return prefix + filler + '"the best barn" in Nashville, one couple wrote."}]}';
}

test('both rebuilt answers break exactly where the Box logged them', () => {
  assert.throws(() => JSON.parse(paulText()), (e) => e.message === PAUL_LOGGED);
  assert.throws(() => JSON.parse(scoutText()), (e) => e.message === SCOUT_LOGGED);
});

test('both are repaired into a card today (the #2910 parser), no crash', () => {
  for (const t of [paulText(), scoutText()]) {
    const c = parseCards(t, 3);
    assert.strictEqual(c.length, 1);
    assert.ok(parseModelJson(t).repairs.includes('unescaped quote'));
  }
});

test('anything else broken: one honest badJson error with an excerpt, never a crash', () => {
  for (const t of ['{"cards":[{"title":"A" "body":"b"}]}', '{"cards":[1 2]}', '{"cards": nope', 'no json at all']) {
    let err = null;
    try { parseModelJson(t); } catch (e) { err = e; }
    if (err) assert.strictEqual(err.badJson, true, t);
  }
  const s = 'x'.repeat(200) + 'BREAK' + 'y'.repeat(200);
  const ex = excerptAt(s, 200);
  assert.match(ex, /BREAK/);
  assert.match(ex, /characters 120 to 280 of 405, break at 200/);
  assert.strictEqual(excerptAt(s, -1), null);
  assert.match(excerptAt('a\n"b', 1), /a\\n\\"b/, 'one line, line breaks shown as \\n');
});

test('plainNote: parser words become a sentence a person can act on', () => {
  for (const n of [PAUL_LOGGED, SCOUT_LOGGED, "the model's answer was not valid JSON twice (last: Unexpected token n in JSON at position 10)"]) {
    const p = TB.plainNote(n);
    assert.match(p, /^The model's answer came back garbled and could not be read, so nothing was saved\. It tries again on its next run\.$/);
    assert.doesNotMatch(p, /position|JSON|Expected/);
  }
  assert.match(TB.plainNote("the model's answer was not valid JSON twice (cut off at the length limit; last: Unterminated string in JSON at position 5)"),
    /^The model's answer was cut off before it finished/);
  // Any other reason passes through unchanged (one line).
  assert.strictEqual(TB.plainNote('model answered 401: invalid x-api-key'), 'model answered 401: invalid x-api-key');
  assert.ok(TB.plainNote(SCOUT_LOGGED).length <= TB.REASON_MAX);
});

test('home brief: the failed row reads in plain words', () => {
  const b = TB.split([{ name: 'Pinterest Paul', last_run: { status: 'failed', note: PAUL_LOGGED } },
    { name: 'Competition Scout', last_run: { status: 'failed', note: SCOUT_LOGGED } }]);
  assert.strictEqual(b.failed.length, 2);
  for (const f of b.failed) assert.doesNotMatch(f.reason, /position|Expected/);
});

test('Producer board: "last run failed 10.28" with the plain sentence, not the parser', () => {
  const def = (slug) => ({ ...loadAgent(slug) });
  const history = new Map([
    ['pinterest-paul', [{ started_at: new Date('2026-10-28T15:00:00Z'), status: 'failed', cards: 1, unavailable: [], note: PAUL_LOGGED }]],
  ]);
  const line = P.board({ ymd: '2026-11-08', defs: ['pinterest-paul'].map(def), history })[0].line;
  assert.match(line, /^last run failed 10\.28: The model's answer came back garbled/);
  assert.doesNotMatch(line, /position|Expected/);
});

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3158-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\nA rooftop opened downtown.\n');
  return { IHG_TREE: root };
}
function model(answers, stops = []) {
  const calls = [];
  return { model: 'fake', calls, lastStop: null,
    async complete(req) { calls.push(req); this.lastStop = stops[calls.length - 1] || 'end_turn'; return answers[Math.min(calls.length - 1, answers.length - 1)]; } };
}

test('two unreadable answers: each logs its bytes, one FAILED line, the card says it plainly', async (t) => {
  const store = createMemoryStore({ lint });
  const llm = model(['{"cards":[{"title":"broken one" x}]}', '{"cards":[{"title":"broken two" y}]}']);
  const lines = [];
  const def = { ...loadAgent('scout'), copy_prepass: false, sources: [{ type: 'file', path: 'notes.md', required: true, label: 'the notes' }] };
  const r = await runAgent({ def, store, llm, env: tree(t), log: (l) => lines.push(l), fetchImpl: async () => { throw new Error('no network'); } });
  assert.strictEqual(r.ok, false);
  const near = lines.filter((l) => /answer unreadable/.test(l));
  assert.strictEqual(near.length, 2, lines.join('\n'));
  assert.match(near[0], /^scout: first answer unreadable \(stop end_turn\), near the break: .*broken one/);
  assert.match(near[1], /^scout: second answer unreadable .*broken two/);
  assert.strictEqual(lines.filter((l) => /FAILED/.test(l)).length, 1);
  const card = r.cards.find((c) => /run failed/.test(c.title));
  assert.ok(card, 'the failure notice card');
  assert.match(card.body, /The run stopped: The model's answer came back garbled/);
  assert.doesNotMatch(card.body, /in JSON at position|Expected ','/);
});

test('the Asks triage gets the same repair: an unescaped quote no longer fails it', () => {
  const { parseTriage } = require('../lib/agent-asks');
  const t = parseTriage('Here: {"kind":"cant","reason":"it would post as "Katherine" live","instead":"draft it",}');
  assert.strictEqual(t.kind, 'cant');
  assert.match(t.reason, /"Katherine"/);
  assert.throws(() => parseTriage('{"kind": nope}'), (e) => e.badJson === true);
});

test('draftCards without a log still works (callers that pass none)', async () => {
  const good = JSON.stringify({ cards: [{ title: 'T', body: 'B' }] });
  const c = await draftCards(model(['{"cards": nope', good]), { system: 's', user: 'u', maxTokens: 10, max: 3 });
  assert.strictEqual(c[0].title, 'T');
});
