'use strict';
// ORDER #1678 (Mimi, 10.12.2026): the Marketing Dashboard opens on a Home band
// (what needs Katherine, her team, open Saturdays, competitor moves, the goal).
// ORDER #3116 (Mimi, 11.07.2026, "Brief only"): the numbers that used to follow
// the band moved to Katherine's Numbers (numbers.html); home is the band only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const numbers = fs.readFileSync(path.join(__dirname, '..', 'public', 'numbers.html'), 'utf8');

test('Home is the band only; the numbers live on numbers.html under their own heading', () => {
  assert.ok(html.indexOf('<section class="home" id="home"') > 0);
  assert.strictEqual(html.indexOf('<div class="goal-section">'), -1, 'no numbers under the brief (#3116)');
  const numbersHead = numbers.indexOf('id="numbers"');
  const goal = numbers.indexOf('<div class="goal-section">');
  assert.ok(numbersHead > 0 && numbersHead < goal);
});

test('every Home card reads an existing route and fails on its own with a sentence', () => {
  for (const u of ['/api/review/cards?status=draft', '/api/agents', '/api/open-dates?months=3', '/api/competitors', '/api/revenue-goal']) assert.ok(html.includes(`get('${u}')`), u);
  assert.ok(/could not load right now/.test(html));
  for (const id of ['home-drafts', 'home-open-sat', 'home-comp', 'home-goal', 'home-review', 'home-team', 'home-open', 'home-competitors']) assert.ok(html.includes(`id="${id}"`), id);
});

test('all page scripts parse; the Home band uses tokens only', () => {
  for (const m of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
  const css = html.slice(html.indexOf('.home {'), html.indexOf('</style>'));
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,6}\b/i, 'no raw colours in the Home styles');
});
