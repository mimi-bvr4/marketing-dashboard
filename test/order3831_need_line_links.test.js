'use strict';
// ORDER #3831 (3815 follow-on): a URL in an agent's "Waiting on" line or in a
// source's "why" text is a link that opens in a new tab, on every renderer that
// draws one (public/agents.html: the roster card, its "+N more" list, the
// profile panel's Waiting on, and What it reads). Everything else in the text
// stays escaped plain text, and only http(s):// is ever linked.
// No express here, so it runs in a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const V = require('../public/agents-view');
const { loadAgent } = require('../lib/agent-runner');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
const A = (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`;

test('the helper exists and is the one shared escape-then-link', () => {
  assert.strictEqual(typeof V.linkText, 'function');
});

test('an https URL becomes a new-tab link; the words around it stay plain', () => {
  assert.strictEqual(V.linkText('see https://example.com/a?b=1 now'), `see ${A('https://example.com/a?b=1')} now`);
  assert.strictEqual(V.linkText('http://x.test'), A('http://x.test'));
});

test('a URL inside brackets or before a full stop keeps the bracket and stop outside the link', () => {
  assert.strictEqual(V.linkText('the spec (https://d.test/doc/edit) and more.'), `the spec (${A('https://d.test/doc/edit')}) and more.`);
  assert.strictEqual(V.linkText('go to https://d.test/x.'), `go to ${A('https://d.test/x')}.`);
});

test('< > " & and \' in the text stay escaped, inside and outside a link', () => {
  assert.strictEqual(V.linkText('a <b> "c" & \'d\''), 'a &lt;b&gt; &quot;c&quot; &amp; &#39;d&#39;');
  assert.strictEqual(V.linkText('https://d.test/?a=1&b=2'), A('https://d.test/?a=1&amp;b=2'));
  assert.strictEqual(V.linkText('<script>alert(1)</script> https://d.test'), `&lt;script&gt;alert(1)&lt;/script&gt; ${A('https://d.test')}`);
  // a quote can never end the href early: the URL stops at it, and it is escaped
  assert.strictEqual(V.linkText('https://d.test/"onmouseover="x'), `${A('https://d.test/')}&quot;onmouseover=&quot;x`);
});

test('javascript:, data: and other schemes are never linked', () => {
  for (const s of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'JAVASCRIPT:alert(1)', 'ftp://x.test', 'mailto:a@b.test', 'www.example.com']) {
    assert.doesNotMatch(V.linkText(s), /<a /, s);
  }
  assert.strictEqual(V.linkText('data:text/html,<b>x</b>'), 'data:text/html,&lt;b&gt;x&lt;/b&gt;');
});

test('raw HTML in an agent file is never passed through as a link label', () => {
  const out = V.linkText('<a href="javascript:alert(1)">click</a>');
  assert.doesNotMatch(out, /<a /);
  assert.strictEqual(out, '&lt;a href=&quot;javascript:alert(1)&quot;&gt;click&lt;/a&gt;');
});

test('empty and null are empty, text with no URL is just escaped', () => {
  assert.strictEqual(V.linkText(null), '');
  assert.strictEqual(V.linkText(undefined), '');
  assert.strictEqual(V.linkText('Mimi: switch it on (AGENT_X)'), 'Mimi: switch it on (AGENT_X)');
});

test('every renderer of a need line or a source why uses the helper, not bare esc()', () => {
  // roster card: the first need and the "+N more" list
  assert.match(HTML, /<strong>Waiting on:<\/strong> \$\{V\.linkText\(need\)\}/);
  assert.match(HTML, /boxes\.needs\.slice\(1\)\.map\(\(x\) => `<li>\$\{V\.linkText\(x\)\}<\/li>`\)/);
  // profile panel: Waiting on
  assert.match(HTML, /<h2 class="serif">Waiting on<\/h2>\$\{list\(c\.needs, \(x\) => `<li>\$\{V\.linkText\(x\)\}<\/li>`\)\}/);
  // profile panel: What it reads, the source's why
  assert.match(HTML, /not connected<\/span> \$\{V\.linkText\(s\.why \|\| ''\)\}/);
  // and the old plain-text spellings are gone
  assert.doesNotMatch(HTML, /Waiting on:<\/strong> \$\{esc\(need\)\}/);
  assert.doesNotMatch(HTML, /not connected<\/span> \$\{esc\(s\.why/);
});

test('DEMO: the monthly-report need line carrying the Ads Export spec link renders as a link', () => {
  const need = loadAgent('monthly-report').character.needs.find((n) => /docs\.google\.com/.test(n));
  assert.ok(need, 'monthly-report still carries the spec Doc link (#3815)');
  const html = V.linkText(need);
  assert.match(html, /<a href="https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\/edit" target="_blank" rel="noopener noreferrer">https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\/edit<\/a>\) and share it/);
  assert.match(html, /^Katherine\/K&amp;M: create the ads export Sheet per the spec \(<a /);
});
