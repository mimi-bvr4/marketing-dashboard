'use strict';
// ORDER #3094 (ruled follow-on to #2977, Mimi 11.06.2026 19:21 CT: "add
// WeddingWire and The Knot back to the Concierge: yes, yes, weekly").
//
// Known-bad first: on main (7556095) the Concierge's sources have no review
// pulse, so WeddingWire and The Knot reviews never reach it. The pulse comes
// back as a SECOND, OPTIONAL source: Google (gbp_reviews) stays required and
// first, and a missing pulse never blocks or fails the run.
//
// Every run below uses the REAL agents/gbp/agent.json, a memory store, a fake
// model, and a fake web that answers only Google's GET endpoints, so nothing
// is published, sent or posted by any test.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');
const { sourceLabel } = require('../lib/agent-sources');
const seen = require('../lib/agent-seen');

const PULSE_STEM = '07_Marketing_and_Brand/Venue_Review_Pulse_';
const NOW = new Date('2026-11-07T15:00:00Z');

function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3094-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return { IHG_TREE: root };
}

function model(cards) {
  const calls = [];
  return { model: 'fake', calls, async complete(req) { calls.push(req); return JSON.stringify({ cards: cards() }); } };
}

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
// Google answers GETs; anything else on the web is refused and counted.
function web({ google = true } = {}) {
  const calls = [];
  const f = async (u, o = {}) => {
    const url = String(u);
    calls.push({ url, method: o.method || 'GET' });
    if (!google || !/googleapis\.com/.test(url)) throw new Error('no network in this test');
    if (url.startsWith('https://mybusinessaccountmanagement')) return json(200, { accounts: [{ name: 'accounts/1' }] });
    if (url.includes('/locations?readMask')) return json(200, { locations: [{ name: 'locations/3415509155357475067', title: 'The Bell Tower' }] });
    if (url.includes('/reviews?')) return json(200, { totalReviewCount: 1, reviews: [
      { reviewId: 'AbC-new1', starRating: 'FIVE', comment: 'The rooftop was perfect.', createTime: '2026-10-31T18:00:00Z', reviewer: { displayName: 'Ana P.' } }] });
    if (url.includes('/localPosts?')) return json(200, { localPosts: [] });
    return json(404, {});
  };
  f.calls = calls;
  return f;
}
const google = { saKey: { client_email: 'x' }, saToken: async () => 't' };

const CARDS = () => [{ title: 'Reply draft: The Bell Tower, Ana, Google', target: 'The Bell Tower',
  body: 'Review date: 10.31.2026 | Stars: 5 | Google review id: AbC-new1\nThank you, Ana. We loved hosting you on the rooftop.',
  seen: { venue: 'The Bell Tower', reviewer: 'Ana P.', platform: 'Google', review_id: 'AbC-new1', review_text: 'The rooftop was perfect.' } }];

const PULSE = { [`${PULSE_STEM}2026-11.md`]: '# Customer Pulse\n- Saddle Woods Farm, The Knot, Ben R., 11.02.2026: "Great team."\n- The Bell Tower, WeddingWire, Sam, 11.03.2026: "Lovely night."' };

test('KNOWN-BAD: the Concierge reads the review pulse again, as an optional second source after Google', () => {
  const def = loadAgent('gbp');
  const i = def.sources.findIndex((s) => s.type === 'gbp_reviews');
  const j = def.sources.findIndex((s) => s.type === 'file' && s.newest === PULSE_STEM);
  assert.ok(j >= 0, 'the Concierge has a review pulse source');
  assert.ok(i >= 0 && i < j, 'Google stays the first source');
  assert.strictEqual(def.sources[i].required, true, 'Google stays required');
  assert.ok(!def.sources[j].required, 'the pulse is optional: never required');
  assert.match(sourceLabel(def.sources[j]), /WeddingWire/);
  assert.match(sourceLabel(def.sources[j]), /The Knot/);
  assert.ok(!def.character.traits.some((tr) => /WeddingWire|The Knot/.test(tr.cant)), 'the Agents page no longer says it cannot read them');
});

test('KNOWN-BAD: WeddingWire and The Knot reviews reach the model when a pulse is on disk', async (t) => {
  const store = createMemoryStore({ lint });
  const llm = model(CARDS);
  const r = await runAgent({ def: loadAgent('gbp'), store, llm, env: tree(t, PULSE), fetchImpl: web(), now: () => NOW, scheduled: true, ...google });
  assert.ok(r.ok, r.error);
  assert.match(llm.calls[0].user, /Saddle Woods Farm, The Knot, Ben R\./);
  assert.match(llm.calls[0].user, /The Bell Tower, WeddingWire, Sam/);
  assert.match(llm.calls[0].user, /review_id: AbC-new1/, 'Google is read too');
});

test('a missing pulse never blocks or fails the run: Google cards are still drafted', async (t) => {
  const store = createMemoryStore({ lint });
  const def = loadAgent('gbp');
  const pulseLabel = sourceLabel(def.sources.find((s) => s.newest === PULSE_STEM));
  const r = await runAgent({ def, store, llm: model(CARDS), env: tree(t, {}), fetchImpl: web(), now: () => NOW, scheduled: true, blockedToBoard: true, ...google });
  assert.ok(r.ok, r.error);
  assert.ok(!r.blocked, 'not a board "waiting on" line');
  assert.strictEqual(r.cards.length, 1);
  assert.doesNotMatch(r.cards[0].title, /could not run/);
  assert.ok(r.unavailable.some((u) => u.label === pulseLabel), 'the missing pulse is named, not hidden');
});

test('Google is still the one the run depends on: no Google, no drafts, even with a pulse', async (t) => {
  const store = createMemoryStore({ lint });
  const r = await runAgent({ def: loadAgent('gbp'), store, llm: model(CARDS), env: tree(t, PULSE), fetchImpl: web({ google: false }), now: () => NOW, scheduled: true, ...google });
  assert.ok(r.ok, r.error);
  assert.match(r.cards[0].title, /could not run: a required source is missing/);
});

test('#1758 key unchanged: a pulse card and a Google card stay distinct; one Google review is one item', () => {
  const spec = loadAgent('gbp').seen_before;
  assert.deepStrictEqual(spec.key, ['venue', 'reviewer', 'platform', 'review_id?'], 'the #1758 ruled key is not touched');
  const knot = seen.seenKey(spec, { venue: 'Saddle Woods Farm', reviewer: 'Ben R.', platform: 'The Knot' });
  const ww = seen.seenKey(spec, { venue: 'Saddle Woods Farm', reviewer: 'Ben R.', platform: 'WeddingWire' });
  const g = seen.seenKey(spec, { venue: 'Saddle Woods Farm', reviewer: 'Ben R.', platform: 'Google', review_id: 'AbC-1' });
  assert.strictEqual(knot, 'venue=saddle woods farm|reviewer=ben r|platform=the knot');
  assert.strictEqual(new Set([knot, ww, g]).size, 3, 'one reviewer on three platforms is three items');
  assert.strictEqual(g, seen.seenKey(spec, { venue: 'saddle woods farm', reviewer: 'ben r', platform: 'GOOGLE', review_id: 'AbC-1' }), 'the same Google review twice is one item');
});

test('two runs over the same pulse draft a Knot reply only once', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, PULSE);
  const knot = () => [{ title: 'Reply draft: Saddle Woods Farm, Ben, The Knot', target: 'Saddle Woods Farm', body: 'Thank you, Ben. The team was glad to help.',
    seen: { venue: 'Saddle Woods Farm', reviewer: 'Ben R.', platform: 'The Knot', review_text: 'Great team.' } }];
  const r1 = await runAgent({ def: loadAgent('gbp'), store, llm: model(knot), env, fetchImpl: web(), now: () => NOW, scheduled: true, ...google });
  const r2 = await runAgent({ def: loadAgent('gbp'), store, llm: model(knot), env, fetchImpl: web(), now: () => NOW, scheduled: true, ...google });
  assert.strictEqual(r1.cards.length, 1);
  assert.strictEqual(r2.cards.length, 0);
  assert.strictEqual(r2.seen_skipped, 1);
});

test('the scope fence comment says what is true: read-only is enforced by the GET-only client, not by the scope', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'google-sa.js'), 'utf8');
  assert.doesNotMatch(src, /only the read-only scopes in ALLOWED_SCOPES/);
  assert.match(src, /business\.manage/);
  assert.match(src, /lib\/gbp-reviews\.js/);
  assert.match(src, /POST\/PUT\/PATCH\/DELETE/);
  const sa = require('../lib/google-sa');
  assert.deepStrictEqual([...sa.ALLOWED_SCOPES], [
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/business.manage',
  ], 'the scope list itself is unchanged');
});
