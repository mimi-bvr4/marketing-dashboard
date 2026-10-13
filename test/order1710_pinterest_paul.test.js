// ORDER #1710: Pinterest Paul (Mimi 10.13.2026, popup: "Post live on approve").
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pt = require('../lib/pinterest');
const { blogPostSource, postImages } = require('../lib/agent-sources');
const { runAgent } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { handoff } = require('../jobs/agent_handoff');
const { lint } = require('../lib/ai-tells');
const { matchAgent } = require('../jobs/kh_route');

const POST = 'https://saddlewoodsfarm.com/blog/barn-wedding-venues-tennessee/';
const IMG = 'https://saddlewoodsfarm.com/wp-content/uploads/2026/05/barn-ceremony.jpg';
const HTML = `<html><head><title>Barn Wedding Venues in Tennessee - Saddle Woods Farm</title>
<meta name="description" content="A barn wedding near Nashville.">
<meta property="og:image" content="${IMG}"></head><body>
<img src="/wp-content/uploads/logo.svg"><img data-src="/wp-content/uploads/2026/05/reception-lights-1024x683.jpg" alt="Reception under string lights">
<img src="${IMG}" alt="dup of og"><h2>Why a barn</h2><p>Words.</p></body></html>`;

const res = (status, body, url) => ({ ok: status < 400, status, url, headers: { get: () => 'text/html' }, text: async () => body, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
const SECRETS = (n) => ({ 'pinterest-app-id': 'app', 'pinterest-app-secret': 'sec', 'pinterest-refresh-token': 'ref' }[n]);

test('the post source reads the live photos (featured first, no logos, no duplicates, lazy-loaded found)', async () => {
  const imgs = postImages(HTML, POST);
  assert.deepStrictEqual(imgs.map((i) => i.url), [IMG, 'https://saddlewoodsfarm.com/wp-content/uploads/2026/05/reception-lights-1024x683.jpg']);
  const r = await blogPostSource({ type: 'blog_post' }, { ask: `pin this ${POST} please`, fetch: async (u) => res(200, HTML, u) });
  assert.ok(r.ok, r.why);
  assert.match(r.table, new RegExp(`Post: ${POST.replace(/[.?]/g, '\\$&')}`));
  assert.match(r.table, /\| 2 \| https:\/\/saddlewoodsfarm\.com\/wp-content\/uploads\/2026\/05\/reception-lights-1024x683\.jpg \| Reception under string lights \|/);
  const no = await blogPostSource({ type: 'blog_post' }, { ask: 'pin https://example.com/post', fetch: async () => res(200, HTML) });
  assert.match(no.why, /paste the link to one of our blog posts/);
});

const PIN = { board: 'Saddle Woods Farm', title: 'Barn Wedding Venues in Tennessee at Saddle Woods Farm', description: 'A barn wedding near Nashville.', link: POST, image_url: IMG, alt_text: 'A ceremony in the barn' };
const EVIDENCE = `Post: ${POST}\n| 1 | ${IMG} | x |`;

test('checkPin: refuses an invented photo, an outside link, an over-long title and an em dash', () => {
  assert.strictEqual(pt.checkPin(PIN, EVIDENCE), null);
  assert.match(pt.checkPin({ ...PIN, image_url: 'https://cdn.example.com/stock.jpg' }, EVIDENCE), /not one of the photos/);
  assert.match(pt.checkPin({ ...PIN, link: 'https://competitor.com/x' }, EVIDENCE), /not a page on one of our sites/);
  assert.match(pt.checkPin({ ...PIN, link: 'https://thebelltower.com/blog/other/' }, EVIDENCE), /not in the post the Box read/);
  assert.match(pt.checkPin({ ...PIN, title: 'x'.repeat(101) }, EVIDENCE), /over 100/);
  assert.match(pt.checkPin({ ...PIN, description: 'Barns — lovely' }, EVIDENCE), /em dash/);
  assert.match(pt.checkPin({ ...PIN, board: '' }, EVIDENCE), /no board/);
});

function pinterestFake({ boards = [{ id: 'b1', name: 'Saddle Woods Farm' }] } = {}) {
  const calls = [];
  const f = async (u, o = {}) => {
    calls.push([o.method || 'GET', u.replace(pt.API, '')]);
    if (u.endsWith('/oauth/token')) return res(200, { access_token: 'tok' });
    if (u.includes('/boards')) return res(200, { items: boards, bookmark: null });
    if (u.endsWith('/pins') && o.method === 'POST') { calls.body = JSON.parse(o.body); return res(201, { id: '987' }); }
    return res(404, {});
  };
  return { f, calls };
}

test('createPin: token, boards, one POST /pins with the board id; nothing else is written', async () => {
  const { f, calls } = pinterestFake();
  const r = await pt.createPin({ pin: PIN, evidence: EVIDENCE, fetchImpl: f, secrets: SECRETS });
  assert.deepStrictEqual(r, { ok: true, id: '987', url: 'https://www.pinterest.com/pin/987/', board: 'Saddle Woods Farm' });
  assert.deepStrictEqual(calls.map(([m, u]) => `${m} ${u.split('?')[0]}`), ['POST /oauth/token', 'GET /boards', 'POST /pins']);
  assert.deepStrictEqual(calls.body, { board_id: 'b1', title: PIN.title, description: PIN.description, link: POST, alt_text: PIN.alt_text, media_source: { source_type: 'image_url', url: IMG } });
  const nob = await pt.createPin({ pin: { ...PIN, board: 'Weddings' }, evidence: EVIDENCE, fetchImpl: pinterestFake().f, secrets: SECRETS });
  assert.match(nob.why, /no board named "Weddings".*Saddle Woods Farm/);
  const off = await pt.createPin({ pin: PIN, evidence: EVIDENCE, fetchImpl: f, secrets: () => null });
  assert.ok(off.retry); assert.match(off.why, /not connected on the Box yet/);
});

test('the pinning code has no edit, delete or board-changing call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pinterest.js'), 'utf8');
  assert.doesNotMatch(src, /method:\s*'(PATCH|PUT|DELETE)'/);
  assert.strictEqual((src.match(/method: 'POST'/g) || []).length, 2); // the token and the one pin
});

test('end to end: Paul drafts a pin, it waits for Approve, then the handoff pins it once', async () => {
  const store = createMemoryStore({ lint });
  const llm = { model: 'test', complete: async () => JSON.stringify({ cards: [{ title: 'Pin: Barn wedding venues', body: 'The barn ceremony photo reads best on Pinterest.', pin: PIN }] }) };
  const fetchImpl = async (u, o = {}) => (u === POST ? res(200, HTML, u) : pinterestFake().f(u, o));
  const r = await runAgent({ slug: 'pinterest-paul', store, llm, ask: `Pin ${POST}`, env: { IHG_TREE: require('os').tmpdir() }, fetchImpl, log: () => {} });
  assert.ok(r.ok, r.error);
  const card = r.cards[0];
  assert.deepStrictEqual(card.payload.pin, PIN);
  assert.match(card.payload.evidence, /reception-lights/);                 // written by code, not the model
  const pins = pinterestFake();
  assert.deepStrictEqual(await handoff({ store, fetchImpl: pins.f, secrets: SECRETS, log: () => {} }), { seen: 0, done: 0 }); // not approved yet
  await store.decide(card.id, { action: 'edit', who: 'khowe@infinityhospitality.net', body: 'Our barn, our way.' });
  assert.strictEqual((await store.get(card.id)).payload.pin.description, 'Our barn, our way.');
  await store.decide(card.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
  assert.deepStrictEqual(await handoff({ store, fetchImpl: pins.f, secrets: SECRETS, log: () => {} }), { seen: 1, done: 1 });
  assert.strictEqual(pins.calls.body.description, 'Our barn, our way.');
  assert.strictEqual((await store.get(card.id)).handoff.pin_url, 'https://www.pinterest.com/pin/987/');
  assert.deepStrictEqual(await handoff({ store, fetchImpl: pins.f, secrets: SECRETS, log: () => {} }), { seen: 0, done: 0 }); // never twice
});

test('a model that swaps in a photo the post does not have is refused at handoff, and says why', async () => {
  const store = createMemoryStore({ lint });
  const llm = { model: 'test', complete: async () => JSON.stringify({ cards: [{ title: 'Pin', body: 'x', pin: { ...PIN, image_url: 'https://images.example.com/stock.jpg' } }] }) };
  const fetchImpl = async (u) => res(200, HTML, u);
  const r = await runAgent({ slug: 'pinterest-paul', store, llm, ask: POST, env: { IHG_TREE: require('os').tmpdir() }, fetchImpl, log: () => {} });
  await store.decide(r.cards[0].id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
  const pins = pinterestFake();
  await handoff({ store, fetchImpl: pins.f, secrets: SECRETS, log: () => {} });
  assert.match((await store.get(r.cards[0].id)).handoff.why, /not one of the photos/);
  assert.ok(!pins.calls.some(([m, u]) => m === 'POST' && u === '/pins'));
});

test("Katherine's Drive orders reach Paul", () => {
  assert.deepStrictEqual(matchAgent('Pinterest pin for the barn venues post'), ['pinterest-paul']);
});
