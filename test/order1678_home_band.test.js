'use strict';
// ORDER #1678 (Mimi, 10.12.2026): the Marketing Dashboard opens on a Home band
// (what needs Katherine, her team, open Saturdays, competitor moves, the goal),
// with the numbers below. No new routes: it reads the ones the page has.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('Home comes first in the Infinity panel, the numbers follow under their own heading', () => {
  const panel = html.indexOf('<div id="panel-ihg"');
  const home = html.indexOf('<section class="home" id="home"');
  const numbers = html.indexOf('id="numbers"');
  const goal = html.indexOf('<div class="goal-section">');
  assert.ok(panel < home && home < numbers && numbers < goal);
});

test('every Home card reads an existing route and fails on its own with a sentence', () => {
  for (const u of ["/api/review/cards?status=draft", "/api/agents", "/api/open-dates?months=3", "/api/competitors"]) assert.ok(html.includes(`get('${u}')`), u);
  assert.strictEqual((html.match(/could not load right now/g) || []).length >= 2, true);
  for (const id of ['home-drafts', 'home-open-sat', 'home-comp', 'home-goal', 'home-review', 'home-team', 'home-open', 'home-competitors']) assert.ok(html.includes(`id="${id}"`), id);
});

test('all page scripts parse; the Home band uses tokens only', () => {
  for (const m of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
  const css = html.slice(html.indexOf('.home {'), html.indexOf('</style>'));
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,6}\b/i, 'no raw colours in the Home styles');
});
