'use strict';
// ORDER #3444 (REPLY #3435 rows 24, 25) -- pinterest-accounts.html (signed-in
// fetches, #3164) and reviewer-watch.html ("For Mimi and NB only", #2962) are
// staff pages built without the shared nav. They take the one line their
// marketing siblings carry (handoff.html:163, competitors.html:132,
// review.html:350): dispatch's ihg-nav.js by absolute URL, deferred, once,
// just before </body>. No marketing page carries a sign-out hook, so neither
// does this. Shaped like planning test/order3442_nlp_menu_review_takes_the_staff_nav.test.js.
//
//   node --test test/order3444_two_pages_take_the_staff_nav.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const NAV_TAG = '<script src="https://dispatch.infinityhospitalitygroup.com/ihg-nav.js" defer></script>';
const PAGES = ['pinterest-accounts.html', 'reviewer-watch.html'];
const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');
const count = (s, needle) => s.split(needle).length - 1;
const navOk = (html) =>
  count(html, 'ihg-nav.js') === 1 && count(html, NAV_TAG) === 1 && html.includes(NAV_TAG + '\n</body>');

for (const page of PAGES) {
  test(`${page}: carries the sibling staff nav tag exactly once, just before </body>`, () => {
    const html = read(page);
    assert.strictEqual(count(html, 'ihg-nav.js'), 1, 'ihg-nav.js appears exactly once');
    assert.strictEqual(count(html, NAV_TAG), 1, 'the sibling nav tag appears verbatim, once');
    assert.ok(html.includes(NAV_TAG + '\n</body>'), 'nav tag, then </body>');
  });

  test(`${page}: KNOWN-BAD: the page without the nav tag, or with it twice, is caught`, () => {
    const html = read(page);
    assert.strictEqual(navOk(html.replace(NAV_TAG, '')), false, 'missing nav is caught');
    assert.strictEqual(navOk(html.replace('</body>', NAV_TAG + '\n' + NAV_TAG + '\n</body>')), false, 'doubled nav is caught');
  });
}

test('the sibling pages this copies still carry the same tag', () => {
  for (const sib of ['handoff.html', 'competitors.html', 'review.html']) {
    assert.ok(read(sib).includes(NAV_TAG + '\n</body>'), sib + ' is the source of the markup');
  }
});
