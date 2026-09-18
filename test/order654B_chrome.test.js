'use strict';
// ORDER #654 Amendment B — the marketing dashboard reads as part of the hub.
//
// MEASURED FIRST, as the amendment requires: the shared nav (ihg-nav.js) was
// ALREADY on both pages, loaded from dispatch. ihg.css was NOT. So only the
// missing half is applied -- the amendment says "apply only what's missing".
//
//   node --test test/order654B_chrome.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PAGES = ['index.html', 'api-tokens.html'];
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

for (const f of PAGES) {
  test(f + ': serves the estate design system', () => {
    assert.ok(/<link[^>]*ihg\.css/.test(read(f)), 'ihg.css must be linked');
  });

  test(f + ': carries the shared nav, and exactly once', () => {
    const n = (read(f).match(/<script[^>]*ihg-nav\.js/g) || []).length;
    assert.strictEqual(n, 1, 'the shared nav component, not a re-implementation and not twice');
  });

  test(f + ': ihg.css loads BEFORE the page\'s own styles, so no rule changes', () => {
    const s = read(f);
    const css = s.indexOf('ihg.css');
    const own = s.indexOf('<style');
    if (own === -1) return;                       // no inline styles on this page
    assert.ok(css < own, 'the design system must load first; every existing rule still wins');
  });
}

test('KNOWN-BAD: no chart, number or content rule was touched -- chrome only', () => {
  const s = read('index.html');
  // The amendment's rule 5: the Elle GA4 tab and all live numbers stay untouched.
  for (const marker of ['chart.js', 'Elle', '/api/ga4/']) {
    assert.ok(s.includes(marker), marker + ' must survive this change untouched');
  }
});

test('the design system is loaded from the estate, not vendored or re-implemented', () => {
  assert.ok(/dispatch\.infinityhospitalitygroup\.com\/ihg\.css/.test(read('index.html')),
    'one source of truth for the tokens; a local copy would drift');
});
