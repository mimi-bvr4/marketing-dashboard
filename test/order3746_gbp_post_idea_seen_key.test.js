'use strict';
// ORDER #3746: gbp failed "the model returned no cards" on 11.20, 11.21 and
// 11.22.2026. #3698's log line named 11.22: "the model's JSON held 0 card(s);
// stop end_turn; 23 item(s) listed as already drafted; answer starts:
// {"cards":[]}". The seen-before contract (lib/agent-seen.js) tells the model
// to put "seen": {venue, reviewer, platform, review_id?} on EVERY card, "One
// card per item", and SKILL.md gave the profile post idea no reviewer. With
// every review already drafted, the prompt gave the model no valid way to
// write the one post idea SKILL.md asks for every run, so it wrote none.
//
// Acceptance:
//   - RED on base: with an ALREADY DRAFTED list covering every review, gbp's
//     prompt still asks for the post idea, says to write it even when every
//     review is drafted, and gives the post idea card a seen shape it can
//     satisfy ("reviewer": "profile post", "platform": "Google post");
//   - rotation: a post idea waiting for one venue is listed as drafted, the
//     prompt says to take the next venue, a repeat for that venue is skipped by
//     the runner, and a post idea for another venue is kept (1 card, run done).
// The model is a fake; the web refuses every call. Nothing is sent or posted.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');
const { seenKey } = require('../lib/agent-seen');

const PULSE = { '07_Marketing_and_Brand/Venue_Review_Pulse_2026-11.md': '# Review pulse 11.2026\n'
  + '- The Bridge Building, Google, Ana P., 5 stars: "Lovely night."\n'
  + '- Saddle Woods Farm, Google, Ben R., 5 stars: "Great team."\n'
  + '- Cannery Hall, Google, Cara M., 5 stars: "The rooftop was perfect."\n' };

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3746-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(PULSE)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return { IHG_TREE: root };
}

// The REAL gbp agent (its SKILL.md and seen_before spec are under test), read
// from a pulse fixture instead of Google's API.
const gbpDef = () => ({ ...loadAgent('gbp'), copy_prepass: false,
  sources: [{ type: 'file', newest: '07_Marketing_and_Brand/Venue_Review_Pulse_', required: true, label: 'the newest review pulse' }] });

function model(answer) {
  const calls = [];
  return { model: 'fake', calls, async complete(req) { calls.push(req); return JSON.stringify({ cards: answer(calls.length) }); } };
}
function web() { return async () => { throw new Error('no network in this test'); }; }

const reply = (venue, reviewer, text) => ({ title: `Reply draft: ${venue}, ${reviewer.split(' ')[0]}, Google`, target: venue,
  body: `Review date: 11.01.2026 | Stars: 5 | Google review id: none\n"${text}"\nThank you for celebrating with us.`,
  seen: { venue, reviewer, platform: 'Google', review_text: text } });
const REPLIES = [reply('The Bridge Building', 'Ana P.', 'Lovely night.'), reply('Saddle Woods Farm', 'Ben R.', 'Great team.'),
  reply('Cannery Hall', 'Cara M.', 'The rooftop was perfect.')];
const post = (venue) => ({ title: `Post idea: ${venue}`, target: venue,
  body: 'Fall evenings on the terrace. Tour this week and see the lights. Photo: terrace at dusk.',
  seen: { venue, reviewer: 'profile post', platform: 'Google post' } });

// Every review drafted and waiting: the 11.22 morning.
async function everyReviewDrafted(t, store) {
  const r = await runAgent({ def: gbpDef(), store, llm: model(() => REPLIES), env: tree(t), fetchImpl: web(), scheduled: true });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.cards.length, 3);
}

test('RED on base: with every review already drafted, the prompt still makes room for the post idea', async (t) => {
  const store = createMemoryStore({ lint });
  await everyReviewDrafted(t, store);
  const llm = model(() => [post('Saddle Woods Farm')]);
  const r = await runAgent({ def: gbpDef(), store, llm, env: tree(t), fetchImpl: web(), scheduled: true });
  const { system, user } = llm.calls[0];

  // The 11.22 shape: every review is listed as already drafted.
  for (const who of ['ana p', 'ben r', 'cara m']) assert.match(user, new RegExp(`reviewer=${who}\\|platform=google \\(waiting for review\\)`));
  // (a) the post idea is still asked for, every run, even when every review is drafted.
  assert.match(system, /One profile post idea/);
  assert.match(system, /even when every review is already drafted/i);
  // (b) and its card has a seen shape it can satisfy.
  assert.match(system, /"reviewer": "profile post"/);
  assert.match(system, /"platform": "Google post"/);

  // That shape keys under gbp's real spec, so the memory can track it.
  assert.strictEqual(seenKey(gbpDef().seen_before, post('Saddle Woods Farm').seen), 'venue=saddle woods farm|reviewer=profile post|platform=google post');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.cards.length, 1, 'the run keeps the post idea: gbp done, 1 card');
  assert.strictEqual(store.runList[1].status, 'done');
});

test('rotation: a post idea waiting for one venue moves the next post idea to another venue', async (t) => {
  const store = createMemoryStore({ lint });
  await everyReviewDrafted(t, store);
  const r1 = await runAgent({ def: gbpDef(), store, llm: model(() => [post('Saddle Woods Farm')]), env: tree(t), fetchImpl: web(), scheduled: true });
  assert.strictEqual(r1.cards.length, 1);

  // Next morning: the model repeats Saddle Woods Farm, then names Cannery Hall.
  const llm = model(() => [post('Saddle Woods Farm'), post('Cannery Hall')]);
  const r2 = await runAgent({ def: gbpDef(), store, llm, env: tree(t), fetchImpl: web(), scheduled: true });
  const { system, user } = llm.calls[0];
  assert.match(user, /venue=saddle woods farm\|reviewer=profile post\|platform=google post \(waiting for review\)/,
    'the waiting post idea is listed as already drafted');
  assert.match(system, /next longest gap/i, 'the prompt says to take the next venue');
  assert.ok(r2.ok, r2.error);
  assert.deepStrictEqual(r2.cards.map((c) => c.target), ['Cannery Hall'], 'the repeat is skipped, the other venue is kept');
  assert.strictEqual(r2.seen_skipped, 1);
  assert.strictEqual(store.cards.filter((c) => c.target === 'Saddle Woods Farm' && /^Post idea/.test(c.title)).length, 1,
    'one post idea per venue while it waits');
  // Review replies are still never drafted twice.
  assert.strictEqual(store.cards.filter((c) => /^Reply draft/.test(c.title)).length, 3);
});
