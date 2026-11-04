'use strict';
// ORDER #2944: the Google Business agent's board line said "re-probe on or
// after 10.20.2026 (ORDER #1589)" two weeks after that date passed. The
// re-probe of 11.04.2026 13:01 CT measured the real state: the Business
// Profile API is approved (brain@ lists 11 profiles, 200), but every reviews
// and localPosts GET answers 403 SERVICE_DISABLED for mybusiness.googleapis.com.
// So the source stays "pending", and its line must say that, not the old date.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'gbp', 'agent.json'), 'utf8'));
const src = def.sources.find((s) => s.type === 'pending');

test('GBP pending source no longer carries the passed 10.20 re-probe date', () => {
  assert.ok(src, 'the reviews source is still pending until Google grants the API');
  assert.doesNotMatch(src.why, /re-probe on or after 10\.20\.2026/);
  assert.doesNotMatch(JSON.stringify(def.character.needs), /10\.20\.2026/);
});

test('GBP pending source names the exact API Google still has to grant', () => {
  assert.match(src.why, /mybusiness\.googleapis\.com/);
  assert.match(src.why, /SERVICE_DISABLED/);
  assert.match(src.why, /308053229449/);
  assert.match(src.why, /ORDER #2944/);
});

test('GBP stays drafts-only: no live reviews source was switched on', () => {
  assert.ok(!def.sources.some((s) => s.type !== 'pending' && /google.*review/i.test(s.label || '')));
});
