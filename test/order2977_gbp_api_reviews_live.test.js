'use strict';
// ORDER #2977: Mimi enabled mybusiness.googleapis.com (11.05.2026); the Box's
// re-probe answered 200 for reviews and localPosts on all 11 profiles. The
// Concierge now reads Google reviews and posts from the API, GET only, keyed on
// the Google review id, and replies stay drafts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { gather, REGISTRY, sourceLabel } = require('../lib/agent-sources');
const G = require('../lib/gbp-reviews');
const sa = require('../lib/google-sa');
const seen = require('../lib/agent-seen');

const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'gbp', 'agent.json'), 'utf8'));
const NOW = new Date('2026-11-05T15:00:00Z');
const ACCT = 'accounts/112975439885381988774';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
function fakeGoogle({ reviewsStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (u, o = {}) => {
    calls.push({ url: String(u), method: o.method || 'GET' });
    const url = String(u);
    if (url.startsWith('https://mybusinessaccountmanagement')) return json(200, { accounts: [{ name: ACCT }] });
    if (url.includes('/locations?readMask')) return json(200, { locations: [
      { name: 'locations/3415509155357475067', title: 'The Bell Tower' },
      { name: 'locations/3072250143907619899', title: 'The Harding House' }] });
    if (url.includes('/reviews?')) {
      if (reviewsStatus !== 200) return json(reviewsStatus, { error: { status: 'PERMISSION_DENIED', message: 'SERVICE_DISABLED' } });
      return json(200, { totalReviewCount: 176, reviews: [
        { reviewId: 'AbC-new1', starRating: 'FIVE', comment: 'The rooftop was | perfect for our wedding.', createTime: '2026-10-31T18:00:00Z', reviewer: { displayName: 'Ana P.' } },
        { reviewId: 'AbC-low2', starRating: 'TWO', comment: 'Parking was a mess.', createTime: '2026-10-20T18:00:00Z', reviewer: { displayName: 'Ben R.' } },
        { reviewId: 'AbC-done3', starRating: 'FIVE', comment: 'Lovely.', createTime: '2026-10-19T18:00:00Z', reviewer: { displayName: 'Cy D.' }, reviewReply: { comment: 'Thanks!' } },
        { reviewId: 'AbC-old4', starRating: 'FOUR', comment: 'Good.', createTime: '2026-05-01T18:00:00Z', reviewer: { displayName: 'Di E.' } }] });
    }
    if (url.includes('/localPosts?')) return json(200, { localPosts: [{ createTime: '2026-09-29T12:00:00Z' }] });
    return json(404, {});
  };
  return { calls, fetchImpl };
}
const ctx = (g) => ({ env: {}, fetch: g.fetchImpl, saKey: { client_email: 'x' }, saToken: async (scope, sub) => { g.token = [scope, sub]; return 't'; }, now: () => NOW });

test('the Concierge reads the live Google source; the pending line is gone, and the review pulse is never required', () => {
  const src = def.sources.find((s) => s.type === 'gbp_reviews');
  assert.ok(src && src.required && REGISTRY.gbp_reviews);
  assert.ok(!def.sources.some((s) => s.type === 'pending'));
  // #3094 (Mimi 11.06.2026): the pulse is back as an OPTIONAL second source; it may never be required.
  assert.ok(!def.sources.some((s) => s.newest === '07_Marketing_and_Brand/Venue_Review_Pulse_' && s.required));
  assert.deepStrictEqual(def.character.needs, []);
  assert.deepStrictEqual(def.seen_before.key, ['venue', 'reviewer', 'platform', 'review_id?'], 'the #1758 ruled key is unchanged');
  assert.ok(src.skip.includes('The Harding House'));
});

test('unanswered recent reviews come with their Google review id; answered, old and closed-venue ones do not', async () => {
  const g = fakeGoogle();
  const src = def.sources.find((s) => s.type === 'gbp_reviews');
  const { got, unavailable } = await gather([src], ctx(g));
  assert.deepStrictEqual(unavailable, []);
  const t = got[0].text;
  assert.strictEqual(got[0].label, sourceLabel(src));
  assert.match(t, /review_id: AbC-new1 \| 2026-10-31 \| 5 stars \| Ana P\.: "The rooftop was \/ perfect/);
  assert.match(t, /review_id: AbC-low2 \| 2026-10-20 \| 2 stars/);
  assert.doesNotMatch(t, /AbC-done3/, 'a review with a reply is not offered');
  assert.doesNotMatch(t, /AbC-old4/, 'older than the 60-day window');
  assert.match(t, /\| The Harding House \(closed: no drafts\) \| 176 \|/);
  assert.strictEqual((t.match(/review_id: AbC-new1/g) || []).length, 1, 'Harding House offers no review');
  assert.match(t, /\| The Bell Tower \| 176 \| 3 of 4 \| 2026-10-31 \| 2026-10-31 \| 1 \| 2026-09-29 \|/);
  assert.deepStrictEqual(g.token, [G.SCOPE, 'brain@infinityhospitality.net']);
});

test('READ ONLY: every call to Google is a GET, and the client has no other verb', async () => {
  const g = fakeGoogle();
  await gather([def.sources.find((s) => s.type === 'gbp_reviews')], ctx(g));
  assert.ok(g.calls.length >= 6);
  assert.ok(g.calls.every((c) => c.method === 'GET'), JSON.stringify(g.calls.filter((c) => c.method !== 'GET')));
  assert.ok(!g.calls.some((c) => /reply|:batch|accept/i.test(c.url)));
  const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gbp-reviews.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /POST|PUT|PATCH|DELETE/);
  assert.ok(sa.ALLOWED_SCOPES.has(G.SCOPE));
});

test('a 403 from Google is named, never a silent empty read', async () => {
  const g = fakeGoogle({ reviewsStatus: 403 });
  const { got, unavailable } = await gather([def.sources.find((s) => s.type === 'gbp_reviews')], ctx(g));
  assert.deepStrictEqual(got, []);
  assert.match(unavailable[0].why, /no profile answered \(The Bell Tower: 403 PERMISSION_DENIED/);
});

test('no service-account key: the source says so', async () => {
  const r = await REGISTRY.gbp_reviews({}, { env: {}, saKey: null, fetch: async () => { throw new Error('no call'); } });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /no Brain service-account key/);
});

test('seen-before memory carries the Google review id, so two reviews by one person stay two items', () => {
  const a = { venue: 'The Bell Tower', reviewer: 'Ana P.', platform: 'Google' };
  assert.strictEqual(seen.seenKey(def.seen_before, { ...a, review_id: 'AbC-new1' }), 'venue=the bell tower|reviewer=ana p|platform=google|review_id=abc new1');
  assert.notStrictEqual(seen.seenKey(def.seen_before, { ...a, review_id: 'AbC-new1' }), seen.seenKey(def.seen_before, { ...a, review_id: 'XyZ-9' }));
  assert.strictEqual(seen.seenKey(def.seen_before, { venue: 'The Bell Tower' }), null, 'a post idea has no reviewer and is saved as before');
});
