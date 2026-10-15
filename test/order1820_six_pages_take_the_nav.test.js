'use strict';
// ORDER #1820 -- six staff pages built 10.04-10.13 without the shared nav.
//
// MEASURED FIRST (one_look, 10.14.2026, marketing 4a9cbfa): photos, review,
// agents, competitors, cadet and her-numbers each had `nav` and `ihg.css`
// findings. They linked dispatch's ihg-tokens.css + ihg-components.css only.
// The fix copies index.html's two includes and nothing else. Linking ihg.css
// was kept only because the 390px screenshots with and without it hashed
// byte-identical on all six pages (evidence under _evidence/order1820_shots/).
//
//   node --test test/order1820_six_pages_take_the_nav.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PAGES = ['photos.html', 'review.html', 'agents.html',
  'competitors.html', 'cadet.html', 'her-numbers.html'];
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

for (const f of PAGES) {
  test(f + ': carries the shared nav, from dispatch, exactly once', () => {
    const n = (read(f).match(/<script[^>]*dispatch\.infinityhospitalitygroup\.com\/ihg-nav\.js/g) || []).length;
    assert.strictEqual(n, 1, 'the shared nav component, not a re-implementation and not twice');
  });

  test(f + ': serves ihg.css from the estate, before the tokens and the page\'s own styles', () => {
    const s = read(f);
    const css = s.indexOf('dispatch.infinityhospitalitygroup.com/ihg.css');
    assert.ok(css !== -1, 'ihg.css must be linked from dispatch, never vendored');
    assert.ok(css < s.indexOf('ihg-tokens.css'), 'ihg.css loads first, so the approved tokens still win');
    const own = s.indexOf('<style');
    if (own !== -1) assert.ok(css < own, 'every existing page rule still wins');
  });

  test(f + ': KNOWN-BAD: the tokens and components it already had are still there', () => {
    const s = read(f);
    assert.ok(s.includes('ihg-tokens.css') && s.includes('ihg-components.css'),
      'this order adds includes; it removes nothing');
  });
}
