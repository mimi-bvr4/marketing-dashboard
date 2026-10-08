'use strict';
// ORDER #1450: the HubSpot proxy never counts a deal marked test_deal = true.
//
// HubSpot ORs filter groups, so the clause goes into EVERY group: one group
// without it would let a test deal back in. NEQ "true" keeps deals whose
// test_deal is empty (measured read-only 10.07.2026: 1147 deals with no value,
// 1147 of them still match NEQ true). Contacts pass through untouched (#1450 DO 2).
const NOT_TEST_DEAL = Object.freeze({ propertyName: 'test_deal', operator: 'NEQ', value: 'true' });

function hasClause(filters) {
  return filters.some(f => f && f.propertyName === 'test_deal' && f.operator === 'NEQ' && String(f.value) === 'true');
}

function excludeTestDeals(objectType, body) {
  if (objectType !== 'deals') return body;
  const groups = Array.isArray(body.filterGroups) && body.filterGroups.length ? body.filterGroups : [{ filters: [] }];
  return {
    ...body,
    filterGroups: groups.map(g => {
      const filters = Array.isArray(g && g.filters) ? g.filters : [];
      return hasClause(filters) ? { ...g, filters } : { ...g, filters: [...filters, { ...NOT_TEST_DEAL }] };
    }),
  };
}

module.exports = { excludeTestDeals, NOT_TEST_DEAL };
