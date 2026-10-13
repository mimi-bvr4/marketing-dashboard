'use strict';
// ORDER #1675 (Mimi, 10.12.2026): the Marketing Dashboard restyled on the
// approved IH tokens, like dispatch and planning. Same selectors and ids, so
// every number and script is untouched.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('index loads the approved tokens and Inter, and its style block uses them', () => {
  const html = read('index.html');
  assert.match(html, /ihg-tokens\.css/);
  assert.match(html, /family=Inter/);
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.match(css, /var\(--ihg-color-bg\)/);
  for (const old of ['#1a365d', '#2c5282', '#6366f1', '#0ea5e9', '#c8a45c', '#fef3c7', '#10b981', '#f59e0b']) {
    assert.ok(!html.toLowerCase().includes(old), 'old palette colour still on the page: ' + old);
  }
});

test('no inline colour styles left in the markup or the drawn rows', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /style="[^"]*color:#/i);
  assert.doesNotMatch(html, /style="[^"]*background:#/i);
});

test('every id the scripts write to is still on the page', () => {
  const html = read('index.html');
  const ids = ['kpi-spend', 'kpi-leads', 'kpi-bookings', 'kpi-cancelled', 'kpi-revenue', 'kpi-roas', 'goal-fill', 'goal-pace-marker', 'ai-body', 'ceo-revenue-body', 'ceo-missing-count', 'proj-missing-count', 'trend-chart', 'tabbtn-ihg', 'tabbtn-elle'];
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), 'missing #' + id);
});

test('the page scripts still parse', () => {
  const html = read('index.html');
  const blocks = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0);
  for (const b of blocks) new vm.Script(b);
});

test('no em dash in headings or footnote prose', () => {
  const html = read('index.html');
  for (const m of html.matchAll(/<(h2|h3)[^>]*>([\s\S]*?)<\/\1>/g)) assert.doesNotMatch(m[2], /&mdash;\s*[A-Za-z]|— [A-Za-z]/, m[2]);
  for (const m of html.matchAll(/<div class="footnote"[^>]*>([\s\S]*?)<\/div>/g)) assert.doesNotMatch(m[1], / &mdash; /);
});

test('the API keys page is on the tokens too', () => {
  const html = read('api-tokens.html');
  assert.match(html, /ihg-tokens\.css/);
  assert.match(html, /var\(--ihg-color-text\)/);
});
