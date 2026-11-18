// ORDER #3505: Pinterest app is on Trial. PINTEREST_SANDBOX=on (default OFF) sends
// every pin and board call to Pinterest's sandbox host, so the Standard-upgrade demo
// pin is a Sandbox entity only its creator can see, and only the Infinity Hospitality
// Group account (the app owner's) is connected until Standard.
// Fake client only: nothing here ever reaches Pinterest.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PV = require('../lib/pinterest-venues');
const pt = require('../lib/pinterest');
const pc = require('../lib/pinterest-connect');
const { handoff } = require('../jobs/agent_handoff');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const PROD = 'https://api.pinterest.com/v5';
const SANDBOX = 'https://api-sandbox.pinterest.com/v5';
const REFRESH_IHG = 'fake-refresh-ihg-0005';
const REFRESH_SWF = 'fake-refresh-swf-0001';
const CODE_IHG = 'good-code-ihg-777';
const ACCESS = 'fake-access-tok-999';
const SECRETS = (n) => ({ 'pinterest-app-id': 'app', 'pinterest-app-secret': 'sec',
  'pinterest-refresh-token': REFRESH_IHG, 'pinterest-refresh-token-ihg': REFRESH_IHG, 'pinterest-refresh-token-swf': REFRESH_SWF }[n] || null);

const res = (status, body) => ({ ok: status < 400, status, json: async () => body });

function fakePinterest({ sandboxBoards = [{ id: 'sb-1', name: 'IH Sandbox Demo' }] } = {}) {
  const calls = [];
  const f = async (u, o = {}) => {
    calls.push({ m: o.method || 'GET', u: String(u).split('?')[0], body: o.body });
    if (u.endsWith('/oauth/token')) {
      const b = String(o.body || '');
      if (b.includes('grant_type=authorization_code')) return b.includes(`code=${CODE_IHG}`) ? res(200, { access_token: ACCESS, refresh_token: REFRESH_IHG }) : res(400, { message: 'invalid code' });
      return res(200, { access_token: ACCESS });
    }
    if (u.startsWith(SANDBOX) && u.includes('/boards') && o.method === 'POST') { const b = JSON.parse(o.body); sandboxBoards.push({ id: 'sb-new', name: b.name }); return res(201, { id: 'sb-new', name: b.name }); }
    if (u.startsWith(SANDBOX) && u.includes('/boards')) return res(200, { items: sandboxBoards, bookmark: null });
    if (u.startsWith(PROD) && u.includes('/boards')) return res(200, { items: [{ id: 'real-1', name: 'IH Sandbox Demo' }, { id: 'real-2', name: 'Weddings' }], bookmark: null });
    if (u.endsWith('/pins') && o.method === 'POST') return res(201, { id: u.startsWith(SANDBOX) ? 'sandbox-321' : '987' });
    return res(404, {});
  };
  return { f, calls };
}

const IHG_POST = 'https://infinityhospitalitygroup.com/blog/nashville-wedding-venues/';
const IHG_IMG = 'https://infinityhospitalitygroup.com/wp-content/uploads/2026/05/downtown.jpg';
const SWF_POST = 'https://saddlewoodsfarm.com/blog/barn-wedding-venues-tennessee/';
const SWF_IMG = 'https://saddlewoodsfarm.com/wp-content/uploads/2026/05/barn-ceremony.jpg';
const pinFor = (link, image_url, board, venue) => ({ board, title: 'Wedding venues near Nashville', description: 'A wedding near Nashville.', link, image_url, alt_text: 'A ceremony', ...(venue ? { venue } : {}) });
const evidenceFor = (link, img) => `Post: ${link}\n| 1 | ${img} | x |`;
const notProdWrite = (calls) => calls.filter((c) => c.u.startsWith(PROD) && !c.u.endsWith('/oauth/token'));

test('the switch: PINTEREST_SANDBOX is OFF unless it says on, and the sandbox host is Pinterest\'s', () => {
  assert.strictEqual(pt.sandboxOn({}), false);
  assert.strictEqual(pt.sandboxOn({ PINTEREST_SANDBOX: 'off' }), false);
  assert.strictEqual(pt.sandboxOn({ PINTEREST_SANDBOX: 'on' }), true);
  assert.strictEqual(pt.SANDBOX_API, SANDBOX);
  assert.strictEqual(pt.apiFor({}), PROD);
  assert.strictEqual(pt.apiFor({ PINTEREST_SANDBOX: 'on' }), SANDBOX);
});

test('sandbox ON, one account: the pin goes to the sandbox host and never to the production pins host', async () => {
  const { f, calls } = fakePinterest();
  const r = await pt.createPin({ pin: pinFor(IHG_POST, IHG_IMG, 'IH Sandbox Demo'), evidence: evidenceFor(IHG_POST, IHG_IMG), fetchImpl: f, secrets: SECRETS, env: { PINTEREST_SANDBOX: 'on' } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.id, 'sandbox-321');
  assert.strictEqual(r.sandbox, true);
  assert.strictEqual(r.url, null, 'a sandbox pin has no public URL');
  assert.deepStrictEqual(notProdWrite(calls), [], 'only the OAuth login trade may touch the production host');
  assert.ok(calls.some((c) => c.m === 'POST' && c.u === `${SANDBOX}/pins`));
});

test('sandbox ON, per venue: the IHG account pins to the sandbox; any other account waits for Standard with no call at all', async () => {
  const env = { PINTEREST_SANDBOX: 'on', PINTEREST_PER_VENUE: 'on' };
  const a = fakePinterest();
  const ok = await pt.createPin({ pin: pinFor(IHG_POST, IHG_IMG, 'IH Sandbox Demo', 'IHG'), evidence: evidenceFor(IHG_POST, IHG_IMG), fetchImpl: a.f, secrets: SECRETS, env });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.venue, 'IHG');
  assert.deepStrictEqual(notProdWrite(a.calls), []);
  const b = fakePinterest();
  const no = await pt.createPin({ pin: pinFor(SWF_POST, SWF_IMG, 'Barn Weddings', 'SWF'), evidence: evidenceFor(SWF_POST, SWF_IMG), fetchImpl: b.f, secrets: SECRETS, env });
  assert.strictEqual(no.ok, undefined);
  assert.ok(no.retry, 'waits, never fails');
  assert.match(no.why, /Trial/);
  assert.deepStrictEqual(b.calls, []);
});

test('switch OFF is unchanged: production host, public pin URL, no sandbox flag', async () => {
  const { f, calls } = fakePinterest();
  const r = await pt.createPin({ pin: pinFor(IHG_POST, IHG_IMG, 'Weddings'), evidence: evidenceFor(IHG_POST, IHG_IMG), fetchImpl: f, secrets: SECRETS, env: {} });
  assert.deepStrictEqual(r, { ok: true, id: '987', url: 'https://www.pinterest.com/pin/987/', board: 'Weddings' });
  assert.ok(calls.every((c) => !c.u.startsWith(SANDBOX)));
  assert.strictEqual(PV.connectAllowed('SWF', {}), true);
  assert.strictEqual(PV.connectAllowed('IHG', {}), true);
});

test('sandbox ON: Connect is only for the IHG account until Standard', () => {
  const env = { PINTEREST_SANDBOX: 'on' };
  assert.strictEqual(PV.connectAllowed('IHG', env), true);
  assert.strictEqual(PV.connectAllowed('ihg', env), true);
  for (const v of PV.CONNECTABLE.filter((x) => x.code !== 'IHG')) assert.strictEqual(PV.connectAllowed(v.code, env), false, v.code);
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pinterest.js'), 'utf8');
  assert.match(route, /connectAllowed\(/, 'the Connect route asks connectAllowed');
});

test('sandbox ON: the Box trades only the IHG code, reads sandbox boards, makes only the one sandbox board (#3539), and logs no token or code', async () => {
  const env = { PINTEREST_SANDBOX: 'on', PINTEREST_PER_VENUE: 'on' };
  const accounts = PV.createMemoryAccounts();
  await accounts.addConnect({ state: 'IHG.' + 'a'.repeat(36), venue: 'IHG', who: 'mimi@', redirectUri: 'https://x/cb' });
  await accounts.setCode('IHG.' + 'a'.repeat(36), CODE_IHG);
  await accounts.addConnect({ state: 'SWF.' + 'b'.repeat(36), venue: 'SWF', who: 'mimi@', redirectUri: 'https://x/cb' });
  await accounts.setCode('SWF.' + 'b'.repeat(36), 'good-code-swf-1');
  const saved = {}; const logs = [];
  const { f, calls } = fakePinterest({ sandboxBoards: [] });
  const secrets = (n) => saved[n] || ({ 'pinterest-app-id': 'app', 'pinterest-app-secret': 'sec' }[n] || null);
  const out = await pc.syncAccounts({ accounts, fetchImpl: f, secrets, save: (k, v) => { saved[k] = v; }, log: (l) => logs.push(l), env });
  assert.strictEqual(out.traded, 1);
  assert.strictEqual(saved['pinterest-refresh-token-ihg'], REFRESH_IHG);
  assert.strictEqual(saved['pinterest-refresh-token-swf'], undefined);
  const swf = accounts._connects.get('SWF.' + 'b'.repeat(36));
  assert.match(swf.outcome, /Trial/);
  assert.strictEqual(swf.code, null, 'the refused code is still wiped');
  assert.ok(!calls.some((c) => String(c.body || '').includes('good-code-swf-1')), 'the refused code is never sent to Pinterest');
  const ihg = (await accounts.list()).find((a) => a.venue === 'IHG');
  assert.strictEqual(ihg.connected, true);
  // #3539 (Mimi 11.17.2026 YES, sandbox only) superseded "never makes a board": an
  // empty IHG sandbox now gets exactly ONE board, on the sandbox host only.
  assert.deepStrictEqual(ihg.boards.map((b) => b.name), ['IH Pin Publisher demo'], 'the empty sandbox gets the one demo board');
  assert.strictEqual(ihg.why, null);
  assert.deepStrictEqual(notProdWrite(calls), [], 'boards come from the sandbox host');
  assert.ok(calls.some((c) => c.m === 'GET' && c.u === `${SANDBOX}/boards`));
  assert.deepStrictEqual(calls.filter((c) => c.m === 'POST' && c.u.endsWith('/boards')).map((c) => c.u), [`${SANDBOX}/boards`], 'one board, sandbox host only, never a real one');
  // Only the IHG account is checked on Trial.
  assert.deepStrictEqual((await accounts.list()).map((a) => a.venue), ['IHG']);
  const all = logs.join('\n');
  for (const s of [CODE_IHG, 'good-code-swf-1', REFRESH_IHG, ACCESS, 'sec']) assert.ok(!all.includes(s), `log carries ${s}`);
});

test('switch OFF: syncAccounts never creates a board and never touches the sandbox host', async () => {
  const accounts = PV.createMemoryAccounts();
  const { f, calls } = fakePinterest();
  await pc.syncAccounts({ accounts, fetchImpl: f, secrets: SECRETS, save: () => {}, log: () => {}, env: {} });
  assert.ok(calls.every((c) => !c.u.startsWith(SANDBOX)));
  assert.ok(!calls.some((c) => c.m === 'POST' && c.u.endsWith('/boards')));
});

test('handoff: an approved card on Trial is pinned in the sandbox, its id is kept, and no token is logged', async () => {
  const store = createMemoryStore({ lint });
  const card = await store.insert({ agent: 'pinterest-paul', agent_name: 'Pinterest Paul', job: 'pin', title: 'Pin: Nashville wedding venues', body: 'Pin for the IH blog post.',
    payload: { pin: pinFor(IHG_POST, IHG_IMG, 'IH Sandbox Demo'), evidence: evidenceFor(IHG_POST, IHG_IMG) } });
  await store.decide(card.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
  const { f, calls } = fakePinterest();
  const logs = [];
  await handoff({ store, fetchImpl: f, secrets: SECRETS, env: { PINTEREST_SANDBOX: 'on' }, log: (l) => logs.push(l) });
  const h = (await store.get(card.id)).handoff;
  assert.strictEqual(h.ok, true, JSON.stringify(h));
  assert.strictEqual(h.pin_id, 'sandbox-321');
  assert.strictEqual(h.sandbox, true);
  assert.deepStrictEqual(notProdWrite(calls), []);
  const all = logs.join('\n');
  assert.match(all, /SANDBOX/);
  assert.match(all, /sandbox-321/);
  for (const s of [REFRESH_IHG, ACCESS]) assert.ok(!all.includes(s));
});

test('the review card shows a sandbox pin\'s id and says only its creator can see it', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.match(page, /h\.sandbox/);
  assert.match(page, /Sandbox pin/);
});
