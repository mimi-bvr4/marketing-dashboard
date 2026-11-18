// ORDER #3539: Mimi's 11.17.2026 popup ruling YES to boards:write on Trial, sandbox
// only, IHG only, exactly ONE board ("IH Pin Publisher demo") so #3505's demo pin
// has a home. Fake client only: nothing here ever reaches Pinterest.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PV = require('../lib/pinterest-venues');
const pt = require('../lib/pinterest');
const pc = require('../lib/pinterest-connect');

const PROD = 'https://api.pinterest.com/v5';
const SANDBOX = 'https://api-sandbox.pinterest.com/v5';
const ACCESS = 'fake-access-tok-3539';
const REFRESH_IHG = 'fake-refresh-ihg-3539';
const SECRETS = (n) => ({ 'pinterest-app-id': 'app', 'pinterest-app-secret': 'sec', 'pinterest-refresh-token-ihg': REFRESH_IHG, 'pinterest-refresh-token-swf': 'fake-refresh-swf-3539' }[n] || null);
const ON = { PINTEREST_SANDBOX: 'on', PINTEREST_PER_VENUE: 'on' };
const res = (status, body) => ({ ok: status < 400, status, json: async () => body });
const board = () => require('../lib/pinterest-sandbox-board');

function fakePinterest({ sandboxBoards = [], refuseBoard = false, failRead = false } = {}) {
  const calls = [];
  const f = async (u, o = {}) => {
    calls.push({ m: o.method || 'GET', u: String(u).split('?')[0], body: o.body });
    if (u.endsWith('/oauth/token')) return res(200, { access_token: ACCESS });
    if (u.startsWith(SANDBOX) && u.includes('/boards') && o.method === 'POST') {
      if (refuseBoard) return res(403, { message: 'scope boards:write not granted' });
      const b = JSON.parse(o.body); const nb = { id: `sb-${sandboxBoards.length + 1}`, name: b.name }; sandboxBoards.push(nb); return res(201, nb);
    }
    if (u.includes('/boards') && failRead) return res(500, { message: 'down' });
    if (u.startsWith(SANDBOX) && u.includes('/boards')) return res(200, { items: sandboxBoards, bookmark: null });
    if (u.startsWith(PROD) && u.includes('/boards')) return res(200, { items: [], bookmark: null });
    return res(404, {});
  };
  return { f, calls, sandboxBoards };
}
const boardPosts = (calls) => calls.filter((c) => c.m === 'POST' && c.u.endsWith('/boards'));
const prodNonLogin = (calls) => calls.filter((c) => c.u.startsWith(PROD) && !c.u.endsWith('/oauth/token'));

test('scopes: switch ON asks IHG for boards:write too; switch OFF the scopes are exactly the old three', () => {
  assert.strictEqual(PV.scopesFor('IHG', { PINTEREST_SANDBOX: 'on' }), 'boards:read,boards:write,pins:read,pins:write');
  assert.strictEqual(PV.scopesFor('IHG', {}), 'boards:read,pins:read,pins:write');
  assert.strictEqual(PV.scopesFor('IHG', { PINTEREST_SANDBOX: 'off' }), 'boards:read,pins:read,pins:write');
  assert.strictEqual(PV.scopesFor('SWF', { PINTEREST_SANDBOX: 'on' }), 'boards:read,pins:read,pins:write', 'only IHG ever asks for boards:write');
  assert.strictEqual(PV.SCOPES, 'boards:read,pins:read,pins:write', 'the default constant is unchanged');
  const on = new URL(PV.authorizeUrl({ appId: 'app', redirectUri: 'https://m/cb', state: PV.newState('IHG'), env: { PINTEREST_SANDBOX: 'on' } }));
  assert.strictEqual(on.searchParams.get('scope'), 'boards:read,boards:write,pins:read,pins:write');
  const off = new URL(PV.authorizeUrl({ appId: 'app', redirectUri: 'https://m/cb', state: PV.newState('IHG'), env: {} }));
  assert.strictEqual(off.searchParams.get('scope'), 'boards:read,pins:read,pins:write');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pinterest.js'), 'utf8');
  assert.match(route, /authorizeUrl\(\{[^}]*\benv\b[^}]*\}\)/, 'the Connect route hands the switch to authorizeUrl');
});

test('the board call happens only with the switch on and only for IHG', async () => {
  const off = fakePinterest();
  assert.ok((await board().ensureSandboxBoard({ token: ACCESS, venue: 'IHG', existing: [], fetchImpl: off.f, env: {} })).skip);
  assert.deepStrictEqual(off.calls, [], 'switch OFF: no call at all');
  const swf = fakePinterest();
  assert.ok((await board().ensureSandboxBoard({ token: ACCESS, venue: 'SWF', existing: [], fetchImpl: swf.f, env: ON })).skip);
  assert.deepStrictEqual(swf.calls, [], 'not IHG: no call at all');
  const ihg = fakePinterest();
  const r = await board().ensureSandboxBoard({ token: ACCESS, venue: 'IHG', existing: [], fetchImpl: ihg.f, env: ON });
  assert.deepStrictEqual(r.made, { id: 'sb-1', name: 'IH Pin Publisher demo' });
  assert.strictEqual(board().BOARD_NAME, 'IH Pin Publisher demo');
});

test('the board call never goes to the production host', async () => {
  const { f, calls } = fakePinterest();
  await board().ensureSandboxBoard({ token: ACCESS, venue: 'IHG', existing: [], fetchImpl: f, env: ON });
  assert.deepStrictEqual(boardPosts(calls).map((c) => c.u), [`${SANDBOX}/boards`]);
  assert.deepStrictEqual(prodNonLogin(calls), []);
  // Static fence: the only board-making call in all the Pinterest code is this file's, on SANDBOX_API.
  const lib = path.join(__dirname, '..', 'lib');
  for (const f2 of fs.readdirSync(lib).filter((n) => /^pinterest.*\.js$/.test(n))) {
    const src = fs.readFileSync(path.join(lib, f2), 'utf8');
    assert.doesNotMatch(src, /method:\s*'(PATCH|PUT|DELETE)'/, f2);
    const boardPostsInSrc = src.match(/\/boards`\s*,\s*\{\s*method:\s*'POST'/g) || [];
    if (f2 === 'pinterest-sandbox-board.js') {
      assert.strictEqual(boardPostsInSrc.length, 1, 'exactly one board-making call');
      assert.match(src, /\$\{pt\.SANDBOX_API\}\/boards`\s*,\s*\{\s*method:\s*'POST'/, 'and it is on the sandbox host constant');
    } else assert.strictEqual(boardPostsInSrc.length, 0, `${f2} makes no board`);
  }
});

test('only one board is ever made: a second run, or a sandbox with any board, makes none', async () => {
  const accounts = PV.createMemoryAccounts();
  const fake = fakePinterest();
  const logs = [];
  const run = () => pc.syncAccounts({ accounts, fetchImpl: fake.f, secrets: SECRETS, save: () => {}, log: (l) => logs.push(l), env: ON });
  await run(); await run(); await run();
  assert.strictEqual(boardPosts(fake.calls).length, 1, 'three runs, one board');
  assert.deepStrictEqual(fake.sandboxBoards.map((b) => b.name), ['IH Pin Publisher demo']);
  const ihg = (await accounts.list()).find((a) => a.venue === 'IHG');
  assert.deepStrictEqual(ihg.boards.map((b) => b.name), ['IH Pin Publisher demo'], 'the Settings row shows the new board at once');
  assert.strictEqual(ihg.why, null);
  assert.deepStrictEqual(prodNonLogin(fake.calls), []);
  assert.match(logs.join('\n'), /made the sandbox board "IH Pin Publisher demo"/);
  for (const s of [ACCESS, REFRESH_IHG, 'sec']) assert.ok(!logs.join('\n').includes(s), `log carries ${s}`);
  // A sandbox that already holds a board of any name gets none.
  const other = fakePinterest({ sandboxBoards: [{ id: 'x', name: 'Something else' }] });
  await pc.syncAccounts({ accounts: PV.createMemoryAccounts(), fetchImpl: other.f, secrets: SECRETS, save: () => {}, log: () => {}, env: ON });
  assert.strictEqual(boardPosts(other.calls).length, 0);
  // A failed board read makes none.
  const down = fakePinterest({ failRead: true });
  await pc.syncAccounts({ accounts: PV.createMemoryAccounts(), fetchImpl: down.f, secrets: SECRETS, save: () => {}, log: () => {}, env: ON });
  assert.strictEqual(boardPosts(down.calls).length, 0);
});

test('a refused board (IHG connected before boards:write) says Connect again, never throws, logs no token', async () => {
  const accounts = PV.createMemoryAccounts();
  const fake = fakePinterest({ refuseBoard: true });
  const logs = [];
  await pc.syncAccounts({ accounts, fetchImpl: fake.f, secrets: SECRETS, save: () => {}, log: (l) => logs.push(l), env: ON });
  const ihg = (await accounts.list()).find((a) => a.venue === 'IHG');
  assert.strictEqual(ihg.connected, true);
  assert.deepStrictEqual(ihg.boards, []);
  assert.strictEqual(ihg.why, pt.NO_SANDBOX_BOARD);
  assert.match(pt.NO_SANDBOX_BOARD, /Connect again/);
  assert.match(logs.join('\n'), /sandbox board not made/);
  for (const s of [ACCESS, REFRESH_IHG, 'sec']) assert.ok(!logs.join('\n').includes(s));
});

test('switch OFF: syncAccounts makes no board on any host, even with every board list empty', async () => {
  const fake = fakePinterest();
  await pc.syncAccounts({ accounts: PV.createMemoryAccounts(), fetchImpl: fake.f, secrets: SECRETS, save: () => {}, log: () => {}, env: { PINTEREST_PER_VENUE: 'on' } });
  assert.strictEqual(boardPosts(fake.calls).length, 0);
  assert.ok(fake.calls.every((c) => !c.u.startsWith(SANDBOX)));
});
