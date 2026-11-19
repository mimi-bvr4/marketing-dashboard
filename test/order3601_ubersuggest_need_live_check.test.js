// ORDER #3601 (#3501 follow-on): every agent need line that names Ubersuggest is
// decided by the same live check (#3243/#3498, tree-file:ubersuggest-weekly), so no
// card can keep a static "load the Ubersuggest job" line once the Thursday file exists.
// Reads agents/*/agent.json only; nothing here reaches the tree, Ubersuggest or a queue.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { checkFor, applyChecks } = require('../lib/agent-checks');

const AGENTS = path.join(__dirname, '..', 'agents');

function allNeeds() {
  const out = [];
  for (const slug of fs.readdirSync(AGENTS)) {
    const f = path.join(AGENTS, slug, 'agent.json');
    if (!fs.existsSync(f)) continue;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const n of ((d && d.character) || {}).needs || []) out.push({ slug, line: n });
  }
  return out;
}

test('every need line naming Ubersuggest maps to tree-file:ubersuggest-weekly', () => {
  const hits = allNeeds().filter((n) => /ubersuggest/i.test(n.line));
  assert.ok(hits.length >= 3, `expected the SEO Lead, Bloggy Bob and Keyword Queen lines, found ${hits.length}`);
  const wrong = hits.filter((n) => (checkFor(n.line) || {}).id !== 'tree-file:ubersuggest-weekly');
  assert.deepStrictEqual(wrong.map((n) => `${n.slug}: ${n.line}`), []);
});

test("Keyword Queen's Ubersuggest need clears when the weekly check passes", () => {
  const d = JSON.parse(fs.readFileSync(path.join(AGENTS, 'keyword-queen', 'agent.json'), 'utf8'));
  const needs = d.character.needs;
  const rows = new Map([['tree-file:ubersuggest-weekly', { ok: true, reason: 'Ubersuggest_Weekly_2026-11-19.md is on the Box', checked_at: '2026-11-19T13:32:00Z' }]]);
  const shown = applyChecks(needs, rows, {});
  assert.deepStrictEqual(shown.filter((l) => /ubersuggest/i.test(l)), []);
});
