// ORDER #3605: Mimi's ruling of 11.18.2026 on The Bridge Building.
// 610 seated is across several floors; 1,200 guests is the whole building.
// Copy must never say or imply 1,200 or 610 in one room or on one floor.
// The draft lint (every agent draft and the Review tab's "Check text") flags it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { lint, oneRoomCapacity } = require('../lib/ai-tells');
const { loadAgent } = require('../lib/agent-runner');

const RULE = 'TBB one-room capacity';
const hits = (t) => lint(t).flags.filter((f) => f.rule === RULE);

test('flags 1,200 or 610 paired with one room or floor', () => {
  for (const t of [
    'The ballroom holds up to 1,200 guests.',
    'Our rooftop terrace seats 610 for dinner.',
    'Up to 1200 guests fit in the main hall.',
    "The Bridge Building's top floor welcomes 1,200 guests.",
    'Seat 610 guests in one room overlooking the river.',
  ]) {
    assert.strictEqual(hits(t).length, 1, t);
  }
});

test('does not flag the building-wide wording Mimi approved', () => {
  for (const t of [
    '610 seated across our floors.',
    'Up to 1,200 guests across the building.',
    'For seated dinners, The Bridge Building accommodates up to 610 guests across all event spaces combined.',
    '... space for up to around 1,200 guests across its indoor and outdoor areas.',
    'Accommodates up to 1,200 guests',
  ]) {
    assert.strictEqual(hits(t).length, 0, t);
  }
});

test('a price or a bigger number is not the TBB capacity', () => {
  assert.deepStrictEqual(oneRoomCapacity('The room fee starts at $1,200.'), []);
  assert.deepStrictEqual(oneRoomCapacity('The room fits 6100 square feet.'), []);
  assert.deepStrictEqual(oneRoomCapacity('A floor of 21,200 square feet.'), []);
  assert.deepStrictEqual(oneRoomCapacity('The hall is 1,200,000 lumens bright.'), []);
});

test('the flag is reported with its line', () => {
  const r = lint('Line one.\nThe ballroom holds 1,200.');
  const f = r.flags.find((x) => x.rule === RULE);
  assert.ok(f);
  assert.strictEqual(f.line, 2);
  assert.strictEqual(r.clean, false);
});

test("the Fact-Checker's skill carries the TBB rule", () => {
  const c = loadAgent('citations');
  assert.match(c.skill, /ORDER #3605/);
  assert.match(c.skill, /610 seated across our floors/);
  assert.match(c.skill, /1,200 guests across the building/);
});
