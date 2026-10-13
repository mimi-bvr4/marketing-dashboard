'use strict';
// ORDER #1702 (Mimi 10.13.2026): a competitor profile read "IHG tracks it as a
// competitor for Executive/Corporate Dinners (ECD), The Big Board (TBB), and The
// Big Table (TBT) segments." ECD, TBB and TBT are The Estate at Cherokee Dock,
// The Bridge Building and The Bell Tower. The model had been handed bare codes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../lib/competitor-profiles');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const BAD = 'IHG tracks it as a competitor for Executive/Corporate Dinners (ECD), The Big Board (TBB), and The Big Table (TBT) segments.';
const profile = (line) => p.HEADINGS.map((h) => `## ${h}\n${h === 'At a glance' ? line : 'not published'}`).join('\n\n');

test('the model never sees a bare code: the sheet tabs become the real names', () => {
  const ev = p.evidenceFor({ name: 'Riverwood Mansion', site: 'riverwoodmansion.com', brands: ['ECD', 'TBB', 'TBT', 'SWF', 'COR', 'STE'] }, []);
  assert.match(ev, /ON IHG'S SHEET FOR: The Estate at Cherokee Dock, The Bridge Building, The Bell Tower, Saddle Woods Farm, The Cordelle, Saint Elle/);
  assert.doesNotMatch(ev.split('\n').find((l) => l.startsWith("ON IHG'S SHEET")), /\b(ECD|TBB|TBT|SWF|COR|STE)\b/);
  assert.match(p.SYSTEM, /never expand or guess what any abbreviation stands for/);
  assert.equal(p.BRAND_NAMES.ECD, 'The Estate at Cherokee Dock'); assert.equal(p.BRAND_NAMES.NLP, 'Nashville Lighting and Production');
});

test('the exact embarrassing sentence is refused; the real names in brackets are fine; safe codes are swapped', () => {
  assert.equal(p.inventedCodes(BAD).length, 3);
  assert.match(p.cleanProfile(profile(BAD)).error, /invented what a code stands for/);
  assert.equal(p.inventedCodes('Up against The Estate at Cherokee Dock (ECD) for Infinity Hospitality Group (IHG).').length, 0);
  const ok = p.cleanProfile(profile('Listed against TBB and TBT. Open until 11 PM EST.'));
  assert.ok(!ok.error); assert.match(ok.md, /The Bridge Building and The Bell Tower/); assert.match(ok.md, /11 PM EST/);
});

test('a live profile with an invented code is rewritten even off the top list, or withdrawn; the page never shows one', async () => {
  const store = createMemoryStore({ lint });
  await store.syncCompetitors([{ site: 'a.com', name: 'A', brands: ['ECD', 'TBB', 'TBT'], top: true }, { site: 'b.com', name: 'B', brands: ['SWF'], top: false }]);
  await store.saveProfile('a.com', profile(BAD)); await store.saveProfile('b.com', profile(BAD));
  await store.saveSnapshots('scout', 'a.com', [{ path: '/', title: 'A', hash: 'x', text: 'Weddings.' }], []);
  const llm = { complete: async () => profile('Listed against The Bridge Building.') };
  const r = await p.writeProfiles({ store, llm });
  assert.equal(r.written, 1);
  assert.match((await store.competitor('a.com')).profile_md, /The Bridge Building/);
  assert.equal((await store.competitor('b.com')).profile_md, null, 'nothing to rewrite it from: withdrawn');
  const router = require('../routes/competitors');
  assert.ok(router, 'route loads');
});
