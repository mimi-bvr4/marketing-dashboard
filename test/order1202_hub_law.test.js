'use strict';

// ORDER #1202: #1198's law tests (venue-hub 902f051, test/law.test.js), ported
// to hub/. One test per law in ORDER #1198 item 3 and #1011 Amendment A.

const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./order1202_hub_helpers');
const { THEMES } = require('../hub/data/themes');

const LIVE_THEME_PATHS = ['/garden', '/garden/b', '/garden/c'];

test('every theme page carries the noindex meta AND the X-Robots-Tag header, even with preview off', async () => {
  const app = await start({ config: { preview: false } });
  try {
    for (const p of LIVE_THEME_PATHS) {
      const res = await app.get(p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', p);
      assert.match(await res.text(), /<meta name="robots" content="noindex, nofollow">/, p);
    }
  } finally {
    await app.close();
  }
});

test('sitemap.xml lists the home and no theme URL', async () => {
  const app = await start();
  try {
    const xml = await (await app.get('/sitemap.xml')).text();
    assert.match(xml, /<loc>https:\/\/nashvilleweddingvenue\.com\/<\/loc>/);
    for (const t of THEMES) assert.ok(!xml.includes(`/${t.slug}`), t.slug);
  } finally {
    await app.close();
  }
});

test('robots.txt does NOT disallow theme pages (the AdsBot landmine)', async () => {
  const app = await start();
  try {
    const txt = await (await app.get('/robots.txt')).text();
    const disallows = txt.split('\n').filter((l) => /^\s*disallow\s*:/i.test(l)).map((l) => l.split(':')[1].trim());
    for (const rule of disallows) {
      if (!rule) continue; // an empty Disallow allows everything
      for (const p of LIVE_THEME_PATHS) assert.ok(!p.startsWith(rule), `${rule} blocks ${p}`);
    }
    assert.match(txt, /Allow: \//);
  } finally {
    await app.close();
  }
});

test('a crawl from the hub home finds zero theme pages', async () => {
  const app = await start();
  try {
    const seen = new Set();
    const queue = ['/'];
    while (queue.length) {
      const p = queue.shift();
      if (seen.has(p)) continue;
      seen.add(p);
      const res = await app.get(p);
      if (!(res.headers.get('content-type') || '').includes('text/html')) continue;
      const html = await res.text();
      for (const m of html.matchAll(/href="([^"#]*)(#[^"]*)?"/g)) {
        const href = m[1];
        if (!href || !href.startsWith('/') || href.startsWith('//')) continue;
        queue.push(href.split('?')[0]);
      }
    }
    for (const t of THEMES) {
      for (const p of seen) assert.ok(p !== `/${t.slug}` && !p.startsWith(`/${t.slug}/`), `crawl reached ${p}`);
    }
    assert.ok(seen.has('/'));
  } finally {
    await app.close();
  }
});

test('an unknown slug, a draft theme and an unknown variant all 302 to the hub home', async () => {
  // The hub handler on its own. On a PUBLIC host the router answers the
  // unknown slugs (/nope, /GARDEN) with 404 before the hub sees them; that is
  // tested in order1202_host_split.test.js.
  const app = await start();
  try {
    for (const p of ['/nope', '/industrial', '/corporate', '/garden/zz', '/garden/b/extra', '/GARDEN']) {
      const res = await app.get(p);
      assert.equal(res.status, 302, p);
      assert.equal(res.headers.get('location'), '/', p);
    }
  } finally {
    await app.close();
  }
});

test('…and under the /hub preview base, the redirect stays inside /hub', async () => {
  const app = await start({ config: { basePath: '/hub' } });
  try {
    const res = await app.get('/industrial');
    assert.equal(res.headers.get('location'), '/hub/');
    const html = await (await app.get('/garden/b')).text();
    assert.match(html, /action="\/hub\/inquire"/);
    assert.match(html, /class="wordmark" href="\/hub\/"/);
  } finally {
    await app.close();
  }
});

test('the 50/50 split is sticky per visitor and splits new visitors', async () => {
  let n = 0;
  const app = await start({ rng: () => n++ % 2 });
  try {
    const first = await app.get('/garden');
    const cookieA = first.headers.get('set-cookie');
    assert.match(cookieA, /^vh_split_garden=_;/);
    const second = await app.get('/garden');
    const cookieB = second.headers.get('set-cookie');
    assert.match(cookieB, /^vh_split_garden=b;/);
    assert.match(await second.text(), /name="style" value="compare"/);

    // The returning visitor keeps their arm, ten times over, with no new cookie.
    for (let i = 0; i < 10; i++) {
      const again = await app.get('/garden', { headers: { cookie: cookieB.split(';')[0] } });
      assert.equal(again.headers.get('set-cookie'), null);
      assert.match(await again.text(), /name="style" value="compare"/);
      const againA = await app.get('/garden', { headers: { cookie: cookieA.split(';')[0] } });
      assert.match(await againA.text(), /name="style" value="hero"/);
    }
    // An explicit variant URL is never re-split.
    const direct = await app.get('/garden/b');
    assert.equal(direct.headers.get('set-cookie'), null);
  } finally {
    await app.close();
  }
});

test('only an approved headline swap is used, and raw URL text is never echoed', async () => {
  const app = await start();
  try {
    const garden = THEMES.find((t) => t.slug === 'garden');
    const ok = await (await app.get('/garden/b?hl=spring')).text();
    assert.ok(ok.includes(garden.headlineSwaps.spring));

    const evil = '<script>alert(1)</script>';
    const bad = await (await app.get(`/garden/b?hl=${encodeURIComponent(evil)}&utm_campaign=${encodeURIComponent(evil)}&kw=PWNED_TEXT`)).text();
    assert.ok(bad.includes(garden.promise), 'unapproved key falls back to the promise');
    assert.ok(!bad.includes('<script>alert'), 'no raw script');
    assert.ok(!bad.includes('PWNED_TEXT'), 'unknown param never printed');
    assert.ok(!bad.includes('alert(1)'), 'tracking params are cleaned, not echoed');
  } finally {
    await app.close();
  }
});

test('three styles render the same theme', async () => {
  const app = await start();
  try {
    const garden = THEMES.find((t) => t.slug === 'garden');
    for (const [p, style] of [['/garden/b', 'compare'], ['/garden/c', 'collection']]) {
      const html = await (await app.get(p)).text();
      assert.ok(html.includes(garden.promise), p);
      assert.match(html, new RegExp(`name="style" value="${style}"`), p);
    }
    const hero = await (await app.get('/garden', { headers: { cookie: 'vh_split_garden=_' } })).text();
    assert.match(hero, /name="style" value="hero"/);
    for (const v of ['Saddle Woods Farm', 'The Estate at Cherokee Dock', 'The Bell Tower']) assert.ok(hero.includes(v), v);
  } finally {
    await app.close();
  }
});

test('changing the theme record headline changes the page (no hard-coded copy)', async () => {
  const themes = structuredClone(THEMES);
  themes.find((t) => t.slug === 'garden').promise = 'A record-driven headline 4242.';
  const app = await start({ themes });
  try {
    const html = await (await app.get('/garden/b')).text();
    assert.ok(html.includes('A record-driven headline 4242.'));
    assert.ok(!html.includes(THEMES.find((t) => t.slug === 'garden').promise));
  } finally {
    await app.close();
  }
});
