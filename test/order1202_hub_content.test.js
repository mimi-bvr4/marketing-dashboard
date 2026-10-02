'use strict';

// ORDER #1202: #1198's copy-law and photo tests (venue-hub 902f051,
// test/content.test.js), ported to hub/. Every UNVERIFIED copy fact from the
// #1198 REPLY stays held exactly as it was.
// CHANGED from #1198: a cleared photo must also live under /hub-assets/, and
// the em dash sweep covers the hub's own files (the dashboard's older files
// are outside this order).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('./order1202_hub_helpers');
const { THEMES } = require('../hub/data/themes');
const { VENUES, HUB } = require('../hub/data/venues');

const PAGES = ['/', '/garden', '/garden/b', '/garden/c', '/thanks'];

async function allPages(opts) {
  const app = await start(opts);
  try {
    const out = {};
    for (const p of PAGES) out[p] = await (await app.get(p)).text();
    return out;
  } finally {
    await app.close();
  }
}

function heldTexts() {
  const texts = [];
  const visit = (c) => {
    if (c && typeof c === 'object' && c.status === 'UNVERIFIED') texts.push(typeof c.text === 'string' ? c.text : c.text.q);
  };
  for (const v of VENUES) {
    visit(v.blurb);
    v.tags.forEach(visit);
  }
  visit(HUB.phone);
  visit(HUB.email);
  for (const t of THEMES) (t.faq || []).forEach(visit);
  return texts;
}

test('no UNVERIFIED fact renders, in preview or not', async () => {
  const held = heldTexts();
  assert.ok(held.length >= 10, 'the fact-check list is carried in the records');
  for (const preview of [true, false]) {
    const pages = await allPages({ config: { preview } });
    for (const [p, raw] of Object.entries(pages)) {
      // The preview-only reviewer markers name the item being checked; they
      // are the note to Katherine, not page copy, so they are set aside here.
      const html = raw.replace(/<p class="held" data-held="1">[^<]*<\/p>/g, '');
      if (!preview) assert.equal(html, raw, 'no reviewer marker outside preview');
      for (const text of held) assert.ok(!html.includes(text), `${p} published "${text}"`);
      for (const bad of ['1874', '1865', 'Reba', '25 private acres', 'Glass Conservatory', 'four levels']) {
        assert.ok(!html.includes(bad), `${p} contains "${bad}"`);
      }
    }
  }
});

test('the preview shows the held markers so Katherine can see what is waiting', async () => {
  const pages = await allPages({ config: { preview: true } });
  assert.match(pages['/'], /Held for fact check/);
  assert.match(pages['/garden/b'], /Fit: Katherine confirms/);
  const live = await allPages({ config: { preview: false } });
  assert.ok(!live['/'].includes('Held for fact check'));
});

test('no em dash anywhere in the hub source, its tests or its pages', async () => {
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(js|json|md)$/.test(e.name)) files.push(f);
    }
  };
  walk(path.join(root, 'hub'));
  for (const f of fs.readdirSync(__dirname)) if (f.startsWith('order1202_')) files.push(path.join(__dirname, f));
  assert.ok(files.length >= 14, 'the sweep found the hub files');
  const EM_DASH = String.fromCharCode(0x2014);
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(EM_DASH), f);
  for (const [p, html] of Object.entries(await allPages())) assert.ok(!html.includes(EM_DASH), p);
});

test('venue links: TBT and ECD use the Amendment D domains, no dead skeleton domains', async () => {
  const pages = await allPages();
  for (const html of Object.values(pages)) {
    assert.ok(!html.includes('thebelltowernashville.com'));
    assert.ok(!html.includes('theestateatcherokeedock.com'));
    assert.ok(!html.includes('saintellenashville.com'));
  }
  assert.ok(pages['/'].includes('https://thebelltower.com'));
  assert.ok(pages['/'].includes('https://cherokeedock.com'));
});

test('naming law: "The" where it belongs, never on Saint Elle, Estelle or Saddle Woods Farm', async () => {
  const html = (await allPages())['/'];
  for (const n of ['The Bridge Building', 'The Bell Tower', 'The Estate at Cherokee Dock', 'The Cordelle']) assert.ok(html.includes(n), n);
  for (const n of ['The Saint Elle', 'The Estelle', 'The Saddle Woods Farm']) assert.ok(!html.includes(n), n);
});

test('KNOWN-BAD: an "internal only" or "Inspiration, not ours" photo never renders', async () => {
  for (const clearance of ['internal_only', 'inspiration_not_ours', undefined, 'CLEARED_CLIENT_USE']) {
    const themes = structuredClone(THEMES);
    const g = themes.find((t) => t.slug === 'garden');
    g.heroPhoto = { src: '/hub-assets/secret.jpg', clearance };
    g.venues[0].photo = { src: '/hub-assets/secret2.jpg', clearance };
    const app = await start({ themes });
    try {
      for (const p of ['/garden/b', '/garden/c']) {
        const html = await (await app.get(p)).text();
        assert.ok(!html.includes('secret'), `${clearance} rendered on ${p}`);
        assert.ok(!html.includes('<img'), p);
      }
    } finally {
      await app.close();
    }
  }
});

test('KNOWN-BAD: a cleared photo pointing OUTSIDE /hub-assets/ (an internal route) never renders', async () => {
  const themes = structuredClone(THEMES);
  themes.find((t) => t.slug === 'garden').heroPhoto = { src: '/photos/ok.jpg', clearance: 'cleared_client_use' };
  const app = await start({ themes });
  try {
    const html = await (await app.get('/garden/b')).text();
    assert.ok(!html.includes('/photos/ok.jpg'));
    assert.ok(!html.includes('<img'));
  } finally {
    await app.close();
  }
});

test('a cleared photo does render (so the guard is not just "no images ever")', async () => {
  const themes = structuredClone(THEMES);
  themes.find((t) => t.slug === 'garden').heroPhoto = { src: '/hub-assets/ok.jpg', clearance: 'cleared_client_use', alt: 'Garden aisle' };
  const app = await start({ themes });
  try {
    assert.match(await (await app.get('/garden/b')).text(), /<img[^>]+src="\/hub-assets\/ok\.jpg"/);
  } finally {
    await app.close();
  }
  const preview = await start({ themes, config: { basePath: '/hub' } });
  try {
    assert.match(await (await preview.get('/garden/b')).text(), /<img[^>]+src="\/hub\/hub-assets\/ok\.jpg"/);
  } finally {
    await preview.close();
  }
});

test('KNOWN-BAD: /hub-assets/ never serves a photo file that is not in the cleared set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-assets-'));
  fs.writeFileSync(path.join(dir, 'uncleared.jpg'), 'JPEGDATA');
  fs.writeFileSync(path.join(dir, 'cleared.jpg'), 'JPEGDATA');
  fs.writeFileSync(path.join(dir, 'mark.svg'), '<svg/>');
  const app = await start({ assetsDir: dir, clearedPhotos: new Set(['cleared.jpg']) });
  try {
    assert.equal((await app.get('/hub-assets/uncleared.jpg')).status, 404, 'an uncleared photo was served');
    assert.equal((await app.get('/hub-assets/cleared.jpg')).status, 200);
    assert.equal((await app.get('/hub-assets/mark.svg')).status, 200);
    for (const p of ['/hub-assets/..%2Fserver.js', '/hub-assets/../server.js', '/hub-assets/.gitkeep', '/hub-assets/x.html']) {
      assert.notEqual((await app.get(p)).status, 200, p);
    }
  } finally {
    await app.close();
  }
  // And the default: no cleared set at all, so no photo is ever served.
  const bare = await start({ assetsDir: dir });
  try {
    assert.equal((await bare.get('/hub-assets/cleared.jpg')).status, 404);
  } finally {
    await bare.close();
  }
});

test('the hub home links every venue card to its own site, and no theme page', async () => {
  const html = (await allPages())['/'];
  for (const v of VENUES) assert.ok(html.includes(`href="${v.url.href}"`), v.code);
});
