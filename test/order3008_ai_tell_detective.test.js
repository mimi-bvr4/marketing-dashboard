// ORDER #3008: the AI Tell Detective (slice 1: the engine, the check endpoint
// behind AI_TELL_DETECTIVE default OFF, the Review page box).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { lint } = require('../lib/ai-tells');
const d = require('../lib/ai-tell-detective');

const AI = "In today's fast-paced world, planning an event is hard — so let's delve into it. "
  + 'Our venue is elegant, timeless, and unforgettable.';
const HUMAN = 'The Riverfront Terrace fits about 120 for a seated dinner, depending on the floor plan. '
  + 'Last June a couple got married there in the rain. We moved the ceremony under the awning in ten minutes.';

test('acceptance: a known AI-ish paragraph is flagged, each hit with its rule number', () => {
  const r = d.check(AI);
  assert.match(r.verdict, /^Sounds like AI \(\d+\)$/);
  const rules = r.hits.map((h) => h.rule_no);
  for (const n of [1, 4, 7, 11]) assert.ok(rules.includes(n), `rule ${n} flagged: ${JSON.stringify(rules)}`);
  for (const h of r.hits) {
    assert.ok(h.why && h.fix, 'every hit says why and how to fix it');
    assert.ok(h.line >= 1);
  }
  assert.ok(r.hits.find((h) => h.rule_no === 1).blocks_ready, 'an em dash still blocks ready');
});

test('acceptance: the clean rewrite has no tells and keeps the facts', () => {
  const r = d.check(AI);
  const again = lint(r.rewrite);
  assert.ok(again.clean, `rewrite still has hits: ${JSON.stringify(again)} in ${r.rewrite}`);
  assert.deepStrictEqual(r.rewrite_left, []);
  assert.match(r.rewrite, /venue is elegant and timeless\./);
  assert.match(r.rewrite, /^Planning an event is hard, so let's look at it\./);
});

test('acceptance: a human paragraph sounds human, and its text comes back unchanged', () => {
  const r = d.check(HUMAN);
  assert.strictEqual(r.verdict, 'Sounds human');
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.rewrite, HUMAN);
});

test('one source of truth: the Detective reports exactly the lint hits', () => {
  for (const t of [AI, HUMAN, '## Our Amazing Wedding Venue Guide\nAdditionally, it boasts a stunning view. Stunning!', 'It holds 300 guests.']) {
    const l = lint(t);
    assert.strictEqual(d.check(t).count, l.fails.length + l.flags.length);
  }
});

test('rule of three: adjectives are flagged, a plain list of nouns is not', () => {
  assert.ok(lint('A day that is romantic, intimate, and magical.').flags.some((f) => f.rule === 'rule of three'));
  assert.ok(!lint('We serve salads, mains and desserts.').flags.some((f) => f.rule === 'rule of three'));
  assert.ok(!lint('Guests from Nashville, Atlanta and Memphis.').flags.some((f) => f.rule === 'rule of three'));
});

test('rewrite leaves quoted words alone and fixes headings, openers, bold', () => {
  const out = d.rewrite('Additionally, the room **boasts** a view.\n## Our Amazing Wedding Venue Guide\nShe said "let\'s delve in".');
  assert.match(out, /^The room has a view\./);
  assert.match(out, /## Our amazing wedding venue guide/);
  assert.match(out, /"let's delve in"/);
  const left = d.check('It holds 300 guests.').rewrite_left;
  assert.strictEqual(left[0].rule_no, 'house', 'a hard capacity is left for a person, never invented');
});

test('the footer names the list date, and the date matches the ban list when the tree is here', () => {
  assert.strictEqual(d.check('x').footer, `Checked against IHG's AI-tell list (updated ${d.LIST_UPDATED}).`);
  const list = path.join(__dirname, '..', '..', '..', 'Full_IH_Project', '07_Marketing_and_Brand', 'AI_TELLS_BAN_LIST.md');
  if (!fs.existsSync(list)) return;
  const dates = [...fs.readFileSync(list, 'utf8').matchAll(/^- (\d\d\.\d\d\.\d{4})/gm)].map((m) => m[1]);
  assert.strictEqual(dates[dates.length - 1], d.LIST_UPDATED, 'bump LIST_UPDATED with the ban list CHANGELOG');
});

test('switch: AI_TELL_DETECTIVE is OFF unless set', () => {
  assert.strictEqual(d.on({}), false);
  assert.strictEqual(d.on({ AI_TELL_DETECTIVE: '0' }), false);
  assert.strictEqual(d.on({ AI_TELL_DETECTIVE: 'on' }), true);
});

test('the route answers 404 while off and the Detective report while on; the page falls back to the lint', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'review.js'), 'utf8');
  assert.match(src, /\/api\/review\/detective', need/);
  assert.match(src, /if \(!detective\.on\(\)\) return res\.status\(404\)/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.ok(page.indexOf('/api/review/detective') < page.indexOf("api('/api/review/lint'"));
});

test('pure: no model call, no network, nothing stored', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai-tell-detective.js'), 'utf8');
  assert.doesNotMatch(src, /fetch\(|require\('(https?|pg|\.\/agent-llm|\.\.\/db)'\)/);
});
