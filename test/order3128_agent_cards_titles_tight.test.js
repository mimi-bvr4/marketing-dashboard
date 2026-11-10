'use strict';
// ORDER #3128 (Mimi 11.07.2026 on /agents): "they all need the titles and then
// the name. and they need to be tighter, lots of empty space on the cards."
// Every card has a title line above the name, a name is never clipped, cards
// are as tall as their own content, and a paused member shows one box.
// No express here, so it runs in a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const V = require('../public/agents-view');
const { listAgents, loadAgent } = require('../lib/agent-runner');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');

test('every agent has a non-empty title, and it shows above its default name', () => {
  const slugs = listAgents();
  assert.strictEqual(slugs.length, 21); // #3163 the Keyword Queen
  // #3163: the order names her title THE KEYWORD QUEEN and her name "Keyword
  // Queen", the same words, so the #2941 rule shows it once until she is renamed.
  const SAME_BY_ORDER = { 'keyword-queen': 'The Keyword Queen' };
  for (const slug of slugs) {
    const d = loadAgent(slug);
    const role = d.character && d.character.role;
    assert.ok(role && String(role).trim(), `${slug}: has a title`);
    if (SAME_BY_ORDER[slug]) { assert.strictEqual(role, SAME_BY_ORDER[slug]); assert.strictEqual(V.showEyebrow(role, d.name), false); continue; }
    assert.strictEqual(V.showEyebrow(role, d.name), true, `${slug}: "${role}" shows above "${d.name}"`);
    assert.doesNotMatch(role, /—/, `${slug}: no em dash`);
  }
});

test('the four ruled titles', () => {
  assert.strictEqual(loadAgent('collateral-cadet').character.role, 'The archivist');
  assert.strictEqual(loadAgent('engagement-sleuth').character.role, 'The matchmaker');
  assert.strictEqual(loadAgent('planner-scout').character.role, 'The traveler');
  assert.strictEqual(loadAgent('scout').character.role, 'The lookout');
});

test('a name shrinks a step at a time until it fits, and says so when nothing fits', () => {
  const at = (perPx) => (px) => px * perPx; // width grows with the type size
  assert.strictEqual(V.fitFontPx(at(10), 300, 24), 24, 'fits at full size');
  assert.strictEqual(V.fitFontPx(at(10), 200, 24), 20, 'one or two steps down');
  assert.strictEqual(V.fitFontPx(at(10), 150, 21), 15, 'starts from the size the page drew');
  assert.strictEqual(V.fitFontPx(at(10), 100, 24), null, 'nothing fits: the page stacks the portrait');
  const steps = [];
  V.fitFontPx((px) => { steps.push(px); return 999; }, 10, 21);
  assert.deepStrictEqual(steps, [21, 20, 18, 16, 15], 'never larger than the start, smallest 15px');
});

test('the page fits card names and never clips them with an ellipsis', () => {
  assert.match(HTML, /const fitNames = \(\) => main\.querySelectorAll\('\.card input\.name'\)\.forEach\(fitName\);/);
  assert.match(HTML, /if \(!a\) fitNames\(\);/, 'after the roster renders');
  assert.match(HTML, /window\.addEventListener\('resize'/, 'and when the window changes size');
  assert.match(HTML, /if \(i\.closest\('\.card'\)\) fitName\(i\);/, 'and after a rename');
  assert.match(HTML, /\.card \.who\.stack \{ flex-direction: column;/);
  assert.doesNotMatch(HTML, /text-overflow:\s*ellipsis/);
});

test('one box: the switch-on need drops out when the Paused line names the same switch', () => {
  const paused = 'off until Mimi switches it on (AGENT_PLANNER_SCOUT)';
  const needs = ['Mimi: switch it on (AGENT_PLANNER_SCOUT)', 'Mimi: name the salesperson who sends its drafts'];
  assert.deepStrictEqual(V.cardBoxes(needs, paused), { needs: ['Mimi: name the salesperson who sends its drafts'], paused });
  assert.deepStrictEqual(V.cardBoxes(['Mimi: switch it on (AGENT_GALA_SCOUT)'], 'off until Mimi switches it on (AGENT_GALA_SCOUT)').needs, []);
  // a different switch, or a pause for another reason, keeps every need
  assert.deepStrictEqual(V.cardBoxes(['Mimi: switch it on (AGENT_X)'], 'off until Mimi switches it on (AGENT_Y)').needs, ['Mimi: switch it on (AGENT_X)']);
  assert.deepStrictEqual(V.cardBoxes(['Katherine: a sheet'], 'until the ads sheet exists'), { needs: ['Katherine: a sheet'], paused: 'until the ads sheet exists' });
  assert.deepStrictEqual(V.cardBoxes(undefined, null), { needs: [], paused: null });
  assert.match(HTML, /\$\{boxes\.paused \? `<div class="need"><strong>Paused:<\/strong>/);
});

test('tight cards: own height, status and schedule on one line, smaller gaps and padding', () => {
  assert.match(HTML, /\.grid \{[^}]*align-items: start;/, 'no equal-height stretching');
  assert.match(HTML, /\.card \{[^}]*padding: 15px;[^}]*gap: 7px;/, 'padding 20 to 15, gap 14 to 7');
  assert.match(HTML, /\.who \{ display: flex; gap: 10px;/, 'portrait gap 14 to 10');
  assert.match(HTML, /\.card \.line \{ flex-wrap: nowrap;/, 'pill and schedule share one line');
  assert.match(HTML, /<span class="pill \$\{st\.cls\}">\$\{st\.label\}<\/span><span class="sched">/);
});

test('no em dashes in the page', () => {
  assert.doesNotMatch(HTML, /—/);
});
