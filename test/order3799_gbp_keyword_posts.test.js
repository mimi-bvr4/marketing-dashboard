'use strict';
// ORDER #3799 (Mimi 11.24.2026): the Google Business agent writes short posts
// built on our target keywords, Approve POSTS the post to that venue's Google
// Business Profile, the card shows the live post link, and no review work.
//
// KNOWN-BAD cases pinned here:
//   - anything posted while GBP_POST_ON_APPROVE is off (it ships OFF);
//   - a post Google never saw approved (a draft is never handed off);
//   - a post going out twice, or to a guessed profile (zero or two matches);
//   - a post over 80 words, or for the closed Harding House;
//   - any Google call other than GETs and ONE POST to .../localPosts;
//   - a review reaching the agent.
// Fake Google, fake model, memory store. Nothing leaves the process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GP = require('../lib/gbp-post');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');
const { handoff } = require('../jobs/agent_handoff');
const { approveWill } = require('../lib/approve-will');
const { actionLine, agrees } = require('../lib/card-action');

const ACCT = 'accounts/1';
const LIVE = 'https://local.google.com/place?id=1&use=posts&lpsid=abc';
const POST = { venue: 'The Bell Tower', keyword: 'downtown nashville wedding venues', keyword_source: 'Search Console GAPS',
  summary: 'Looking for downtown Nashville wedding venues? The Bell Tower sits in the heart of downtown. Book a tour this week.',
  link: 'https://thebelltower.com/weddings/' };
const ON = { GBP_POST_ON_APPROVE: 'on' };
const auth = { saKey: { client_email: 'x' }, saToken: async () => 't' };

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
function google({ postStatus = 200, locations = [{ name: 'locations/11', title: 'The Bell Tower' }, { name: 'locations/22', title: 'Saddle Woods Farm' }] } = {}) {
  const calls = [];
  const f = async (u, o = {}) => {
    const url = String(u);
    calls.push({ url, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : null });
    if (url.startsWith('https://mybusinessaccountmanagement')) return json(200, { accounts: [{ name: ACCT }] });
    if (url.includes('/locations?readMask')) return json(200, { locations });
    if (url.includes('/reviews?')) return json(200, { totalReviewCount: 1, reviews: [
      { reviewId: 'R-1', starRating: 'TWO', comment: 'Parking was a mess.', createTime: '2026-11-20T18:00:00Z', reviewer: { displayName: 'Ben R.' } }] });
    if (url.includes('/localPosts?')) return json(200, { localPosts: [{ createTime: '2026-09-29T12:00:00Z' }] });
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

test('the switch ships OFF: only "on" turns it on', () => {
  for (const v of [undefined, '', 'off', 'true', 'yes', '1']) assert.strictEqual(GP.postOn({ GBP_POST_ON_APPROVE: v }), false, String(v));
  assert.strictEqual(GP.postOn({ GBP_POST_ON_APPROVE: ' On ' }), true);
});

test('KNOWN-BAD: switch off, createPost makes no call at all', async () => {
  const f = google();
  const r = await GP.createPost({ post: POST, env: {}, fetchImpl: f, ...auth });
  assert.strictEqual(r.off, true);
  assert.strictEqual(f.calls.length, 0);
});

test('switch on: GETs to find the profile, then ONE POST of exactly the approved words; the live link comes back', async () => {
  const f = google();
  const r = await GP.createPost({ post: POST, env: ON, fetchImpl: f, ...auth });
  assert.deepStrictEqual(r, { ok: true, post_url: LIVE, post_name: `${ACCT}/locations/11/localPosts/99`, state: 'LIVE', venue: 'The Bell Tower', location: 'locations/11' });
  const p = posts(f);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].method, 'POST');
  assert.strictEqual(p[0].url, `https://mybusiness.googleapis.com/v4/${ACCT}/locations/11/localPosts`);
  assert.deepStrictEqual(p[0].body, { languageCode: 'en-US', topicType: 'STANDARD', summary: POST.summary,
    callToAction: { actionType: 'LEARN_MORE', url: POST.link } });
  assert.ok(!f.calls.some((c) => /reviews|reply/.test(c.url)), 'posting never touches reviews');
});

test('KNOWN-BAD: a profile is never guessed; zero or two matches is a refusal', async () => {
  const none = await GP.createPost({ post: { ...POST, venue: 'DailyDish' }, env: ON, fetchImpl: google(), ...auth });
  assert.ok(none.skip); assert.match(none.why, /no Google profile is named "DailyDish"/);
  const two = google({ locations: [{ name: 'locations/1', title: 'The Bell Tower' }, { name: 'locations/2', title: 'Bell Tower' }] });
  const r2 = await GP.createPost({ post: POST, env: ON, fetchImpl: two, ...auth });
  assert.ok(r2.skip); assert.match(r2.why, /2 Google profiles/);
  assert.strictEqual(posts(two).length, 0);
  assert.ok(GP.pickLocation('Bell Tower', [{ title: 'The Bell Tower' }]).ok, '"The" is not the difference');
});

test('KNOWN-BAD: too long or Harding House is refused before any call', async () => {
  const long = { ...POST, summary: Array(81).fill('word').join(' ') };
  assert.match(GP.refuse(long), /81 words; the limit is 80/);
  assert.match(GP.refuse({ ...POST, venue: 'The Harding House' }), /closed/);
  const f = google();
  const r = await GP.createPost({ post: long, env: ON, fetchImpl: f, ...auth });
  assert.ok(r.skip);
  assert.strictEqual(f.calls.length, 0);
});

test('Google says 400: recorded, never retried; 503: retried next run', async () => {
  const bad = await GP.createPost({ post: POST, env: ON, fetchImpl: google({ postStatus: 400 }), ...auth });
  assert.ok(bad.skip); assert.match(bad.why, /400 INVALID_ARGUMENT/);
  const down = await GP.createPost({ post: POST, env: ON, fetchImpl: google({ postStatus: 503 }), ...auth });
  assert.ok(!down.ok && !down.skip); assert.match(down.why, /503/);
});

test('parse: venue and text required; a link must be https', () => {
  assert.strictEqual(GP.parseGbpPost({ summary: 'x' }), null);
  assert.strictEqual(GP.parseGbpPost({ venue: 'x' }), null);
  assert.strictEqual(GP.parseGbpPost({ ...POST, link: 'http://thebelltower.com/' }).link, undefined);
  assert.strictEqual(GP.parseGbpPost(POST).cta, 'LEARN_MORE');
});

test('the posting code: one POST, to localPosts only; no PUT, PATCH or DELETE; the read client stays GET-only', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gbp-post.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.strictEqual((code.match(/method: 'POST'/g) || []).length, 1);
  assert.doesNotMatch(code, /PUT|PATCH|DELETE|reply|updateMask/);
  assert.match(code, /\/localPosts`/);
  const read = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gbp-reviews.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(read, /POST|PUT|PATCH|DELETE/);
});

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3799-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('07_Marketing_and_Brand/SEO_Data/GSC_Content_Gaps_2026-11-25.md', '| downtown nashville wedding venues | thebelltower.com | 965 |');
  put('07_Marketing_and_Brand/Blog_Agent/KEYWORD_MAP.md', '- The Bell Tower: downtown wedding venue');
  return { IHG_TREE: root };
}
const card = () => ({ title: 'Google post: The Bell Tower, downtown nashville wedding venues', target: 'The Bell Tower',
  body: `GAPS list, 965 impressions.\n\n${POST.summary}`, gbp_post: POST,
  seen: { venue: 'The Bell Tower', reviewer: 'profile post: downtown nashville wedding venues', platform: 'Google post' } });

test('end to end: keywords reach the agent, no review does; the card leads "Post this to ..."; Approve, then ONE post and the live link', async (t) => {
  const store = createMemoryStore({ lint });
  const calls = [];
  const llm = { model: 'fake', async complete(req) { calls.push(req); return JSON.stringify({ cards: [card()] }); } };
  const g = google();
  const r = await runAgent({ def: { ...loadAgent('gbp'), copy_prepass: false }, store, llm, env: tree(t), fetchImpl: g, now: () => new Date('2026-11-25T12:00:00Z'), scheduled: true, ...auth });
  assert.ok(r.ok, r.error);
  const { system, user } = calls[0];
  assert.match(user, /downtown nashville wedding venues \| thebelltower\.com \| 965/, 'the GAPS list reaches the agent');
  assert.match(user, /The Bell Tower: downtown wedding venue/, 'the keyword map reaches the agent');
  assert.doesNotMatch(user, /Parking was a mess|R-1/, 'no review reaches the agent');
  assert.match(system, /"gbp_post"/);
  assert.match(system, /No review work/);

  const c = r.cards[0];
  assert.deepStrictEqual(c.payload, { gbp_post: GP.parseGbpPost(POST) });
  assert.strictEqual(actionLine(c).line, 'Post this to The Bell Tower Google Business Profile.');
  assert.strictEqual(approveWill(c).kind, 'gbp_post');
  assert.ok(agrees(c));
  assert.match(approveWill(c).line, /switched off \(GBP_POST_ON_APPROVE\)/, 'off: the card says it waits');

  // A draft is never posted.
  const g2 = google();
  assert.deepStrictEqual(await handoff({ store, fetchImpl: g2, env: ON, gbpAuth: auth, log: () => {} }), { seen: 0, done: 0 });
  await store.decide(c.id, { action: 'edit', who: 'khowe@infinityhospitality.net', body: 'Downtown Nashville wedding venues do not get closer to Broadway. Tour The Bell Tower this week.' });
  assert.strictEqual((await store.get(c.id)).payload.gbp_post.summary, 'Downtown Nashville wedding venues do not get closer to Broadway. Tour The Bell Tower this week.');
  await store.decide(c.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });

  // Switch off: left exactly as it is, nothing sent.
  const off = google();
  const logs = [];
  assert.deepStrictEqual(await handoff({ store, fetchImpl: off, env: {}, gbpAuth: auth, log: (l) => logs.push(l) }), { seen: 1, done: 0 });
  assert.strictEqual(off.calls.length, 0);
  assert.strictEqual((await store.get(c.id)).handoff, null);
  assert.ok(logs.some((l) => /GBP_POST_ON_APPROVE/.test(l)));

  // Switch on: posted once, the edited words, the live link recorded.
  assert.deepStrictEqual(await handoff({ store, fetchImpl: g2, env: ON, gbpAuth: auth, log: () => {} }), { seen: 1, done: 1 });
  assert.strictEqual(posts(g2).length, 1);
  assert.strictEqual(posts(g2)[0].body.summary, 'Downtown Nashville wedding venues do not get closer to Broadway. Tour The Bell Tower this week.');
  const h = (await store.get(c.id)).handoff;
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.post_url, LIVE);
  assert.deepStrictEqual(await handoff({ store, fetchImpl: g2, env: ON, gbpAuth: auth, log: () => {} }), { seen: 0, done: 0 }, 'never twice');
  assert.strictEqual(posts(g2).length, 1);
});

test('Approve is refused on a post over 80 words, and says to cut it', async () => {
  const store = createMemoryStore({ lint });
  const c = await store.insert({ agent: 'gbp', agent_name: 'Google Business', job: 'x', title: 'Google post: The Bell Tower, x', body: 'x',
    payload: { gbp_post: { ...POST, summary: Array(90).fill('word').join(' ') } } });
  const r = await store.decide(c.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
  assert.match(r.error, /the Google post: the post is 90 words; the limit is 80/);
});
