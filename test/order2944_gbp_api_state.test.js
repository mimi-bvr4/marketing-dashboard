'use strict';
// ORDER #2944: the Google Business agent's board line said "re-probe on or
// after 10.20.2026 (ORDER #1589)" two weeks after that date passed. The
// re-probe of 11.04.2026 measured reviews and posts at 403 SERVICE_DISABLED.
// ORDER #2977 (11.05.2026): Mimi enabled mybusiness.googleapis.com, the
// re-probe answered 200 on all 11 profiles, and the pending source became the
// live gbp_reviews source. This file now pins that nothing stale came back.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'gbp', 'agent.json'), 'utf8'));

test('GBP carries no passed re-probe date and no pending Google source', () => {
  assert.doesNotMatch(JSON.stringify(def), /re-probe on or after 10\.20\.2026/);
  assert.doesNotMatch(JSON.stringify(def.character.needs), /10\.20\.2026|308053229449/);
  assert.ok(!def.sources.some((s) => s.type === 'pending'), 'the Google source is live since #2977');
});

test('GBP reads Google through the live gbp_reviews source', () => {
  assert.ok(def.sources.some((s) => s.type === 'gbp_reviews' && s.required));
});
