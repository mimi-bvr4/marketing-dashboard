// ORDER #3627: ONE Pinterest Paul card for the Pinterest Standard demo video.
// IHG account, the sandbox board "IH Pin Publisher demo", one real IHG post.
// Fakes only: nothing here reaches WordPress or Pinterest.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const D = require('../lib/pinterest-demo-card');
const PV = require('../lib/pinterest-venues');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const P = require('../lib/producer');

const ON = { PINTEREST_SANDBOX: 'on', PINTEREST_PER_VENUE: 'on' };
const BOARD = 'IH Pin Publisher demo';
const IHG_CONNECTED = [{ venue: 'IHG', connected: true, boards: [{ id: 'sb-1', name: BOARD }] }];
const NEW_POST = 'https://infinityhospitalitygroup.com/blog/winter-wedding-nashville/';
const OLD_POST = 'https://infinityhospitalitygroup.com/blog/spring-venues/';

function fakeWp(list = [
  { link: OLD_POST, date: '2026-03-02T09:00:00', slug: 'spring-venues', title: { rendered: 'Spring venues' } },
  { link: NEW_POST, date: '2026-11-10T09:00:00', slug: 'winter-wedding-nashville', title: { rendered: 'Winter weddings' } },
]) {
  const calls = [];
  const f = async (u) => {
    calls.push(String(u));
    const h = new Map([['content-type', 'application/json'], ['x-wp-totalpages', '1'], ['x-wp-total', String(list.length)]]);
    return { status: 200, url: u, headers: { get: (k) => h.get(k.toLowerCase()) || null }, text: async () => JSON.stringify(list) };
  };
  return { f, calls };
}
const newStore = () => createMemoryStore({ lint });

test('the one check: sandbox on, per-venue on, IHG Connected with the demo board, Paul only', () => {
  assert.strictEqual(D.demoAllowed({ env: ON, accounts: IHG_CONNECTED }).ok, true);
  assert.match(D.demoAllowed({ env: { PINTEREST_PER_VENUE: 'on' }, accounts: IHG_CONNECTED }).why, /PINTEREST_SANDBOX is off/);
  assert.match(D.demoAllowed({ env: { PINTEREST_SANDBOX: 'on' }, accounts: IHG_CONNECTED }).why, /PINTEREST_PER_VENUE is off/);
  assert.match(D.demoAllowed({ env: ON, accounts: [] }).why, /not Connected/);
  assert.match(D.demoAllowed({ env: ON, accounts: [{ venue: 'IHG', connected: false, boards: [] }] }).why, /not Connected/);
  assert.match(D.demoAllowed({ env: ON, accounts: [{ venue: 'IHG', connected: true, boards: [{ name: 'Weddings' }] }] }).why, /no "IH Pin Publisher demo" board/);
  assert.match(D.demoAllowed({ env: ON, accounts: IHG_CONNECTED, venue: 'SWF' }).why, /only the IHG account/);
  assert.match(D.demoAllowed({ env: ON, accounts: IHG_CONNECTED, agent: 'bloggy-bob' }).why, /only Pinterest Paul/);
  assert.match(D.demoAllowed({ env: ON, accounts: IHG_CONNECTED, board: 'Weddings' }).why, /only the "IH Pin Publisher demo" board/);
});

test('before IHG connects nothing is queued and the WordPress list is not even read', async () => {
  const store = newStore(); const wp = fakeWp();
  const r = await D.queueDemo({ store, accounts: [], env: ON, fetchImpl: wp.f });
  assert.strictEqual(r.queued, false);
  assert.strictEqual(wp.calls.length, 0);
  assert.strictEqual((await store.runRequests()).length, 0);
});

test('once IHG is Connected: exactly ONE Paul run, for the newest real IHG post, and never a second', async () => {
  const store = newStore(); const wp = fakeWp();
  const r = await D.queueDemo({ store, accounts: IHG_CONNECTED, env: ON, fetchImpl: wp.f });
  assert.strictEqual(r.queued, true, JSON.stringify(r));
  assert.strictEqual(r.request.agent, 'pinterest-paul');
  assert.strictEqual(r.link, NEW_POST);
  assert.ok(r.request.ask.startsWith(`Pin this post: ${NEW_POST}`));
  assert.match(r.request.ask, /SANDBOX only/);
  assert.ok(!/[—]/.test(r.request.ask), 'no em dash');
  assert.strictEqual(r.request.priority, 2, 'a person-class ask, never behind the chains');
  assert.ok(wp.calls[0].startsWith('https://infinityhospitalitygroup.com/wp-json/wp/v2/posts'));
  for (let i = 0; i < 3; i++) {
    const again = await D.queueDemo({ store, accounts: IHG_CONNECTED, env: ON, fetchImpl: wp.f });
    assert.strictEqual(again.queued, false);
  }
  assert.strictEqual((await store.runRequests()).length, 1, 'at most one demo run');
});

test('a failed run with no card gets ONE retry; a run that made a card never does', async () => {
  const store = newStore(); const wp = fakeWp();
  const r1 = await D.queueDemo({ store, accounts: IHG_CONNECTED, env: ON, fetchImpl: wp.f });
  await store.finishRunRequest(r1.request.id, false, "the model's answer was not valid JSON twice");
  const r2 = await D.queueDemo({ store, accounts: IHG_CONNECTED, env: ON, fetchImpl: wp.f });
  assert.strictEqual(r2.queued, true, JSON.stringify(r2));
  await store.finishRunRequest(r2.request.id, false, 'failed again');
  const r3 = await D.queueDemo({ store, accounts: IHG_CONNECTED, env: ON, fetchImpl: wp.f });
  assert.strictEqual(r3.queued, false);
  assert.match(r3.why, /failed 2 times/);
  assert.strictEqual((await store.runRequests()).length, D.MAX_ATTEMPTS);

  const s2 = newStore();
  const a = await D.queueDemo({ store: s2, accounts: IHG_CONNECTED, env: ON, fetchImpl: wp.f });
  await s2.finishRunRequest(a.request.id, false, 'card(s) #7 then a later error');
  const b = await D.queueDemo({ store: s2, accounts: IHG_CONNECTED, env: ON, fetchImpl: wp.f });
  assert.strictEqual(b.queued, false);
  assert.match(b.why, /already made a card/);
});

test('the demo card gets the IHG account and the demo board, as a draft, and nothing else is touched', async () => {
  const store = newStore(); const wp = fakeWp();
  const q = await D.queueDemo({ store, accounts: IHG_CONNECTED, env: ON, fetchImpl: wp.f });
  const pin = PV.placePin({ board: '(Katherine picks)', title: 'Winter weddings in Nashville', description: 'A winter wedding.', link: NEW_POST, image_url: 'https://infinityhospitalitygroup.com/wp-content/uploads/w.jpg', alt_text: 'x' });
  const now = new Date();
  store.cards.push({ id: 41, agent: 'pinterest-paul', status: 'draft', title: 'Other pin', payload: { pin: { ...pin, link: OLD_POST } }, created_at: now });
  store.cards.push({ id: 42, agent: 'pinterest-paul', status: 'draft', title: 'Demo pin', payload: { pin }, created_at: now });
  assert.strictEqual(PV.pinBlockers(pin).length, 1, 'before: the board still has to be picked');
  await store.finishRunRequest(q.request.id, true, 'card(s) #42');

  const r = await D.pickDemoBoard({ store, accounts: IHG_CONNECTED, env: ON });
  assert.deepStrictEqual(r, { picked: true, card: 42 });
  const c = await store.get(42);
  assert.strictEqual(c.payload.pin.venue, 'IHG');
  assert.strictEqual(c.payload.pin.board, BOARD);
  assert.deepStrictEqual(PV.pinBlockers(c.payload.pin), [], 'Approve is no longer blocked');
  assert.strictEqual(c.status, 'draft', 'still waits for Approve');
  assert.strictEqual((await store.get(41)).payload.pin.board, '(Katherine picks)', 'another Paul card is left alone');
  assert.strictEqual((await D.pickDemoBoard({ store, accounts: IHG_CONNECTED, env: ON })).why, 'already picked');
  assert.strictEqual((await D.pickDemoBoard({ store, accounts: IHG_CONNECTED, env: {} })).picked, false, 'sandbox off: nothing');
});

test('the Producer hold never gated the run-request queue, so the demo needs no bypass', () => {
  assert.ok(!P.DEFAULT_WEEK.some((e) => e.agent === 'pinterest-paul'), 'Paul is not on the calendar the hold brakes');
  const src = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'agent_requests.js'), 'utf8');
  assert.ok(!/decide\(|holdOn|draftsWaiting/.test(src), 'the request runner reads no hold');
  assert.ok(!/EXEMPT|holdOn|decide\(/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'pinterest-demo-card.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '')), 'the demo file widens no hold');
});

test('wired: the 15-minute hand-off job runs both steps after the accounts sync and before the hand-off', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'agent_handoff.js'), 'utf8');
  const sync = src.indexOf('syncAccounts(');
  const q = src.indexOf('queueDemo(');
  const pick = src.indexOf('pickDemoBoard(');
  const hand = src.indexOf('await handoff(');
  assert.ok(sync > 0 && q > sync && pick > sync && q < hand && pick < hand, 'order: sync, demo steps, hand-off');
});
