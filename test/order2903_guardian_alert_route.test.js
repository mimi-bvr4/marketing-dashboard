'use strict';
// ORDER #2903, ruling 5 (11.03.2026): a test Site Guardian alert lands with
// Mimi, not Katherine. The route sends nothing; it only decides who hears first.
const { test } = require('node:test');
const assert = require('node:assert');

const G = require('../lib/guardian-alerts');

test('acceptance: a test Site Guardian alert lands with Mimi, not Katherine', () => {
  const r = G.route({ kind: 'down', site: 'example.test', test: true });
  assert.deepStrictEqual(r.first, ['mimi']);
  assert.ok(!r.first.includes('katherine'));
});

test('every kind of alert goes to Mimi first and to nobody else first', () => {
  for (const kind of [...Object.keys(G.KINDS), 'something-new', undefined]) {
    const r = G.route({ kind });
    assert.deepStrictEqual(r.first, ['mimi'], String(kind));
    for (const who of G.NEVER_FIRST) assert.ok(!r.first.includes(who), `${kind}: ${who} is never first`);
  }
  assert.strictEqual(G.route({ kind: 'something-new' }).kind, 'unknown');
  assert.strictEqual(G.route().kind, 'unknown');
});

test('the route cannot be widened by a caller: each call gets its own copy', () => {
  const r = G.route({ kind: 'hack' });
  r.first.push('katherine');
  assert.deepStrictEqual(G.route({ kind: 'hack' }).first, ['mimi']);
  assert.throws(() => { 'use strict'; G.FIRST.push('katherine'); });
});

test('recipients are roles, never a phone number or an address', () => {
  for (const who of G.route({ kind: 'vulnerable' }).first) assert.match(who, /^[a-z]+$/);
});
