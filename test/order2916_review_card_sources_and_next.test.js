'use strict';
// ORDER #2916 (fix order from the #2912 parity gate, rows 2 and 7): every Review
// card lists the sources its agent read, by name, marking the unavailable ones,
// and says in one line what Approve does for that kind of card. The test runs
// the page's own render functions, cut from public/review.html, in a sandbox.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');

function renderers() {
  const start = HTML.indexOf('  const esc = ');
  const end = HTML.indexOf('  let cache = [];');
  assert.ok(start > 0 && end > start, 'the render functions are where the test expects them');
  const ctx = vm.createContext({});
  vm.runInContext(`${HTML.slice(start, end)}; this.cardHtml = cardHtml;`, ctx);
  return ctx;
}
const base = (extra) => ({ id: 1, status: 'draft', agent_name: 'Scout', job: 'ideas', title: 'A draft', body: 'Body.', sources: [], checks: {}, payload: null, handoff: null, ...extra });

test('a card with three sources, one unavailable, names all three and marks the missing one', () => {
  const { cardHtml } = renderers();
  const html = cardHtml(base({ sources: [
    { label: 'Google Search Console', ok: true },
    { label: 'the venue notes', ok: true },
    { label: 'Pinterest boards', ok: false, why: 'token expired' },
  ] }));
  for (const name of ['Google Search Console', 'the venue notes', 'Pinterest boards']) assert.ok(html.includes(name), `names ${name}`);
  assert.match(html, /Pinterest boards \(unavailable\)/);
  assert.doesNotMatch(html, /Google Search Console \(unavailable\)/, 'a source that was read is not marked missing');
  assert.match(html, /1 source\(s\) unavailable/, 'the count badge stays');
});

test('a card with no sources shows no empty Sources line', () => {
  const { cardHtml } = renderers();
  assert.doesNotMatch(cardHtml(base()), /Sources:/);
});

test('source names are escaped', () => {
  const { cardHtml } = renderers();
  const html = cardHtml(base({ sources: [{ label: '<b>x</b>', ok: true }] }));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(!html.includes('<b>x</b>'));
});

test('every card kind says what Approve does', () => {
  const { cardHtml } = renderers();
  const pin = cardHtml(base({ payload: { pin: { board: 'Barn Weddings', title: 't', image_url: 'https://x/i.jpg', link: 'https://x' } } }));
  assert.match(pin, /After Approve: pinned live on Pinterest, board Barn Weddings\./);
  const post = cardHtml(base({ payload: { post: { site: 'infinityhospitality.net', content_md: 'x' } } }));
  assert.match(post, /After Approve: saved as an unpublished WordPress draft on infinityhospitality\.net\. Nothing is published\./);
  for (const kind of [{ agent_name: 'Google Business' }, { agent_name: 'Convention Connector', job: 'outreach email' }, { agent_name: 'Scout' }]) {
    assert.match(cardHtml(base(kind)), /After Approve: marked ready for you to use\. Nothing is posted or sent\./, kind.agent_name);
  }
});

test('the what-next line is only on drafts, where Approve is offered', () => {
  const { cardHtml } = renderers();
  for (const status of ['ready', 'rejected', 'archived']) assert.doesNotMatch(cardHtml(base({ status })), /After Approve:/, status);
});

test('no order number on anything she sees', () => {
  const shown = HTML.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(shown, /2916/);
  assert.doesNotMatch(shown, /handed to Sales/i, 'no card is handed to Sales, so the page never says so');
});
