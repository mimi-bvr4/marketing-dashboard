'use strict';
// ORDER #3807 (Mimi 11.24.2026): the Executioner does approved actions.
//
// KNOWN-BAD cases pinned here:
//   - acting on a card nobody approved;
//   - a silent retry beyond one (two tries per approval, then back to Review);
//   - a failure with no words on the card, or not the platform's own words;
//   - a failure that cannot clear (Google 400) being retried at all;
//   - a "wait" (a setup step missing, platform never asked) counted as a failure;
//   - a WordPress ALARM that already made a draft being sent back (a second
//     Approve would make a second draft);
//   - the new rules running while EXECUTIONER is off (it ships OFF);
//   - the Executioner sending email or touching a sales card.
// Fake Google, memory store. Nothing leaves the process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const EX = require('../lib/executioner');
const GP = require('../lib/gbp-post');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { handoff } = require('../jobs/agent_handoff');
const { createDraft } = require('../lib/wp-draft');

const ACCT = 'accounts/1';
const LIVE = 'https://local.google.com/place?id=1&use=posts&lpsid=abc';
const POST = { venue: 'The Bell Tower', keyword: 'downtown nashville wedding venues', keyword_source: 'Search Console GAPS',
  summary: 'Looking for downtown Nashville wedding venues? The Bell Tower sits in the heart of downtown. Book a tour this week.',
  link: 'https://thebelltower.com/weddings/' };
const KATHERINE = 'khowe@infinityhospitality.net';
const auth = { saKey: { client_email: 'x' }, saToken: async () => 't' };
const GBP_ON = { GBP_POST_ON_APPROVE: 'on' };
const BOTH_ON = { GBP_POST_ON_APPROVE: 'on', EXECUTIONER: 'on' };

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
function google({ postStatus = 200 } = {}) {
  const calls = [];
  const f = async (u, o = {}) => {
    const url = String(u);
    calls.push({ url, method: o.method || 'GET' });
    if (url.startsWith('https://mybusinessaccountmanagement')) return json(200, { accounts: [{ name: ACCT }] });
    if (url.includes('/locations?readMask')) return json(200, { locations: [{ name: 'locations/11', title: 'The Bell Tower' }] });
    if (url.endsWith('/localPosts') && o.method === 'POST') {
      if (postStatus !== 200) return json(postStatus, { error: { status: postStatus === 400 ? 'INVALID_ARGUMENT' : 'UNAVAILABLE' } });
      return json(200, { name: `${ACCT}/locations/11/localPosts/99`, searchUrl: LIVE, state: 'LIVE' });
    }
    return json(404, {});
  };
  f.calls = calls;
  return f;
}
const posts = (f) => f.calls.filter((c) => c.method !== 'GET');

function setup() {
  let t = new Date('2026-11-25T17:42:00Z'); // 11:42 CT
  const clock = { now: () => t, set: (d) => { t = new Date(d); } };
  const store = createMemoryStore({ lint, now: clock.now });
  return { store, clock };
}
async function approvedGbp(store) {
  const c = await store.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'x', title: 'Google post: The Bell Tower', body: 'x',
    payload: { gbp_post: GP.parseGbpPost(POST) } });
  const r = await store.decide(c.id, { action: 'approve', who: KATHERINE });
  assert.ok(!r.error, r.error);
  return c.id;
}
const run = (store, f, env, clock) => handoff({ store, fetchImpl: f, env, gbpAuth: auth, log: () => {}, now: clock.now });

test('the switch ships OFF: only "on" turns it on', () => {
  for (const v of [undefined, '', 'off', 'true', 'yes', '1']) assert.strictEqual(EX.on({ EXECUTIONER: v }), false, String(v));
  assert.strictEqual(EX.on({ EXECUTIONER: ' On ' }), true);
});

test('the time is written in CT, the house stamp', () => {
  assert.strictEqual(EX.ctStamp('2026-11-25T17:42:00Z'), '11.25.2026 11:42 CT');
  assert.strictEqual(EX.ctStamp('2026-11-26T03:05:00Z'), '11.25.2026 21:05 CT', 'after 19:00 CT the date is still Nashville\'s');
});

test('KNOWN-BAD: a card nobody approved is never acted on, switch on or off', async () => {
  const { store, clock } = setup();
  const c = await store.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'x', title: 'Google post', body: 'x', payload: { gbp_post: GP.parseGbpPost(POST) } });
  const g = google();
  assert.deepStrictEqual(await run(store, g, BOTH_ON, clock), { seen: 0, done: 0 });
  assert.strictEqual(g.calls.length, 0);
  assert.strictEqual(EX.cardLine(await store.get(c.id)), null);
});

test('success: link, id and time CT are written back on the card', async () => {
  const { store, clock } = setup();
  const id = await approvedGbp(store);
  const g = google();
  assert.deepStrictEqual(await run(store, g, BOTH_ON, clock), { seen: 1, done: 1 });
  const c = await store.get(id);
  assert.strictEqual(c.handoff.link, LIVE);
  assert.strictEqual(c.handoff.id, `${ACCT}/locations/11/localPosts/99`);
  assert.strictEqual(c.handoff.at_ct, '11.25.2026 11:42 CT');
  assert.deepStrictEqual(EX.cardLine(c), { state: 'done', line: `Done 11.25.2026 11:42 CT, id ${ACCT}/locations/11/localPosts/99.`, link: LIVE });
  assert.deepStrictEqual(await run(store, g, BOTH_ON, clock), { seen: 0, done: 0 }, 'never twice');
  assert.strictEqual(posts(g).length, 1);
});

test('KNOWN-BAD: a failure that can clear is retried ONCE, then the card goes back to Review with Google\'s own words', async () => {
  const { store, clock } = setup();
  const id = await approvedGbp(store);
  const g = google({ postStatus: 503 });
  await run(store, g, BOTH_ON, clock);
  let c = await store.get(id);
  assert.strictEqual(c.status, 'ready', 'one retry left: still approved');
  assert.strictEqual(c.handoff, null, 'the claim is released for the retry');
  assert.strictEqual(c.exec.tries, 1);
  assert.strictEqual(EX.cardLine(c).state, 'retry');

  clock.set('2026-11-25T18:00:00Z');
  await run(store, g, BOTH_ON, clock);
  c = await store.get(id);
  assert.strictEqual(c.status, 'draft', 'back on Review');
  assert.strictEqual(c.exec.returned, true);
  assert.strictEqual(c.exec.tries, 2);
  assert.strictEqual(c.exec.error, 'Google refused the post: 503 UNAVAILABLE');
  assert.strictEqual(EX.cardLine(c).line, 'Not done: Google refused the post: 503 UNAVAILABLE (11.25.2026 12:00 CT). Back on Review; Approve again to try once more.');
  assert.ok(!/\n/.test(EX.cardLine(c).line), 'one line');

  await run(store, g, BOTH_ON, clock);
  assert.strictEqual(posts(g).length, 2, 'no third try');
});

test('KNOWN-BAD: a failure that cannot clear (Google 400) goes back to Review at once, never retried', async () => {
  const { store, clock } = setup();
  const id = await approvedGbp(store);
  const g = google({ postStatus: 400 });
  await run(store, g, BOTH_ON, clock);
  await run(store, g, BOTH_ON, clock);
  const c = await store.get(id);
  assert.strictEqual(c.status, 'draft');
  assert.strictEqual(c.exec.tries, 1);
  assert.match(c.exec.error, /^Google refused the post: 400 INVALID_ARGUMENT$/);
  assert.strictEqual(posts(g).length, 1);
});

test('a new Approve after a failure starts the count again: one more try', async () => {
  const { store, clock } = setup();
  const id = await approvedGbp(store);
  await run(store, google({ postStatus: 400 }), BOTH_ON, clock);
  assert.strictEqual((await store.get(id)).status, 'draft');
  clock.set('2026-11-25T19:00:00Z');
  await store.decide(id, { action: 'approve', who: KATHERINE });
  const g = google();
  assert.deepStrictEqual(await run(store, g, BOTH_ON, clock), { seen: 1, done: 1 });
  const c = await store.get(id);
  assert.strictEqual(c.handoff.at_ct, '11.25.2026 13:00 CT');
  assert.strictEqual(EX.cardLine(c).state, 'done');
});

test('switch off: failures behave exactly as before (no exec record, no return to Review)', async () => {
  const { store, clock } = setup();
  const id = await approvedGbp(store);
  const g = google({ postStatus: 503 });
  await run(store, g, GBP_ON, clock);
  await run(store, g, GBP_ON, clock);
  await run(store, g, GBP_ON, clock);
  const c = await store.get(id);
  assert.strictEqual(c.status, 'ready');
  assert.ok(!c.exec);
  assert.strictEqual(posts(g).length, 3, 'the old rule: retried every run');
});

test('a wait (setup missing, platform never asked) is waiting, not a failed try', async () => {
  const { store } = setup();
  const id = await approvedGbp(store);
  const card = await store.get(id);
  const out = await EX.afterFailure({ store, card, kind: 'pin', r: { retry: true, wait: true, why: 'connect The Bell Tower first' }, at: '2026-11-25T17:42:00Z', env: { EXECUTIONER: 'on' } });
  assert.strictEqual(out, 'waiting');
  const c = await store.get(id);
  assert.strictEqual(c.status, 'ready');
  assert.strictEqual(c.exec.tries, 0);
  assert.deepStrictEqual(EX.cardLine(c), { state: 'waiting', line: 'Waiting: connect The Bell Tower first' });
});

test('the setup gaps are marked wait at the source: WordPress with no Keychain login, Google with no key', async () => {
  const wp = await createDraft({ post: { site: 'infinityhospitalitygroup.com', title: 't', content_md: 'b' }, login: () => null, fetchImpl: async () => { throw new Error('never called'); } });
  assert.strictEqual(wp.wait, true);
  const g = await GP.createPost({ post: GP.parseGbpPost(POST), env: GBP_ON, saKey: null, fetchImpl: async () => { throw new Error('never called'); } });
  assert.strictEqual(g.wait, true);
});

test('KNOWN-BAD: a WordPress ALARM that already made a draft is recorded, never sent back to Review', async () => {
  const { store, clock } = setup();
  const c = await store.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'x', title: 'Blog', body: 'x',
    payload: { post: { site: 'infinityhospitalitygroup.com', title: 'Rehearsal dinners', content_md: 'Body text.' } } });
  await store.decide(c.id, { action: 'approve', who: KATHERINE });
  const wpFetch = async (u, o = {}) => (o.method === 'POST'
    ? { status: 201, text: async () => JSON.stringify({ id: 7 }) }
    : { status: 200, text: async () => JSON.stringify({ id: 7, status: 'publish' }) });
  // handoff's WordPress path takes its login from the caller.
  await handoff({ store, fetchImpl: wpFetch, login: () => ({ user: 'u', pass: 'p' }), env: { EXECUTIONER: 'on' }, log: () => {}, now: clock.now });
  const after = await store.get(c.id);
  assert.strictEqual(after.status, 'ready');
  assert.strictEqual(after.handoff.alarm, true);
  assert.strictEqual(after.handoff.wp_id, 7);
});

test('the Executioner\'s card: done today, failed today, waiting; sales cards are not its kind', async () => {
  const { store, clock } = setup();
  const done = await approvedGbp(store);
  await run(store, google(), BOTH_ON, clock);
  const failed = await approvedGbp(store);
  await run(store, google({ postStatus: 400 }), BOTH_ON, clock);
  const waiting = await approvedGbp(store);
  const sales = await store.insert({ agent: 'convention-connector', agent_name: 'Convention Charles', job: 'x', title: 'Sales', body: 'x', payload: { sales: { to: 'x' } }, status: 'ready' });
  const s = EX.summary(await store.execRows(), { now: clock.now(), env: { EXECUTIONER: 'on' } });
  assert.strictEqual(s.done, 1);
  assert.strictEqual(s.failed, 1);
  assert.strictEqual(s.waiting, 1);
  assert.deepStrictEqual(s.lists.done.map((x) => x.id), [done]);
  assert.deepStrictEqual(s.lists.failed.map((x) => x.id), [failed]);
  assert.deepStrictEqual(s.lists.waiting.map((x) => x.id), [waiting]);
  assert.ok(![...s.lists.done, ...s.lists.failed, ...s.lists.waiting].some((x) => x.id === sales.id));
  assert.strictEqual(s.on, true);
  assert.match(s.job, /never sends email/);
  assert.doesNotMatch(JSON.stringify(s), /#\d{3,}|ORDER/, 'no order numbers in what Katherine sees');
});

test('KNOWN-BAD: the Executioner has no email path; the page, route and Review line are wired', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'executioner.js'), 'utf8');
  assert.doesNotMatch(src, /require\([^)]*(mail|gmail|smtp|sendgrid|outreach|hubspot)/i);
  const agents = fs.readFileSync(path.join(__dirname, '..', 'routes', 'agents.js'), 'utf8');
  assert.match(agents, /r\.get\('\/api\/executioner'/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
  assert.match(page, /executionerHtml\(\)/);
  assert.match(page, /api\('\/api\/executioner'\)/);
  const review = fs.readFileSync(path.join(__dirname, '..', 'routes', 'review.js'), 'utf8');
  assert.match(review, /executioner'\)\.cardLine/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8'), /executedHtml\(c\)/);
});
