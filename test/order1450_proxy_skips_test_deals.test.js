'use strict';
// ORDER #1450: KNOWN-BADS FOR "THE PROXY DROPS test_deal = true DEALS".
//
// HubSpot ORs filter groups, so a request with two groups must come out with
// the NEQ clause in BOTH; a contacts request must come out untouched. server.js
// listens on require (see #1390), so the wiring is checked from its source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { excludeTestDeals, NOT_TEST_DEAL } = require('../lib/test_deals');

const isClause = f => f.propertyName === 'test_deal' && f.operator === 'NEQ' && f.value === 'true';

test('two filter groups: the clause lands in both', () => {
  const body = {
    filterGroups: [
      { filters: [{ propertyName: 'pipeline', operator: 'EQ', value: '746391920' }] },
      { filters: [{ propertyName: 'pipeline', operator: 'EQ', value: 'default' }] },
    ],
    properties: ['venue'], limit: 200,
  };
  const out = excludeTestDeals('deals', body);
  assert.strictEqual(out.filterGroups.length, 2);
  for (const g of out.filterGroups) {
    assert.strictEqual(g.filters.filter(isClause).length, 1);
    assert.strictEqual(g.filters[0].propertyName, 'pipeline');
  }
  assert.deepStrictEqual(out.properties, ['venue']);
  assert.strictEqual(out.limit, 200);
  // the caller's object is not mutated (the cache key is built from the result)
  assert.strictEqual(body.filterGroups[0].filters.length, 1);
});

test('a non-deal request is untouched', () => {
  const body = { filterGroups: [{ filters: [{ propertyName: 'venue_s_', operator: 'IN', values: ['X'] }] }] };
  assert.strictEqual(excludeTestDeals('contacts', body), body);
  assert.strictEqual(body.filterGroups[0].filters.length, 1);
});

test('a deal request with no filter groups still gets the clause', () => {
  const out = excludeTestDeals('deals', { limit: 1 });
  assert.strictEqual(out.filterGroups.length, 1);
  assert.ok(isClause(out.filterGroups[0].filters[0]));
});

test('a group that already carries the clause is not doubled', () => {
  const out = excludeTestDeals('deals', { filterGroups: [{ filters: [{ ...NOT_TEST_DEAL }] }] });
  assert.strictEqual(out.filterGroups[0].filters.length, 1);
});

test('server.js filters before the cache key and the HubSpot call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = src.slice(src.indexOf("app.post('/api/hubspot/search'"));
  const filtered = route.indexOf('excludeTestDeals(objectType, rawBody)');
  assert.ok(filtered > 0, 'proxy must call excludeTestDeals');
  assert.ok(filtered < route.indexOf('hsCacheKey(objectType, body)'));
  assert.ok(filtered < route.indexOf('hubspotFetch(objectType, body)'));
});
