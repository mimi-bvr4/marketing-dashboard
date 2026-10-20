'use strict';
// ORDER #2104 -- web.html (ORDER #1873, added 10.15.2026 by 96acc8a) is a
// signed-in staff page built without the shared nav, the 14th polish finding
// (brain-core test_order703_polish_baseline.py, 14 != 13, REPLY #2103).
// It already linked ihg.css, ihg-tokens.css and ihg-components.css; the fix
// adds the one script line its eight siblings carry and nothing else.
//
//   node --test test/order2104_web_html_takes_the_nav.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'web.html'), 'utf8');

test('web.html: KNOWN-BAD: carries the shared nav, from dispatch, exactly once', () => {
  const n = (read().match(/<script[^>]*dispatch\.infinityhospitalitygroup\.com\/ihg-nav\.js/g) || []).length;
  assert.strictEqual(n, 1, 'the shared nav component, not a re-implementation and not twice');
});

test('web.html: the nav script sits just before </body>, deferred', () => {
  const s = read();
  assert.ok(/<script src="https:\/\/dispatch\.infinityhospitalitygroup\.com\/ihg-nav\.js" defer><\/script>\s*<\/body>/.test(s),
    'same line, same place as the sibling pages');
});

test('web.html: the styles it already had are still there', () => {
  const s = read();
  for (const css of ['ihg.css', 'ihg-tokens.css', 'ihg-components.css']) {
    assert.ok(s.includes(css), css + ': this order adds a script; it removes nothing');
  }
});
