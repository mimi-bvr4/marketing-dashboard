'use strict';
// ORDER #2960 (#2958 follow-on): readWpPosts read page 1 only (per_page=100), so
// Bloggy Bob never saw a Dream Events post older than the newest 100 and nothing
// said the list was cut. It now reads every page up to MAX_WP_PAGES (10) per site,
// and names a site the cap cut off. The web is fake: no network in this test.
const { test } = require('node:test');
const assert = require('node:assert');

const sources = require('../lib/agent-sources');

// A fake WordPress posts API. `spec[site]` = { pages: [n1, n2, ...], headers: true|false,
// fail: <page number that answers 400 rest_post_invalid_page_number> }.
function wpPaged(spec) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    const m = String(url).match(/^https:\/\/([^/]+)\/wp-json\/wp\/v2\/posts\?(.*)$/);
    if (!m || !spec[m[1]]) throw new Error('no network in this test');
    const s = spec[m[1]];
    const pm = m[2].match(/(?:^|&)page=(\d+)/);
    const page = pm ? Number(pm[1]) : 1;
    const total = s.pages.reduce((a, b) => a + b, 0);
    const hdr = (name) => {
      const k = String(name).toLowerCase();
      if (k === 'content-type') return 'application/json; charset=UTF-8';
      if (s.headers !== false && k === 'x-wp-totalpages') return String(s.pages.length);
      if (s.headers !== false && k === 'x-wp-total') return String(total);
      return null;
    };
    if (page === s.fail || page > s.pages.length) {
      const body = JSON.stringify({ code: 'rest_post_invalid_page_number', message: 'The page number requested is larger than the number of pages available.', data: { status: 400 } });
      return { status: 400, url, headers: { get: hdr }, text: async () => body };
    }
    const n = s.pages[page - 1];
    const list = Array.from({ length: n }, (_, i) => {
      const id = `p${page}-${i + 1}`;
      return { link: `https://${m[1]}/${id}/`, date: '2026-10-01T09:00:00', slug: id, title: { rendered: `Post ${id}` } };
    });
    const body = JSON.stringify(list);
    return { status: 200, url, headers: { get: hdr }, text: async () => body };
  };
  f.calls = calls;
  return f;
}

const SITE = 'dreameventsandcatering.com';

test('#2960 a 3-page site (100 + 100 + 12) reads all 212 posts', async () => {
  const fetch = wpPaged({ [SITE]: { pages: [100, 100, 12] } });
  const r = await sources.readWpPosts([SITE], { fetch });
  assert.strictEqual(r.posts.length, 212);
  assert.strictEqual(fetch.calls.length, 3);
  assert.deepStrictEqual(r.miss, []);
  assert.deepStrictEqual(r.read, [SITE]);
  assert.deepStrictEqual(r.capped, []);
  assert.strictEqual(new Set(r.posts.map((p) => p.slug)).size, 212, 'no page read twice');
});

test('#2960 header missing: stops on the first short page', async () => {
  const fetch = wpPaged({ [SITE]: { pages: [100, 100, 12], headers: false } });
  const r = await sources.readWpPosts([SITE], { fetch });
  assert.strictEqual(r.posts.length, 212);
  assert.strictEqual(fetch.calls.length, 3);
  assert.deepStrictEqual(r.miss, []);
});

test('#2960 page 2 answers 400: page 1 kept, not a miss', async () => {
  const fetch = wpPaged({ [SITE]: { pages: [100, 100, 12], fail: 2 } });
  const r = await sources.readWpPosts([SITE], { fetch });
  assert.strictEqual(r.posts.length, 100);
  assert.strictEqual(fetch.calls.length, 2);
  assert.deepStrictEqual(r.miss, []);
  assert.deepStrictEqual(r.read, [SITE]);
});

test('#2960 12 pages with cap 10: 1000 posts and a capped entry, named on the source', async () => {
  assert.strictEqual(sources.MAX_WP_PAGES, 10);
  const pages = Array(12).fill(100);
  const fetch = wpPaged({ [SITE]: { pages } });
  const r = await sources.readWpPosts([SITE], { fetch });
  assert.strictEqual(r.posts.length, 1000);
  assert.strictEqual(fetch.calls.length, 10);
  assert.deepStrictEqual(r.capped, [{ site: SITE, read: 1000, total: 1200 }]);
  const src = await sources.REGISTRY.wp_posts({ sites: [SITE] }, { fetch: wpPaged({ [SITE]: { pages } }) });
  assert.strictEqual(src.ok, true);
  assert.match(src.text, /\nCapped: dreameventsandcatering\.com \(first 1000 of 1200\)/);
});

test('#2960 KNOWN-GOOD: a 1-page site sends exactly ONE request, same URL as before', async () => {
  const fetch = wpPaged({ 'saddlewoodsfarm.com': { pages: [7] } });
  const r = await sources.readWpPosts(['saddlewoodsfarm.com'], { fetch });
  assert.strictEqual(r.posts.length, 7);
  assert.deepStrictEqual(fetch.calls, ['https://saddlewoodsfarm.com/wp-json/wp/v2/posts?per_page=100&_fields=link,title,date,slug']);
  const src = await sources.REGISTRY.wp_posts({ sites: ['saddlewoodsfarm.com'] }, { fetch: wpPaged({ 'saddlewoodsfarm.com': { pages: [7] } }) });
  assert.doesNotMatch(src.text, /Capped:/);
});

test('#2960 page 1 failing is still a miss, exactly as before', async () => {
  const fetch = wpPaged({ [SITE]: { pages: [100], fail: 1 } });
  const r = await sources.readWpPosts([SITE], { fetch });
  assert.deepStrictEqual(r.miss, [`${SITE} (400)`]);
  assert.deepStrictEqual(r.read, []);
  assert.strictEqual(fetch.calls.length, 1);
});
