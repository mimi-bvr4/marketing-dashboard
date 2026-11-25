'use strict';
// ORDER #3581: the Concierge's Google reviews reach planning WHOLE.
//
// Known-bad first:
//   - the feed built from reviewRow() (cut at 600 with " [cut]", line breaks
//     folded) or from a card, instead of Google's own answer
//   - anything sent while REVIEW_FEED_TO_PLANNING is off, or on a dry run
//   - any call to Google that is not a GET (the Concierge's law)
//   - the feed POSTing anywhere but the configured planning intake, or over
//     plain http to a remote host
//   - a feed failure breaking the morning read of reviews
//   - the token in any return value
// A fake Google and a fake planning. Nothing leaves the process.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { gather } = require('../lib/agent-sources');
const G = require('../lib/gbp-reviews');
const RF = require('../lib/review-feed');

const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'gbp', 'agent.json'), 'utf8'));
const SRC = def.sources.find((s) => s.type === 'gbp_reviews');
const NOW = new Date('2026-11-05T15:00:00Z');
const ACCT = 'accounts/1';
const TOKEN = 'feed-token-for-tests-only-0123456789';
const URL = 'https://planning.example.test/api/reviews-arrive/intake';
const LONG = 'We loved it.\n\nThe   staff | were great. ' + 'x'.repeat(900) + '\nEnd.';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
function fakeWorld({ planningStatus = 200 } = {}) {
  const google = []; const planning = [];
  const fetchImpl = async (u, o = {}) => {
    const url = String(u);
    if (url.startsWith('https://planning.example.test')) {
      planning.push({ url, method: o.method, headers: o.headers, body: JSON.parse(o.body) });
      if (planningStatus !== 200) return json(planningStatus, { error: 'nope' });
      const b = JSON.parse(o.body);
      return json(200, { ok: true, results: b.reviews.map((r) => ({ source_review_id: r.source_review_id, result: /\[cut\]$/.test(r.text) ? 'refused' : 'new' })) });
    }
    google.push({ url, method: o.method || 'GET' });
    if (url.startsWith('https://mybusinessaccountmanagement')) return json(200, { accounts: [{ name: ACCT }] });
    if (url.includes('/locations?readMask')) return json(200, { locations: [
      { name: 'locations/11', title: 'The Bell Tower' }, { name: 'locations/22', title: 'The Harding House' }] });
    if (url.includes('/reviews?')) return json(200, { totalReviewCount: 3, reviews: [
      { reviewId: 'R-long', starRating: 'FIVE', comment: LONG, createTime: '2026-11-01T04:30:00Z', reviewer: { displayName: '  Ana  P. ' } },
      { reviewId: 'R-stars', starRating: 'FOUR', createTime: '2026-10-20T18:00:00Z', reviewer: { displayName: 'Ben R.' } },
      { reviewId: 'R-done', starRating: 'FIVE', comment: 'Lovely.', createTime: '2026-03-19T18:00:00Z', reviewer: { displayName: 'Cy D.' }, reviewReply: { comment: 'Thanks!' } }] });
    if (url.includes('/localPosts?')) return json(200, { localPosts: [] });
    return json(404, {});
  };
  return { google, planning, fetchImpl };
}
const ON = { REVIEW_FEED_TO_PLANNING: 'on', PLANNING_REVIEW_FEED_URL: URL, REVIEW_FEED_WRITE_TOKEN: TOKEN };
const ctx = (w, env, extra = {}) => ({ env, fetch: w.fetchImpl, saKey: { client_email: 'x' }, saToken: async () => 't', now: () => NOW, ...extra });

test('switch: REVIEW_FEED_TO_PLANNING is off unless it says on', () => {
  for (const v of [undefined, '', 'off', 'demo', 'true', 'yes']) assert.strictEqual(RF.feedOn({ REVIEW_FEED_TO_PLANNING: v }), false, String(v));
  assert.strictEqual(RF.feedOn({ REVIEW_FEED_TO_PLANNING: ' On ' }), true);
});

test('wholeReview takes Google\'s answer itself: the comment exactly, never reviewRow\'s cut copy', () => {
  const raw = { reviewId: 'R-long', starRating: 'FIVE', comment: LONG, createTime: '2026-11-01T04:30:00Z', reviewer: { displayName: '  Ana  P. ' } };
  const w = RF.wholeReview(raw, 'The Bell Tower');
  assert.deepStrictEqual(w, { source: 'google', source_review_id: 'R-long', venue_name: 'The Bell Tower', posted_on: '2026-10-31',
    reviewer_name: '  Ana  P. ', rating: 5, text: LONG });
  assert.notStrictEqual(w.text, G.reviewRow(raw).text, 'the agent\'s prompt copy is not the stored copy');
  assert.match(G.reviewRow(raw).text, /\[cut\]$/);
  assert.ok(!/\[cut\]/.test(w.text));
  // a rating with no words is sent as an empty text, not a stand-in
  assert.strictEqual(RF.wholeReview({ reviewId: 'R2', starRating: 'TWO', createTime: '2026-10-20T18:00:00Z' }, 'X').text, '');
  assert.strictEqual(RF.wholeReview({ reviewId: 'R2', starRating: 'TWO', createTime: '2026-10-20T18:00:00Z' }, 'X').reviewer_name, '');
});

test('the posted date is the Nashville day, not the UTC day', () => {
  assert.strictEqual(RF.wholeReview({ reviewId: 'a', createTime: '2026-11-01T04:30:00Z' }, 'X').posted_on, '2026-10-31');
  assert.strictEqual(RF.wholeReview({ reviewId: 'a', createTime: '2026-11-01T18:00:00Z' }, 'X').posted_on, '2026-11-01');
});

test('switch OFF: the Concierge reads as before and nothing is sent to planning', async () => {
  const w = fakeWorld();
  const { got, unavailable } = await gather([SRC], ctx(w, { PLANNING_REVIEW_FEED_URL: URL, REVIEW_FEED_WRITE_TOKEN: TOKEN }));
  assert.deepStrictEqual(unavailable, []);
  // #3799: the agent's read is posts only (no review reaches it); the feed below still gets every review.
  assert.match(got[0].text, /\| The Bell Tower \| 0 \| none \|/);
  assert.ok(!got[0].text.includes('R-long'));
  assert.strictEqual(w.planning.length, 0);
});

test('switch ON: every review read, from every profile, reaches planning whole, with the token, as one POST per batch', async () => {
  const w = fakeWorld();
  const { got } = await gather([SRC], ctx(w, ON));
  assert.strictEqual(w.planning.length, 1);
  const p = w.planning[0];
  assert.strictEqual(p.url, URL);
  assert.strictEqual(p.method, 'POST');
  assert.strictEqual(p.headers.Authorization, `Bearer ${TOKEN}`);
  const sent = p.body.reviews;
  assert.strictEqual(sent.length, 6, 'all three reviews on both profiles, answered and closed-venue included');
  const long = sent.find((r) => r.source_review_id === 'R-long' && r.venue_name === 'The Bell Tower');
  assert.strictEqual(long.text, LONG);
  assert.ok(sent.some((r) => r.venue_name === 'The Harding House'));
  assert.match(got[0].text, /\| The Bell Tower \| 0 \| none \|/, 'the morning read still succeeds (posts only since #3799)');
  assert.ok(!JSON.stringify(got).includes(TOKEN), 'the token is in no return value');
});

test('READ ONLY to Google stays true with the feed on: every Google call is a GET', async () => {
  const w = fakeWorld();
  await gather([SRC], ctx(w, ON));
  assert.ok(w.google.length >= 5);
  assert.ok(w.google.every((c) => c.method === 'GET'));
  const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gbp-reviews.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /POST|PUT|PATCH|DELETE/);
});

test('a dry run sends nothing', async () => {
  const w = fakeWorld();
  await gather([SRC], ctx(w, ON, { dryRun: true }));
  assert.strictEqual(w.planning.length, 0);
});

test('planning down: the morning read still succeeds and the feed says why', async () => {
  const w = fakeWorld({ planningStatus: 503 });
  const { got, unavailable } = await gather([SRC], ctx(w, ON));
  assert.deepStrictEqual(unavailable, []);
  assert.match(got[0].text, /\| The Bell Tower \| 0 \| none \|/);
  const r = await RF.sendFeed({ profiles: [{ title: 'The Bell Tower', reviews: [{ reviewId: 'z', createTime: '2026-11-01T18:00:00Z', comment: 'ok' }] }], env: ON, fetchImpl: w.fetchImpl });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /503/);
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test('the feed posts only to an https planning intake (or localhost), never to Google, and needs both URL and token', async () => {
  const w = fakeWorld();
  const profiles = [{ title: 'T', reviews: [{ reviewId: 'z', createTime: '2026-11-01T18:00:00Z', comment: 'ok' }] }];
  for (const bad of ['http://planning.example.test/api/reviews-arrive/intake', 'https://mybusiness.googleapis.com/v4/x', 'https://planning.example.test/api/other', 'not a url']) {
    const r = await RF.sendFeed({ profiles, env: { ...ON, PLANNING_REVIEW_FEED_URL: bad }, fetchImpl: w.fetchImpl });
    assert.strictEqual(r.ok, false, bad);
  }
  assert.strictEqual((await RF.sendFeed({ profiles, env: { ...ON, REVIEW_FEED_WRITE_TOKEN: '' }, fetchImpl: w.fetchImpl })).ok, false);
  assert.strictEqual((await RF.sendFeed({ profiles, env: { ...ON, PLANNING_REVIEW_FEED_URL: '' }, fetchImpl: w.fetchImpl })).ok, false);
  assert.strictEqual(w.planning.length, 0);
  assert.ok(RF.intakeUrlOk('http://127.0.0.1:4321/api/reviews-arrive/intake'));
});

test('batches stay under planning\'s cap of 100 per call', async () => {
  const w = fakeWorld();
  const reviews = Array.from({ length: 230 }, (_, i) => ({ reviewId: 'b' + i, createTime: '2026-11-01T18:00:00Z', comment: 'c' }));
  const r = await RF.sendFeed({ profiles: [{ title: 'T', reviews }], env: ON, fetchImpl: w.fetchImpl });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(w.planning.map((p) => p.body.reviews.length), [100, 100, 30]);
});

test('planning\'s refusals come back named, by review id', async () => {
  const w = fakeWorld();
  const r = await RF.sendFeed({ profiles: [{ title: 'T', reviews: [{ reviewId: 'cut1', createTime: '2026-11-01T18:00:00Z', comment: 'shortened [cut]' }] }], env: ON, fetchImpl: w.fetchImpl });
  assert.deepStrictEqual(r.refused.map((x) => x.source_review_id), ['cut1']);
});
