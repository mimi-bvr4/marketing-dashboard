'use strict';
// ORDER #2910: Scout and Convention Connector stop failing on malformed JSON,
// and the board says why an agent failed or waits, with no secret in it.
// Acceptance (the order's own lines):
//   - a test feeds both exact failures from the Box log (a key with no colon at
//     column 11; a break around column 10935) and proves a card comes out or a
//     clean failure is logged;
//   - the reason is on the board line and the 06:00 log line, secret-free.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseModelJson } = require('../lib/agent-json');
const { safeReason } = require('../lib/safe-reason');
const { runAgent, loadAgent, parseCards } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const P = require('../lib/producer');

const CC_LOGGED = "Expected ':' after property name in JSON at position 10 (line 1 column 11)";
const SCOUT_LOGGED = "Expected ',' or '}' after property value in JSON at position 10934 (line 1 column 10935)";

// Convention Connector, 10.26: a key with no colon at column 11.
const CC_TEXT = '{"cards"  [{"title":"Convention lead: Music City Center week","target":"Cannery Hall","body":"A group of 400 meets downtown on 11.18.2026. Cannery Hall is a short walk."}]}';

// Scout, 11.02: a double quote inside the body that the model did not escape,
// landing so the parser stops at character 10935.
function scoutText() {
  const prefix = '{"cards":[{"title":"Scout: rooftop venues this week","target":"saddlewoodsfarm.com","body":"';
  const unit = 'Venue note for the week. ';
  let filler = unit.repeat(Math.ceil(10933 / unit.length)).slice(0, 10933 - prefix.length);
  return prefix + filler + '"the best barn" in Nashville, one couple wrote."}]}';
}

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt2910-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\nA group of 400 meets downtown on 11.18.2026.\n');
  return { IHG_TREE: root };
}

const defFor = (slug) => ({ ...loadAgent(slug), copy_prepass: false,
  sources: [{ type: 'file', path: 'notes.md', required: true, label: 'the notes' }] });

function model(answers, stops = []) {
  const calls = [];
  return { model: 'fake', calls, lastStop: null,
    async complete(req) { calls.push(req); this.lastStop = stops[calls.length - 1] || 'end_turn'; return answers[Math.min(calls.length - 1, answers.length - 1)]; } };
}

test('the two logged failures are exactly what JSON.parse said on the Box', () => {
  assert.throws(() => JSON.parse(CC_TEXT), (e) => e.message === CC_LOGGED);
  const s = scoutText();
  assert.throws(() => JSON.parse(s), (e) => e.message === SCOUT_LOGGED);
});

test('both are repaired into cards by the parser', () => {
  const cc = parseCards(CC_TEXT, 3);
  assert.strictEqual(cc.length, 1);
  assert.match(cc[0].title, /^Convention lead/);
  const sc = parseCards(scoutText(), 3);
  assert.strictEqual(sc.length, 1);
  assert.match(sc[0].body, /"the best barn" in Nashville, one couple wrote\.$/);
  assert.deepStrictEqual(parseModelJson(scoutText()).repairs, ['unescaped quote', 'unescaped quote']);
});

test('prose with its own brace before the JSON, a fence, a raw line break and a trailing comma', () => {
  const t = 'Here is {one} note.\n```json\n{"cards":[{"title":"A","body":"line one\nline two",},]}\n```';
  const c = parseCards(t, 3);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].body, 'line one\nline two');
});

test('a cut-off answer keeps the whole cards and drops the unfinished one (no partial card)', () => {
  const t = '{"cards":[{"title":"Whole","body":"done"},{"title":"Half","body":"this one was cut off at the lim';
  const c = parseCards(t, 3);
  assert.deepStrictEqual(c.map((x) => x.title), ['Whole']);
});

test('Scout and Convention Connector runs with the logged answers save a card, no retry needed', async (t) => {
  for (const [slug, text] of [['scout', scoutText()], ['convention-connector', CC_TEXT]]) {
    const store = createMemoryStore({ lint });
    const llm = model([text]);
    const lines = [];
    const r = await runAgent({ def: defFor(slug), store, llm, env: tree(t), log: (l) => lines.push(l), fetchImpl: async () => { throw new Error('no network'); } });
    assert.strictEqual(r.ok, true, `${slug}: ${r.error}`);
    assert.ok(r.cards.length >= 1);
    assert.doesNotMatch(r.cards[0].title, /run failed/);
    assert.ok(!lines.some((l) => /FAILED/.test(l)), lines.join('\n'));
  }
});

test('an unreadable answer is asked again once; the second answer is used', async (t) => {
  const store = createMemoryStore({ lint });
  const good = JSON.stringify({ cards: [{ title: 'Scout: second try', target: 'x', body: 'A short note.' }] });
  const llm = model(['I could not find anything {sorry', good]);
  const r = await runAgent({ def: defFor('scout'), store, llm, env: tree(t), fetchImpl: async () => { throw new Error('no network'); } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(llm.calls.length, 2);
  assert.match(llm.calls[1].user, /YOUR LAST ANSWER COULD NOT BE READ/);
  assert.strictEqual(r.cards[0].title, 'Scout: second try');
});

test('a cut-off at the length limit is asked for fewer, shorter cards', async (t) => {
  const store = createMemoryStore({ lint });
  const good = JSON.stringify({ cards: [{ title: 'Short', body: 'Short.' }] });
  const llm = model(['{"cards":[{"title":"Half","body":"cut', good], ['max_tokens', 'end_turn']);
  const r = await runAgent({ def: defFor('scout'), store, llm, env: tree(t), fetchImpl: async () => { throw new Error('no network'); } });
  assert.strictEqual(r.ok, true);
  assert.match(llm.calls[1].user, /cut off at the length limit/);
  assert.match(llm.calls[1].user, /fewer cards/);
});

test('when the retry is unreadable too: one clear FAILED line and no partial card', async (t) => {
  const store = createMemoryStore({ lint });
  const llm = model(['{"cards": nope', 'still {"cards" nope']);
  const lines = [];
  const r = await runAgent({ def: defFor('scout'), store, llm, env: tree(t), log: (l) => lines.push(l), fetchImpl: async () => { throw new Error('no network'); } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(llm.calls.length, 2);
  const failed = lines.filter((l) => /FAILED/.test(l));
  assert.strictEqual(failed.length, 1);
  assert.match(failed[0], /^scout: FAILED the model's answer was not valid JSON twice/);
  assert.deepStrictEqual(r.cards.map((c) => c.title), ['Scout run failed'], 'only the failure notice, never a half card');
});

test('safeReason strips links with keys, emails and tokens', () => {
  const s = safeReason('Search Console answered 403 at https://searchconsole.googleapis.com/v1/sites?key=AIzaSyA1234567890abcdefghijklmnop for brain@infinityhospitality.net with Bearer ya29.a0AfH6SMBxyzxyzxyzxyz');
  assert.doesNotMatch(s, /AIza|ya29|@|\?key=/);
  assert.match(s, /searchconsole\.googleapis\.com/);
  assert.match(s, /\(email\)/);
  assert.strictEqual(safeReason("no read-only marketing key on this machine (Keychain item 'marketing-fleet-key', minted at /settings/api-tokens)"),
    "no read-only marketing key on this machine (Keychain item 'marketing-fleet-key', minted at /settings/api-tokens)");
  assert.ok(safeReason('x'.repeat(10) + ' ' + 'word '.repeat(100)).length <= 160);
});

test('the board says why: a failed run, a waiting source, and another missing source', () => {
  const def = (slug) => ({ ...loadAgent(slug) });
  const history = new Map([
    ['pinterest-paul', [{ started_at: new Date('2026-10-28T15:00:00Z'), status: 'failed', cards: 1, unavailable: [],
      note: 'Pinterest answered 401 for https://api.pinterest.com/v5/boards?access_token=pina_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }]],
    ['email', [{ started_at: new Date('2026-11-03T12:00:00Z'), status: 'done', cards: 1,
      unavailable: [{ label: 'HubSpot email stats', why: "no read-only marketing key on this machine (Keychain item 'marketing-fleet-key')" }] }]],
  ]);
  const b = P.board({ ymd: '2026-11-03', defs: ['pinterest-paul', 'email'].map(def), history });
  const line = (s) => b.find((x) => x.slug === s).line;
  assert.match(line('pinterest-paul'), /^last run failed 10\.28: Pinterest answered 401 for api\.pinterest\.com$/);
  assert.doesNotMatch(line('pinterest-paul'), /pina_|access_token/);
  assert.match(line('email'), /HubSpot email stats: no read-only marketing key on this machine/);
  const seo = { slug: 'seo', name: 'SEO', sources: [{ type: 'search_console', required: true, label: 'Search Console' }] };
  const h2 = new Map([['seo', [{ started_at: new Date('2026-11-02T12:00:00Z'), status: 'done', cards: 1,
    unavailable: [{ label: 'Search Console', why: 'Search Console has none of our sites open to the Box yet.' }] }]]]);
  assert.strictEqual(P.board({ ymd: '2026-11-03', defs: [seo], history: h2 })[0].line,
    'waiting on Search Console since 11.02 (Search Console has none of our sites open to the Box yet.)');
});

test('the 06:00 log line names each missing source with its reason', async (t) => {
  const store = createMemoryStore({ lint });
  const d = { ...defFor('scout'), sources: [{ type: 'file', path: 'notes.md', required: true, label: 'the notes' },
    { type: 'file', path: 'missing.md', label: 'the missing file' }] };
  const lines = [];
  await runAgent({ def: d, store, llm: model([JSON.stringify({ cards: [{ title: 'A', body: 'B.' }] })]), env: tree(t), log: (l) => lines.push(l),
    fetchImpl: async () => { throw new Error('no network'); } });
  assert.ok(lines.includes('scout: 1 sources read, 1 unavailable (the missing file: missing.md not found)'), lines.join('\n'));
});
