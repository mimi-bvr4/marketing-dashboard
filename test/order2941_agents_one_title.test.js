'use strict';
// ORDER #2941: the team page has one title, a card shows its role eyebrow only
// when the name differs from it, and the Producer card is collapsed to one row.
// No express here, so it runs in a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const V = require('../public/agents-view');
const { listAgents, loadAgent } = require('../lib/agent-runner');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');

test('the eyebrow rule: the same name means no eyebrow', () => {
  assert.strictEqual(V.showEyebrow('The producer', 'The Producer'), false);
  assert.strictEqual(V.showEyebrow('THE PRODUCER', 'The Producer'), false);
  assert.strictEqual(V.showEyebrow('The producer', 'Producer'), false, 'a leading "the" is not a difference');
  assert.strictEqual(V.showEyebrow('Convention connector', 'Convention Connector'), false);
  assert.strictEqual(V.showEyebrow('Convention connector', ' convention-connector '), false, 'case, spacing and punctuation are not a difference');
  assert.strictEqual(V.showEyebrow('', 'Bloggy Bob'), false, 'no role, nothing to show');
});

test('the eyebrow rule: a renamed agent shows the eyebrow', () => {
  assert.strictEqual(V.showEyebrow('Convention connector', 'Convention Charles'), true);
  assert.strictEqual(V.showEyebrow('The producer', 'Polly'), true);
  assert.strictEqual(V.showEyebrow('The night watch', 'Site Guardian'), true);
});

test('every real team member follows the rule on its default name and on a rename', () => {
  for (const slug of listAgents()) {
    const d = loadAgent(slug);
    const role = d.character && d.character.role;
    if (!role) continue;
    assert.strictEqual(V.showEyebrow(role, role), false, `${slug}: named after its role, shown once`);
    assert.strictEqual(V.showEyebrow(role, `${d.name} the Second`), true, `${slug}: renamed, eyebrow back`);
  }
});

test('the page uses the rule on every character card, the profile and the Producer', () => {
  assert.match(HTML, /<script src="\/agents-view\.js"><\/script>/);
  assert.match(HTML, /eyebrow\(a\.slug, a\.character\.role, a\.name\)/, 'character cards');
  assert.match(HTML, /eyebrow\('producer', 'The producer', p\.name\)/, 'the Producer');
  assert.match(HTML, /V\.showEyebrow\(c\.role, a\.name\)/, 'the profile page');
  assert.doesNotMatch(HTML, /<span class="role">\$\{esc\(a\.character\.role\)\}<\/span>/, 'no unconditional eyebrow left');
  assert.match(HTML, /syncEyebrow\(a\.slug, r\.name\)/, 'a rename updates the eyebrow at once');
});

test('one title: the band, no second heading on the team page', () => {
  assert.match(HTML, /<div class="wordmark">[^<]*<span[^>]*><\/span>Katherine's Team<\/div>/);
  assert.doesNotMatch(HTML, /<h1/i);
  assert.doesNotMatch(HTML, /Katherine's marketing team/);
});

test('the Producer is collapsed by default behind "Show the week"', () => {
  assert.match(HTML, /let producerOpen = false;/);
  assert.match(HTML, /<div class="pweek" id="pweek" \$\{producerOpen \? '' : 'hidden'\}>/);
  assert.match(HTML, /'Show the week'/);
  // the calendar and the stuck list live inside the collapsed part
  const start = HTML.indexOf('<div class="pweek"');
  assert.ok(start > 0 && HTML.indexOf('<div class="week">') > start && HTML.indexOf('Who is stuck') > start);
});

test('who is stuck: waiting, failed and held count; ran, ready, own and paused do not', () => {
  const board = ['waiting', 'failed', 'held', 'ran', 'ready', 'own', 'paused', 'waiting'].map((state) => ({ state }));
  assert.strictEqual(V.stuckCount(board), 4);
  assert.strictEqual(V.stuckCount([]), 0);
  assert.strictEqual(V.stuckCount(null), 0);
});

test('no order numbers on the page Katherine sees', () => {
  const visible = HTML.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(visible, /#\d{3,4}\b|ORDER \d/);
});
