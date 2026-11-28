// ORDER #3924 (follow-on to #3798 and #3814): a PR Patty daily run with nothing
// to pitch files NO Review card. Its summary line goes on Patty's own run line
// (the team page) and into the Monday digest's folded entries. A run with fits
// still files one action card per fit plus the summary, as #3798 says.
// Report cards (the ones the Review page answers with "Got it") and Patty's
// summary never count toward the Producer's draft hold.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const R = require('../lib/agent-runner');
const F = require('../lib/report-fold');
const P = require('../lib/producer');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const at = new Date(Date.UTC(2026, 10, 27, 22, 45)); // 11.27.2026 4:45 PM CT
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const fetchImpl = async (u) => {
  if (u.includes('/messages?')) return json(200, { messages: [{ id: 'm1' }] });
  if (u.includes('/messages/m1')) return json(200, { payload: { headers: [{ name: 'Subject', value: 'HARO Queries - Evening Edition' }, { name: 'From', value: 'HARO <haro@helpareporter.com>' }],
    mimeType: 'text/plain', body: { data: b64('1) Summary: Crypto tax tips\nQuery: Forbes wants CPAs. Deadline 11.28.2026. Reply: https://app.haro.com/r/9') } } });
  return json(404, {});
};
const llmOf = (cards) => ({ model: 'test', complete: async () => JSON.stringify({ cards }) });
const ZERO = { title: 'Press requests, 11.27.2026: 0 to pitch, 1 skipped', body: 'Requests in this email: 1. Read in full: 1 of 1.\n\nSkipped:\n- Forbes, crypto tax tips: not our field.' };
const PITCH = { title: 'Pitch Brides: winter venues, due 11.29.2026', seen: { request_id_or_url: 'https://app.haro.com/r/1' },
  body: '### Who\nJane Roe, Brides. Respond: https://app.haro.com/r/1\n\n### More context\nWinter venues. Due 11.29.2026. We fit: Clementine Hall.\n\n### What you do\nSend the pitch below by 11.29.2026.\n\nDraft pitch: Clementine Hall seats 200 in winter.' };
const run = (store, cards, extra = {}) => R.runAgent({ slug: 'pr-patty', store, llm: llmOf(cards), env: { IHG_TREE: require('os').tmpdir() }, log: () => {}, fetchImpl,
  now: () => at, saKey: {}, saToken: async () => 'tok', scheduled: true, ...extra });

test('a daily run with 0 to pitch files no Review card; the summary goes on her run line and the digest', async () => {
  const store = createMemoryStore({ lint });
  const r = await run(store, [ZERO]);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.cards.length, 0, 'no Review card');
  assert.strictEqual((await store.list({ status: 'draft' })).length, 0);
  assert.strictEqual(r.folded.length, 1);
  assert.match(r.folded[0].title, /^Press requests, 11\.27\.2026: 0 to pitch, 1 skipped$/);
  const [row] = await store.runHistory();
  assert.strictEqual(row.status, 'done');
  assert.strictEqual(row.cards, 0);
  assert.match(row.note, /Press requests, 11\.27\.2026: 0 to pitch, 1 skipped \(nothing to pitch, no Review card, #3924\)/);
  assert.strictEqual(store.reportNotes.length, 1, 'the Monday digest lists it (#3814 folded entries)');
});

test('a run with a fit still files the pitch card and the summary card (#3798 unchanged)', async () => {
  const store = createMemoryStore({ lint });
  const r = await run(store, [PITCH, { ...ZERO, title: 'Press requests, 11.27.2026: 1 to pitch, 1 skipped' }]);
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(r.cards.map((c) => c.title.slice(0, 15)), ['Pitch Brides: w', 'Press requests,']);
  assert.strictEqual(r.folded.length, 0);
});

test('KNOWN-BAD: a summary that claims fits while no pitch card came back is still nothing to pitch', async () => {
  const store = createMemoryStore({ lint });
  const r = await run(store, [{ ...ZERO, title: 'Press requests, 11.27.2026: 2 to pitch, 0 skipped' }]);
  assert.strictEqual(r.cards.length, 0);
  assert.strictEqual(r.folded.length, 1);
});

test('a Run now Katherine asked for still answers with a card, even with 0 to pitch', async () => {
  const store = createMemoryStore({ lint });
  const r = await run(store, [ZERO], { ask: 'Check today\'s press emails', scheduled: false });
  assert.strictEqual(r.cards.length, 1);
  assert.strictEqual(r.folded.length, 0);
});

test('what counts toward the hold: action drafts only, never a report card or Patty\'s summary', () => {
  assert.strictEqual(F.countsTowardHold({ agent: 'pr-patty', title: PITCH.title }), true);
  assert.strictEqual(F.countsTowardHold({ agent: 'pr-patty', title: ZERO.title }), false);
  assert.strictEqual(F.countsTowardHold({ agent: 'pr-patty', title: 'Press requests, 11.25.2026' }), false, 'the pre-#3798 shape');
  assert.strictEqual(F.countsTowardHold({ agent: 'seo', title: 'Weekly SEO readout' }), false);
  assert.strictEqual(F.countsTowardHold({ agent: 'seo', title: 'x', payload: { post: { title: 't', content_md: 'b' } } }), true, 'a report agent card with a payload is an action');
  assert.strictEqual(F.countsTowardHold({ agent: 'digest', title: 'Weekly digest' }), false);
  assert.strictEqual(F.countsTowardHold({ agent: 'bloggy-bob', title: 'Press requests, a blog title' }), true, 'only Patty\'s summary is exempt by title');
});

test('the memory store\'s draftsWaiting leaves report cards and Patty\'s summary out, and the Producer reads it', async () => {
  const store = createMemoryStore({ lint });
  const base = { agent_name: 'x', job: 'x', sources: [], checks: {} };
  await store.insert({ ...base, agent: 'pr-patty', title: ZERO.title, body: 'b' });
  await store.insert({ ...base, agent: 'pr-patty', title: 'Press requests, 11.26.2026: 0 to pitch, 21 skipped', body: 'b' });
  await store.insert({ ...base, agent: 'seo', title: 'Weekly SEO readout', body: 'b' });
  await store.insert({ ...base, agent: 'digest', title: 'Weekly digest', body: 'b' });
  await store.insert({ ...base, agent: 'pr-patty', title: PITCH.title, body: PITCH.body });
  assert.strictEqual(await store.draftsWaiting(), 1);
  // The Producer's hold decision on that count: 1 waiting is far under the hold.
  assert.strictEqual(P.decide({ agent: 'gbp', waiting: await store.draftsWaiting(), used: 0, maxCards: 1, hold: 15 }).run, true);
});
