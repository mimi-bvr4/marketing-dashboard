// ORDER #1898: a saved edit recomputes the AI-tells summary, not just the flag
// count. Before this, /review showed a green badge still reading "1 dash (blocks
// ready), 1 flag, internal code left: TBB" on a card whose edit had fixed all three
// (V073's take). The page takes the badge colour from checks.ai_tells and the
// words from checks.ai_tells_summary, so both must come from the same edit.
// Memory store only: nothing is published, sent or pinned.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const EM = '—';
const BAD = `Tour TBB this fall ${EM} the hall holds 300 guests.`;
const FIXED = 'Tour The Bridge Building this fall. The hall holds 150 to 300 guests, depending on the setup.';
// What the create path wrote for BAD (V073's badge, word for word).
const STALE = 'AI-tells: 1 dash (blocks ready), 1 flag, internal code left: TBB';
const WHO = 'khowe@infinityhospitality.net';

// The badge exactly as public/review.html draws it: words from one field, colour from the other.
function badge(c) {
  const tells = (c.checks && c.checks.ai_tells_summary) || '';
  const bad = c.checks && c.checks.ai_tells && !c.checks.ai_tells.clean;
  return { text: tells, colour: bad ? 'bad' : 'good' };
}

function assertFixed(card) {
  const b = badge(card);
  assert.strictEqual(b.colour, 'good');
  assert.doesNotMatch(b.text, /dash/);
  assert.doesNotMatch(b.text, /flag/);
  assert.doesNotMatch(b.text, /TBB|internal code/);
  assert.strictEqual(b.text, 'AI-tells: clean');
}

async function staleCard(store, c) {
  return store.insert({ agent_name: 'x', job: 'x', checks: { ai_tells: lint(BAD), ai_tells_summary: STALE }, ...c });
}

test('the Review page still takes the badge words from ai_tells_summary and the colour from ai_tells', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.match(html, /const tells = \(c\.checks && c\.checks\.ai_tells_summary\) \|\| '';/);
  assert.match(html, /const bad = c\.checks && c\.checks\.ai_tells && !c\.checks\.ai_tells\.clean;/);
});

test('a review reply: an edit that removes the em dash, the hard capacity and the internal code clears all three from the badge words', async () => {
  const store = createMemoryStore({ lint });
  const row = await staleCard(store, { agent: 'gbp', title: 'Reply to Ana', body: `Thank you, Ana.\n${BAD}` });
  assert.strictEqual(badge(row).text, STALE);
  const out = await store.decide(row.id, { action: 'edit', who: WHO, body: `Thank you, Ana.\n${FIXED}` });
  assert.ok(out.card, out.error);
  assertFixed(out.card);
});

test('a review reply edit that leaves the code in says so, and matches what create would have said', async () => {
  const store = createMemoryStore({ lint });
  const row = await staleCard(store, { agent: 'gbp', title: 'Reply to Ana', body: `Thank you, Ana.\n${BAD}` });
  const out = await store.decide(row.id, { action: 'edit', who: WHO, body: 'Thank you, Ana. See you at TBB.' });
  assert.strictEqual(badge(out.card).colour, 'good');
  assert.strictEqual(badge(out.card).text, 'AI-tells: clean, internal code left: TBB');
});

test('a Bob post: editing the post clears the badge words', async () => {
  const store = createMemoryStore({ lint });
  const row = await staleCard(store, { agent: 'bloggy-bob', title: 'Draft: post (thebridgebuilding.com)', body: 'A fall post for The Bridge Building.',
    payload: { post: { site: 'thebridgebuilding.com', title: 'Fall at the river', slug: 'fall', content_md: `# Fall at the river\n\n${BAD}` } } });
  const out = await store.decide(row.id, { action: 'edit', who: WHO, body: `# Fall at the river\n\n${FIXED}` });
  assert.ok(out.card, out.error);
  assertFixed(out.card);
});

test('a Paul pin: editing the description clears the badge words', async () => {
  const store = createMemoryStore({ lint });
  const row = await staleCard(store, { agent: 'pinterest-paul', title: 'Pin: Fall at the river', body: 'One pin from the post.',
    payload: { pin: { board: 'Weddings', title: 'Fall at the river', description: BAD, link: 'https://thebridgebuilding.com/fall', image_url: 'https://thebridgebuilding.com/a.jpg' } } });
  const out = await store.decide(row.id, { action: 'edit', who: WHO, body: FIXED });
  assert.ok(out.card, out.error);
  assertFixed(out.card);
});

test('an edit that keeps an em dash keeps the badge red and says so in words', async () => {
  const store = createMemoryStore({ lint });
  const row = await staleCard(store, { agent: 'gbp', title: 'Reply to Ana', body: 'Thank you, Ana.' });
  const out = await store.decide(row.id, { action: 'edit', who: WHO, body: `Thank you ${EM} Ana.` });
  assert.strictEqual(badge(out.card).colour, 'bad');
  assert.strictEqual(badge(out.card).text, 'AI-tells: 1 dash (blocks ready)');
});
