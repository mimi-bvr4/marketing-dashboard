'use strict';
// ORDER #3310 (Mimi 11.12.2026 "ok"): the salesperson Waiting lines are settled
// by #3165 (each lead batch lands on Mary Topp's /handoff desk and Mary picks
// the salesperson per batch), so no card asks Mimi to "name the salesperson".
// Those cards carry a pointer to /handoff instead, which is not a Waiting line.
// And every card in the roster renders a title line, the Keyword Queen included.
// No express here, so it runs in a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const V = require('../public/agents-view');
const { listAgents, loadAgent } = require('../lib/agent-runner');
const { characterOf } = require('../routes/agents');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
const POINTER = "Batches go to Mary's desk (/handoff); Mary picks the salesperson for each one.";

test('no agent asks Mimi to name the salesperson', () => {
  for (const slug of listAgents()) {
    const needs = (loadAgent(slug).character || {}).needs || [];
    for (const n of needs) assert.doesNotMatch(n, /name the salesperson/i, `${slug}: "${n}"`);
  }
});

test('Gala Scout and Planner Scout point to Mary\'s /handoff desk instead', () => {
  for (const slug of ['gala-scout', 'planner-scout']) {
    const c = loadAgent(slug).character;
    assert.deepStrictEqual(c.pointer, { text: POINTER, href: '/handoff' }, slug);
    assert.ok(!c.needs.includes(POINTER), `${slug}: the pointer is not a Waiting line`);
    assert.doesNotMatch(POINTER, /—/, 'no em dash');
  }
});

test('the route passes the pointer through, outside needs', () => {
  const d = loadAgent('gala-scout');
  const c = characterOf(d, [], null, new Date('2026-11-12T12:00:00Z'), null, {});
  assert.deepStrictEqual(c.pointer, { text: POINTER, href: '/handoff' });
  assert.ok(c.needs.every((n) => !/salesperson/i.test(n)));
  // an agent with no pointer carries none
  assert.strictEqual('pointer' in characterOf(loadAgent('scout'), [], null, new Date(), null, {}), false);
});

test('the card and the profile render the pointer as a /handoff link, not as Waiting on', () => {
  assert.match(HTML, /a\.character\.pointer \? `<p class="meta pointer"><a href="\$\{esc\(a\.character\.pointer\.href\)\}">\$\{esc\(a\.character\.pointer\.text\)\}<\/a><\/p>`/, 'card');
  assert.match(HTML, /c\.pointer \? `<p class="meta pointer"><a href="\$\{esc\(c\.pointer\.href\)\}">\$\{esc\(c\.pointer\.text\)\}<\/a><\/p>`/, 'profile');
});

test('every card in the roster renders a title line, the Keyword Queen included', () => {
  for (const slug of listAgents()) {
    const d = loadAgent(slug);
    const c = d.character || {};
    assert.ok(c.role && String(c.role).trim(), `${slug}: has a title`);
    assert.strictEqual(V.showEyebrow(c.role, d.name, c.title_always), true, `${slug}: "${c.role}" shows above "${d.name}"`);
  }
  const kq = loadAgent('keyword-queen').character;
  assert.strictEqual(kq.role, 'The Keyword Queen', 'the title #3163 named');
  assert.strictEqual(kq.title_always, true);
});

test('title_always keeps the title on a rename too, and the #2941 rule is unchanged without it', () => {
  assert.strictEqual(V.showEyebrow('The Keyword Queen', 'Keyword Queen', true), true);
  assert.strictEqual(V.showEyebrow('The Keyword Queen', 'Queenie', true), true);
  assert.strictEqual(V.showEyebrow('', 'Keyword Queen', true), false, 'no title, nothing to show');
  assert.strictEqual(V.showEyebrow('The producer', 'The Producer'), false);
  assert.match(HTML, /eyebrow\(a\.slug, a\.character\.role, a\.name, a\.character\.title_always\)/);
  assert.match(HTML, /data-always="\$\{always \? '1' : ''\}"/);
  assert.match(HTML, /V\.showEyebrow\(r\.dataset\.role, name, r\.dataset\.always === '1'\)/, 'a rename keeps it');
  assert.match(HTML, /V\.showEyebrow\(c\.role, a\.name, c\.title_always\)/, 'the profile');
});
