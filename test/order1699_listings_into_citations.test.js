'use strict';
// ORDER #1699 (Mimi 10.13.2026): "Listing and Citations need to combine into one agent."
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { loadAgent } = require('../lib/agent-runner');
const store = require('../lib/agent-store');

test('one agent: no listings folder; Citations carries the refresh packs, the listings sources and both traits', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'agents', 'listings')));
  const c = loadAgent('citations');
  assert.strictEqual(c.name, 'Listings + Citations');
  assert.match(c.skill, /Refresh packs/); assert.match(c.skill, /January, April, July or October/);
  assert.match(c.skill, /Mismatch list/); assert.match(c.skill, /AI answers/);
  assert.ok(c.sources.some((s) => s.newest === '07_Marketing_and_Brand/Venue_Review_Pulse_'));
  assert.ok(c.character.does.some((d) => /refresh packs/i.test(d)));
  assert.ok(c.character.traits.some((t) => /log in to a directory/i.test(t.cant)));
  assert.ok(c.max_cards >= 4);
  assert.ok(!/[—–]/.test(JSON.stringify(c) + c.skill), 'no em or en dash');
});

test('schedule and Drive routing: the 15th only; directory words route to Citations', () => {
  const { dueAgents } = require('../jobs/agent_run');
  for (const d of ['2027-01-04', '2027-04-05', '2026-10-05']) assert.ok(!dueAgents(d).includes('listings'));
  assert.ok(dueAgents('2027-01-15').includes('citations'));
  const { matchAgent } = require('../jobs/kh_route');
  assert.deepStrictEqual(matchAgent('Refresh our WeddingWire listing'), ['citations']);
  assert.deepStrictEqual(matchAgent('Check AI visibility for the Bell Tower'), ['citations']);
});

test('the merge moves every Listings row, keeps a name only when Citations has none, and never overwrites Katherine\'s own instructions', async () => {
  const sql = [];
  await store.mergeListingsIntoCitations({ query: async (q, p) => { sql.push([q, p]); return { rows: [] }; } });
  for (const t of ['agent_runs', 'agent_cards', 'agent_asks', 'agent_run_requests', 'agent_profile_log']) {
    assert.ok(sql.some(([q]) => q === `UPDATE ${t} SET agent = 'citations' WHERE agent = 'listings'`), t);
  }
  assert.ok(sql.some(([q]) => /INSERT INTO agent_profiles[\s\S]*ON CONFLICT \(agent\) DO NOTHING/.test(q)));
  assert.ok(sql.some(([q]) => /COALESCE\(c\.display_name, ''\) = ''/.test(q)));
  const ins = sql.find(([q]) => /INSERT INTO agent_settings/.test(q));
  assert.match(ins[0], /sha256/); assert.equal(ins[1][1], store.OLD_CITATIONS_DEFAULT_SHA);
  assert.match(store.OLD_CITATIONS_DEFAULT_SHA, /^[0-9a-f]{64}$/);
  assert.match(ins[1][0], /^---\nname: citations/); assert.match(ins[1][0], /Refresh packs/);
  assert.ok(!sql.some(([q]) => /UPDATE agent_settings|DELETE/.test(q)), 'saved versions are never edited or deleted');
});
