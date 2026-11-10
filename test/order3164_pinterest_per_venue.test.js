// ORDER #3164: Pinterest Paul posts to EACH venue's own Pinterest account.
// Fake client only: nothing here ever reaches Pinterest.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PV = require('../lib/pinterest-venues');
const pt = require('../lib/pinterest');
const pc = require('../lib/pinterest-connect');
const { pinterestBoardsSource } = require('../lib/agent-sources');
const { runAgent } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { handoff } = require('../jobs/agent_handoff');
const { lint } = require('../lib/ai-tells');
const { pinterestNeed } = require('../routes/agents');

const ON = { PINTEREST_PER_VENUE: 'on' };
const OFF = {};
// Two fake venue tokens: Saddle Woods Farm and The Bell Tower. The Estate at Cherokee Dock is not connected.
const SECRET_SWF = 'fake-refresh-swf-0001';
const SECRET_TBT = 'fake-refresh-tbt-0002';
const SECRETS = (n) => ({ 'pinterest-app-id': 'app', 'pinterest-app-secret': 'sec',
  'pinterest-refresh-token-swf': SECRET_SWF, 'pinterest-refresh-token-tbt': SECRET_TBT }[n] || null);

const res = (status, body, url) => ({ ok: status < 400, status, url, headers: { get: () => 'text/html' }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
const BOARDS = { swf: [{ id: 'swf-1', name: 'Barn Weddings' }, { id: 'swf-2', name: 'Saddle Woods Farm' }], tbt: [{ id: 'tbt-1', name: 'Downtown Weddings' }] };

// A fake Pinterest: the refresh token decides which account the access token is for.
function fakePinterest() {
  const calls = [];
  const f = async (u, o = {}) => {
    const auth = (o.headers && o.headers.Authorization) || '';
    calls.push({ m: o.method || 'GET', u: u.replace(pt.API, '').split('?')[0], auth, body: o.body });
    if (u.endsWith('/oauth/token')) {
      const b = String(o.body || '');
      if (b.includes('grant_type=authorization_code')) return b.includes('code=good') ? res(200, { access_token: 'x', refresh_token: 'fake-refresh-ecd-0003' }) : res(400, { message: 'invalid code' });
      const who = b.includes(SECRET_SWF) ? 'swf' : b.includes(SECRET_TBT) ? 'tbt' : b.includes('fake-refresh-ecd') ? 'ecd' : 'one';
      return res(200, { access_token: `tok-${who}` });
    }
    if (u.includes('/boards')) return res(200, { items: BOARDS[auth.replace('Bearer tok-', '')] || [], bookmark: null });
    if (u.endsWith('/pins') && o.method === 'POST') { calls.pin = { auth, body: JSON.parse(o.body) }; return res(201, { id: '555' }); }
    return res(404, {});
  };
  return { f, calls };
}

const SWF_POST = 'https://saddlewoodsfarm.com/blog/barn-wedding-venues-tennessee/';
const SWF_IMG = 'https://saddlewoodsfarm.com/wp-content/uploads/2026/05/barn-ceremony.jpg';
const IHG_POST = 'https://infinityhospitalitygroup.com/blog/nashville-wedding-venues/';
const IHG_IMG = 'https://infinityhospitalitygroup.com/wp-content/uploads/2026/05/downtown.jpg';
const ECD_POST = 'https://cherokeedock.com/blog/lake-weddings/';
const ECD_IMG = 'https://cherokeedock.com/wp-content/uploads/2026/05/lake.jpg';
const pinFor = (link, image_url, board) => ({ board, title: 'Wedding venues near Nashville', description: 'A wedding near Nashville.', link, image_url, alt_text: 'A ceremony' });
const evidenceFor = (link, img) => `Post: ${link}\n| 1 | ${img} | x |`;
const html = (img) => `<html><head><title>Venues</title><meta property="og:image" content="${img}"></head><body><h2>Why</h2><p>Words.</p></body></html>`;

test('every venue code is from Venue_Master_CANONICAL.md, and every venue site is one of our sites', (t) => {
  const tree = process.env.IHG_TREE || path.join(os.homedir(), 'Full_IH_Project');
  const file = path.join(tree, '05_AI_and_Brain', 'Venue_Master_CANONICAL.md');
  for (const v of PV.VENUES) assert.ok(pt.OUR_SITES.includes(v.site), v.site);
  if (!fs.existsSync(file)) return t.skip('canonical venue file not on this machine');
  const canon = fs.readFileSync(file, 'utf8');
  for (const v of PV.VENUES) assert.match(canon, new RegExp(`\\*\\*${v.code}\\*\\*`), `${v.code} is not a canonical code`);
});

test('a post picks its account from its site; a shared site asks Katherine; Paul never guesses', () => {
  assert.deepStrictEqual(PV.venueForLink(SWF_POST), { venue: 'SWF' });
  assert.deepStrictEqual(PV.venueForLink('https://www.thebelltower.com/blog/x/'), { venue: 'TBT' });
  assert.deepStrictEqual(PV.venueForLink(IHG_POST), { pick: true });
  assert.deepStrictEqual(PV.venueForLink('https://example.com/x'), { none: true });
  assert.deepStrictEqual(PV.placePin(pinFor(IHG_POST, IHG_IMG, 'x')), { ...pinFor(IHG_POST, IHG_IMG, 'x'), venue: null, pick: true });
  assert.strictEqual(PV.tokenItem('SWF'), 'pinterest-refresh-token-swf');
});

test('single-venue post: pins to that venue account and a board on that account only', async () => {
  const { f, calls } = fakePinterest();
  const pin = PV.placePin(pinFor(SWF_POST, SWF_IMG, 'Barn Weddings'));
  const r = await pt.createPin({ pin, evidence: evidenceFor(SWF_POST, SWF_IMG), fetchImpl: f, secrets: SECRETS, env: ON });
  assert.deepStrictEqual(r, { ok: true, id: '555', url: 'https://www.pinterest.com/pin/555/', board: 'Barn Weddings', venue: 'SWF' });
  assert.strictEqual(calls.pin.auth, 'Bearer tok-swf');
  assert.strictEqual(calls.pin.body.board_id, 'swf-1');
  // The Bell Tower's board does not exist on Saddle Woods Farm's account.
  const wrong = await pt.createPin({ pin: { ...pin, board: 'Downtown Weddings' }, evidence: evidenceFor(SWF_POST, SWF_IMG), fetchImpl: fakePinterest().f, secrets: SECRETS, env: ON });
  assert.ok(wrong.skip); assert.match(wrong.why, /no board named "Downtown Weddings" on Saddle Woods Farm's Pinterest/);
  // A Saddle Woods Farm post can never be sent to The Bell Tower's account.
  const cross = await pt.createPin({ pin: { ...pin, venue: 'TBT' }, evidence: evidenceFor(SWF_POST, SWF_IMG), fetchImpl: fakePinterest().f, secrets: SECRETS, env: ON });
  assert.ok(cross.skip); assert.match(cross.why, /Saddle Woods Farm's site/);
  // The only writes: the login trade and one POST /pins. No board creates, edits or deletes.
  assert.deepStrictEqual(calls.filter((c) => c.m !== 'GET').map((c) => `${c.m} ${c.u}`), ['POST /oauth/token', 'POST /pins']);
});

test('the boards source reads only the post venue account, and says "connect first" for an unconnected venue', async () => {
  const { f } = fakePinterest();
  const swf = await pinterestBoardsSource({ type: 'pinterest_boards' }, { ask: `Pin ${SWF_POST}`, env: ON, fetch: f, secrets: SECRETS });
  assert.ok(swf.ok); assert.match(swf.text, /Saddle Woods Farm's own Pinterest boards/); assert.match(swf.text, /- Barn Weddings/); assert.doesNotMatch(swf.text, /Downtown Weddings/);
  const multi = await pinterestBoardsSource({ type: 'pinterest_boards' }, { ask: `Pin ${IHG_POST}`, env: ON, fetch: f, secrets: SECRETS });
  assert.ok(multi.ok); assert.match(multi.text, /Katherine picks the venue/);
  const ecd = await pinterestBoardsSource({ type: 'pinterest_boards' }, { ask: `Pin ${ECD_POST}`, env: ON, fetch: f, secrets: SECRETS });
  assert.strictEqual(ecd.ok, false); assert.match(ecd.why, /connect The Estate at Cherokee Dock first \(Settings, Pinterest accounts\)/);
});

async function draftCard(link, img, board, env = { ...ON, IHG_TREE: os.tmpdir() }) {
  const store = createMemoryStore({ lint });
  const llm = { model: 'test', complete: async () => JSON.stringify({ cards: [{ title: 'Pin: venues', body: 'The photo reads best on Pinterest.', pin: pinFor(link, img, board) }] }) };
  const fetchImpl = async (u, o = {}) => (u === link ? res(200, html(img), u) : fakePinterest().f(u, o));
  const r = await runAgent({ slug: 'pinterest-paul', store, llm, ask: `Pin ${link}`, env, fetchImpl, log: () => {} });
  assert.ok(r.ok, r.error);
  return { store, card: r.cards[0] };
}

test('multi-venue site: the card asks Katherine to pick; Approve waits for the pick; then it pins to the picked venue', async () => {
  const { store, card } = await draftCard(IHG_POST, IHG_IMG, '(Katherine picks)');
  assert.strictEqual(card.payload.pin.venue, null); assert.strictEqual(card.payload.pin.pick, true);
  const refused = await store.decide(card.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
  assert.match(refused.error, /pick the venue/);
  const accounts = PV.createMemoryAccounts();
  await accounts.save('TBT', { connected: true, boards: BOARDS.tbt });
  await accounts.save('SWF', { connected: true, boards: BOARDS.swf });
  assert.match(PV.choosePin(await store.get(card.id), { venue: 'ECD' }, await accounts.list()).error, /connect The Estate at Cherokee Dock first/);
  assert.match(PV.choosePin(await store.get(card.id), { venue: 'TBT', board: 'Barn Weddings' }, await accounts.list()).error, /The Bell Tower's Pinterest has no board named "Barn Weddings"/);
  const pick = PV.choosePin(await store.get(card.id), { venue: 'TBT', board: 'Downtown Weddings' }, await accounts.list());
  assert.ok(pick.payload, pick.error);
  await store.setPinPayload(card.id, pick.payload);
  const ok = await store.decide(card.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
  assert.ok(!ok.error, ok.error);
  const pins = fakePinterest();
  assert.deepStrictEqual(await handoff({ store, fetchImpl: pins.f, secrets: SECRETS, env: ON, log: () => {} }), { seen: 1, done: 1 });
  assert.strictEqual(pins.calls.pin.auth, 'Bearer tok-tbt');
  assert.strictEqual(pins.calls.pin.body.board_id, 'tbt-1');
  assert.strictEqual((await store.get(card.id)).handoff.venue, 'TBT');
});

test('unconnected venue: the card says "connect first", Approve is allowed, and the handoff waits instead of failing', async () => {
  const { store, card } = await draftCard(ECD_POST, ECD_IMG, 'Lake Weddings');
  assert.strictEqual(card.payload.pin.venue, 'ECD');
  await store.decide(card.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
  const lines = [];
  const pins = fakePinterest();
  assert.deepStrictEqual(await handoff({ store, fetchImpl: pins.f, secrets: SECRETS, env: ON, log: (l) => lines.push(l) }), { seen: 1, done: 0 });
  assert.strictEqual((await store.get(card.id)).handoff || null, null);          // not a failure: still waiting
  assert.ok(lines.some((l) => /will retry, connect The Estate at Cherokee Dock first/.test(l)), lines.join('\n'));
  assert.ok(!pins.calls.some((c) => c.u === '/pins'));
});

test('switch OFF: Paul is exactly #1710 (one account, no venue on the pin)', async () => {
  const { card } = await draftCard(SWF_POST, SWF_IMG, 'Saddle Woods Farm', { IHG_TREE: os.tmpdir() });
  assert.ok(!('venue' in card.payload.pin));
  assert.deepStrictEqual(PV.pinBlockers(card.payload.pin), []);
});

test('Connect: the Box trades the code, saves the token to the Keychain only, wipes the code, and counts Connected', async () => {
  const accounts = PV.createMemoryAccounts();
  await accounts.addConnect({ state: 'ECD.' + 'a'.repeat(36), venue: 'ECD', who: 'khowe@infinityhospitality.net', redirectUri: 'https://m/cb' });
  await accounts.setCode('ECD.' + 'a'.repeat(36), 'good');
  await accounts.addConnect({ state: 'TBB.' + 'b'.repeat(36), venue: 'TBB', who: 'khowe@infinityhospitality.net', redirectUri: 'https://m/cb' });
  await accounts.setCode('TBB.' + 'b'.repeat(36), 'stale');
  const kc = { ...Object.fromEntries(['pinterest-app-id', 'pinterest-app-secret', 'pinterest-refresh-token-swf', 'pinterest-refresh-token-tbt'].map((k) => [k, SECRETS(k)])) };
  const saved = [];
  const lines = [];
  const out = await pc.syncAccounts({ accounts, fetchImpl: fakePinterest().f, secrets: (n) => kc[n] || null,
    save: (item, v) => { saved.push(item); kc[item] = v; }, log: (l) => lines.push(l) });
  assert.deepStrictEqual(saved, ['pinterest-refresh-token-ecd']);
  assert.deepStrictEqual(out, { traded: 1, connected: 3, total: PV.VENUES.length });
  const conn = [...accounts._connects.values()];
  assert.ok(conn.every((c) => c.code === null), 'every code is wiped');
  assert.deepStrictEqual(conn.map((c) => c.outcome.split(':')[0]).sort(), ['connected', 'failed']);
  assert.strictEqual(PV.connectedLine(await accounts.list()).line, `Connected: 3 of ${PV.VENUES.length} venues`);
  // No token in the log lines or in what the dashboard can read.
  const visible = JSON.stringify(await accounts.list()) + JSON.stringify(await accounts.recentConnects()) + lines.join('\n');
  for (const s of [SECRET_SWF, SECRET_TBT, 'fake-refresh-ecd-0003']) assert.ok(!visible.includes(s), 'a token leaked');
});

test('saveSecret hands the token to `security` on stdin, never on the command line', () => {
  const seen = [];
  pc.saveSecret('pinterest-refresh-token-swf', 'pinr.abc123DEF', (cmd, args, o) => seen.push({ cmd, args, input: o.input }));
  assert.deepStrictEqual(seen[0].args, ['-i']);
  assert.match(seen[0].input, /^add-generic-password -U -a ihg-box -s pinterest-refresh-token-swf -w pinr\.abc123DEF\n$/);
  assert.throws(() => pc.saveSecret('x', 'bad token; rm -rf', () => {}), /unexpected shape/);
});

test('Settings, Pinterest accounts lists every venue; Paul\'s card says Connected: X of N with the page link', async () => {
  const rows = [{ venue: 'SWF', connected: true }, { venue: 'TBT', connected: true }];
  const c = pinterestNeed({ role: 'The pinner', needs: ['Katherine to connect our Pinterest business account to the Box once (x)', "Katherine to connect each venue's Pinterest once on y"] }, 'pinterest-paul', rows, ON);
  assert.deepStrictEqual(c.pinterest, { connected: 2, total: PV.VENUES.length, line: `Connected: 2 of ${PV.VENUES.length} venues`, page: '/settings/pinterest' });
  assert.deepStrictEqual(c.character.needs, [`Connected: 2 of ${PV.VENUES.length} venues: connect the rest on Settings, Pinterest accounts (/settings/pinterest)`]);
  const off = pinterestNeed({ needs: ['Katherine to connect our Pinterest business account (x)', "Katherine to connect each venue's Pinterest once on y"] }, 'pinterest-paul', rows, OFF);
  assert.strictEqual(off.pinterest, null); assert.deepStrictEqual(off.character.needs, ['Katherine to connect our Pinterest business account (x)']);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'pinterest-accounts.html'), 'utf8');
  assert.match(page, /api\/pinterest\/accounts/); assert.match(page, /Connect/);
  assert.deepStrictEqual(PV.VENUES.map((v) => v.code), ['TBB', 'TBT', 'ECD', 'SWF', 'STE', 'COR', 'EST']);
});

test('the Connect link asks Pinterest for read boards and write pins only, and carries a one-time state', () => {
  const u = new URL(PV.authorizeUrl({ appId: 'app', redirectUri: 'https://m/settings/pinterest/callback', state: PV.newState('SWF') }));
  assert.strictEqual(u.searchParams.get('scope'), 'boards:read,pins:read,pins:write');
  assert.match(u.searchParams.get('state'), /^SWF\.[0-9a-f]{36}$/);
  assert.notStrictEqual(PV.newState('SWF'), PV.newState('SWF'));
});

test('no board-changing call anywhere in the Pinterest code', () => {
  for (const f of ['pinterest.js', 'pinterest-connect.js', 'pinterest-venues.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    assert.doesNotMatch(src, /method:\s*'(PATCH|PUT|DELETE)'/, f);
    assert.doesNotMatch(src, /\/boards['`]?\s*,\s*\{\s*method:\s*'POST'/, f);
  }
});
