// ORDER #1748 (Mimi 10.13.2026, "Yes, both"): every card passes the code checks
// before Approve (em dash, hard capacity, internal venue code, any agent), and
// outbound cards get the Copywriter pre-pass before they are saved.
// Memory store and fake models only: nothing is published, sent or pinned.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');

const { runAgent, loadAgent, wantsPrepass } = require('../lib/agent-runner');
const { createMemoryStore, approveBlockers } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const EM = '—';
const BAD = `Tour TBB this fall ${EM} the hall holds 300 guests.`;
const WHO = 'khowe@infinityhospitality.net';
const ENV = { IHG_TREE: os.tmpdir() };

function fakeModel(answers) {
  const calls = [];
  return { calls, model: 'test', complete: async (a) => { calls.push(a); return answers[Math.min(calls.length - 1, answers.length - 1)]; } };
}
// Any network call in these tests is a failure: nothing may publish, send or pin.
const noNet = async (u) => { throw new Error(`network call in a test: ${u}`); };
const card = (c) => JSON.stringify({ cards: [c] });
const viaRequest = (slug) => ({ ...loadAgent(slug), sources: [{ type: 'request' }] });

async function approve(store, c) {
  const row = await store.insert({ agent_name: 'x', job: 'x', ...c });
  return { row, out: await store.decide(row.id, { action: 'approve', who: WHO }) };
}

// ---------------------------------------------------------------- PART A: the gate

test('a Bob post carrying a code, a hard capacity and an em dash is refused at Approve, naming each and the line', async () => {
  const store = createMemoryStore({ lint });
  const { row, out } = await approve(store, { agent: 'bloggy-bob', title: 'Draft: post (thebridgebuilding.com)', body: 'A fall post for The Bridge Building.',
    payload: { post: { site: 'thebridgebuilding.com', title: 'Fall at the river', slug: 'fall', content_md: `# Fall at the river\n\nIntro.\n\n${BAD}` } } });
  assert.match(out.error, /^Approve refused: /);
  assert.match(out.error, /the post line 5: em dash/);
  assert.match(out.error, /the post line 5: hard capacity "holds 300"/);
  assert.match(out.error, /the post line 5: internal code in public copy "TBB \(write "The Bridge Building"\)"/);
  assert.strictEqual(row.status, 'draft');
  assert.deepStrictEqual(await store.readyForHandoff(), []);
});

test('a Paul pin carrying all three is refused at Approve, so it is never pinned', async () => {
  const store = createMemoryStore({ lint });
  const { row, out } = await approve(store, { agent: 'pinterest-paul', title: 'Pin: Fall at the river', body: 'One pin from the post.',
    payload: { pin: { board: 'Weddings', title: 'Fall at TBB', description: BAD, link: 'https://thebridgebuilding.com/fall', image_url: 'https://thebridgebuilding.com/a.jpg' } } });
  assert.match(out.error, /the pin title: internal code in public copy "TBB/);
  assert.match(out.error, /the pin description: em dash/);
  assert.match(out.error, /the pin description: hard capacity "holds 300"/);
  assert.strictEqual(row.status, 'draft');
  assert.deepStrictEqual(await store.readyForHandoff(), []);
});

test('a GBP reply carrying all three is refused at Approve', async () => {
  const store = createMemoryStore({ lint });
  const { out } = await approve(store, { agent: 'gbp', title: 'Reply to Ana', body: `Thank you, Ana.\n${BAD}` });
  assert.match(out.error, /the card line 2: em dash/);
  assert.match(out.error, /the card line 2: hard capacity/);
  assert.match(out.error, /the card line 2: internal code in public copy "TBB/);
});

test('each check blocks on its own, on any agent (an internal report too); a ranged capacity passes', async () => {
  const store = createMemoryStore({ lint });
  // RED on main: before #1748 only the em dash blocked, so these two were approvable.
  assert.match((await approve(store, { agent: 'gbp', title: 'Reply', body: 'Our barn holds 300 guests.' })).out.error, /hard capacity/);
  assert.match((await approve(store, { agent: 'seo', title: 'SEO report', body: 'The ECD page ranks 4th.' })).out.error, /internal code in public copy "ECD/);
  assert.match((await approve(store, { agent: 'scout', title: 'Scout', body: `Moves ${EM} three.` })).out.error, /em dash/);
  const ok = (await approve(store, { agent: 'gbp', title: 'Reply', body: 'The barn holds 150 to 300 guests depending on the floor plan, at The Bridge Building.' })).out;
  assert.strictEqual(ok.card.status, 'ready');
});

test('the measured tables and the copy check section are not the bot\'s words and never block Approve', async () => {
  const store = createMemoryStore({ lint });
  const body = 'Thank you, Ana.\n\n### Copy check (the Copywriter, before you saw this)\n\n1. Was "TBB holds 300" ' + EM + ' now The Bridge Building.\n\n### Measured: reviews\n\n| TBB | 5 |';
  const { out } = await approve(store, { agent: 'gbp', title: 'Reply to Ana', body });
  assert.strictEqual(out.card.status, 'ready');
});

test('approveBlockers is empty on a clean card, and the Review page header names the Paul exception', () => {
  assert.deepStrictEqual(approveBlockers({ title: 'Reply', body: 'Thank you, Ana.' }, lint), []);
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.match(html, /Approve on a Pinterest Paul card pins it live on Pinterest/);
  assert.doesNotMatch(html, /It never publishes, posts, sends or spends/);
});

test('the runner sends an internal code back to the model on every agent now, not only the Email agent', async () => {
  const store = createMemoryStore({ lint });
  const llm = fakeModel([card({ title: 'Site report', body: 'The SWF page is down.' }), card({ title: 'Site report', body: 'The Saddle Woods Farm page is down.' })]);
  const r = await runAgent({ def: viaRequest('site-health'), store, llm, ask: 'go', env: ENV, fetchImpl: noNet, log: () => {} });
  assert.ok(r.ok, r.error);
  assert.match(llm.calls[1].user, /copy check hits: internal code in public copy "SWF/);
  assert.match(r.cards[0].body, /Saddle Woods Farm page is down/);
});

// ---------------------------------------------------------------- PART B: the Copywriter pre-pass

const VERDICT = '**Needs changes (3)**\n\n**Corrected text**\n\nTour The Bridge Building this fall. The hall holds 150 to 300 guests, depending on the setup.\n\n**Changes**\n1. "TBB" is now "The Bridge Building" (internal code).\n2. The em dash is now a period (ban list 1).\n3. "holds 300" is now a range with "depending on" (house rule).';

test('a GBP reply goes through the Copywriter before it is saved: "Needs changes" with the corrected text, and Approve still refuses the original', async () => {
  const store = createMemoryStore({ lint });
  const llm = fakeModel([card({ title: 'Reply to Ana', body: BAD }), card({ title: 'Reply to Ana', body: BAD }),
    card({ title: 'Copy check: Tour TBB this fall', body: VERDICT })]);
  const r = await runAgent({ def: viaRequest('gbp'), store, llm, ask: 'reply to Ana', env: ENV, fetchImpl: noNet, log: () => {} });
  assert.ok(r.ok, r.error);
  assert.strictEqual(llm.calls.length, 3);
  const cw = llm.calls[2];
  assert.match(cw.system, /^---\nname: copywriter/);
  assert.match(cw.system, /THE FENCE/);
  assert.match(cw.user, /internal code in public copy \| TBB/);
  assert.match(cw.user, /=== THE TEXT, EXACTLY AS SUBMITTED ===\nReply to Ana/);
  const c = r.cards[0];
  assert.strictEqual(c.status, 'draft');
  assert.deepStrictEqual(c.checks.copy_check, { ran: true, ready: false, changes: 3, summary: 'Copy check: Needs changes (3)' });
  assert.match(c.body, /### Copy check \(the Copywriter, before you saw this\)\n\n\*\*Needs changes \(3\)\*\*/);
  assert.match(c.body, /Tour The Bridge Building this fall\. The hall holds 150 to 300 guests, depending on the setup\./);
  assert.match(c.body, /\n1\. "TBB" is now "The Bridge Building"/);
  assert.ok(c.body.indexOf('### Copy check') < c.body.indexOf('_Drafted by '));
  // The Box already swapped the leftover em dash for a comma (#1015); the code and the capacity it cannot fix still block.
  const refused = (await store.decide(c.id, { action: 'approve', who: WHO })).error;
  assert.match(refused, /^Approve refused: .*internal code in public copy "TBB/);
  assert.match(refused, /hard capacity "holds 300"/);
  assert.doesNotMatch(refused, /em dash/);
});

test('a Bob post is checked on the post itself (what goes to WordPress), and a clean one reads "Ready to go out"', async () => {
  const store = createMemoryStore({ lint });
  const post = { site: 'thebridgebuilding.com', title: 'Fall at the river', slug: 'fall', content_md: '# Fall at the river\n\nThe leaves turn early on the Cumberland.' };
  const llm = fakeModel([card({ title: 'Draft: post', body: 'A fall post.', post }), card({ title: 'Copy check: Fall at the river', body: '**Ready to go out**\n\nNo changes.' })]);
  const r = await runAgent({ def: viaRequest('bloggy-bob'), store, llm, ask: 'a fall post', env: ENV, fetchImpl: noNet, log: () => {} });
  assert.ok(r.ok, r.error);
  assert.match(llm.calls[1].user, /=== THE TEXT, EXACTLY AS SUBMITTED ===\nFall at the river\n\n# Fall at the river\n\nThe leaves turn early on the Cumberland\./);
  assert.strictEqual(r.cards[0].checks.copy_check.summary, 'Copy check: Ready to go out');
  assert.strictEqual(r.cards[0].payload.post.content_md, post.content_md);
});

test('a Paul pin is checked on the pin text', async () => {
  const store = createMemoryStore({ lint });
  const pin = { board: 'Weddings', title: 'Fall at the river', description: 'Leaves on the Cumberland.', link: 'https://x.test/p', image_url: 'https://x.test/a.jpg', alt_text: 'A barn' };
  const llm = fakeModel([card({ title: 'Pin', body: 'One pin.', pin }), card({ title: 'Copy check', body: '**Ready to go out**\n\nNo changes.' })]);
  const r = await runAgent({ def: viaRequest('pinterest-paul'), store, llm, ask: 'https://x.test/p', env: ENV, fetchImpl: noNet, log: () => {} });
  assert.ok(r.ok, r.error);
  assert.match(llm.calls[1].user, /EXACTLY AS SUBMITTED ===\nFall at the river\n\nLeaves on the Cumberland\.\n\nA barn/);
  assert.strictEqual(r.cards[0].checks.copy_check.ready, true);
});

test('a Copywriter failure still saves the card as a draft that says "Copy check did not run"; never silent', async () => {
  for (const bad of ['no json at all', card({ title: 'Copy check', body: 'Looks fine to me.' }), new Error('model answered 529')]) {
    const store = createMemoryStore({ lint });
    const answers = [card({ title: 'Pitch: Nashville openings', body: 'Hello, a pitch for The Cordelle.' })];
    const llm = { calls: [], model: 'test', complete: async (a) => { llm.calls.push(a); if (llm.calls.length === 1) return answers[0]; if (bad instanceof Error) throw bad; return bad; } };
    const r = await runAgent({ def: viaRequest('pr-patty'), store, llm, ask: 'pitch', env: ENV, fetchImpl: noNet, log: () => {} });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.cards.length, 1);
    const c = r.cards[0];
    assert.strictEqual(c.status, 'draft');
    assert.strictEqual(c.checks.copy_check.ran, false);
    assert.strictEqual(c.checks.copy_check.summary, 'Copy check did not run');
    assert.match(c.body, /### Copy check did not run\n\nCopy check did not run: /);
  }
});

test('internal reports have no copy check section and make no extra model call', async () => {
  for (const slug of ['seo', 'citations', 'monthly-report', 'site-health', 'scout']) {
    const store = createMemoryStore({ lint });
    const llm = fakeModel([card({ title: 'Report', body: 'The numbers for The Bridge Building.' })]);
    const r = await runAgent({ def: viaRequest(slug), store, llm, ask: 'go', env: ENV, fetchImpl: noNet, log: () => {} });
    assert.ok(r.ok, `${slug}: ${r.error}`);
    assert.strictEqual(llm.calls.length, 1, slug);
    assert.doesNotMatch(r.cards[0].body, /Copy check/, slug);
    assert.strictEqual(r.cards[0].checks.copy_check, undefined, slug);
  }
});

test('which agents get the pre-pass: the six outbound ones; the Email scorecard (scheduled, no request) does not', () => {
  for (const s of ['bloggy-bob', 'pinterest-paul', 'pr-patty', 'convention-connector', 'gbp']) assert.ok(wantsPrepass(loadAgent(s), null), s);
  assert.ok(wantsPrepass(loadAgent('email'), 'Wedding nurture email 1'));
  assert.ok(!wantsPrepass(loadAgent('email'), null));
  for (const s of ['seo', 'citations', 'site-health', 'scout', 'monthly-report', 'paid-ads', 'copywriter', 'collateral-cadet']) {
    assert.ok(!wantsPrepass(loadAgent(s), 'x'), s);
  }
});

test("Katherine's saved Copywriter instructions are the ones the pre-pass uses", async () => {
  const store = createMemoryStore({ lint });
  await store.saveSettings('copywriter', { skill_md: 'KATHERINE COPYWRITER v2: check it.', enabled: true, max_cards: 1, who: WHO });
  const llm = fakeModel([card({ title: 'Reply', body: 'Thank you, Ana.' }), card({ title: 'Copy check', body: '**Ready to go out**' })]);
  const r = await runAgent({ def: viaRequest('gbp'), store, llm, ask: 'reply', env: ENV, fetchImpl: noNet, log: () => {} });
  assert.ok(r.ok, r.error);
  assert.match(llm.calls[1].system, /^KATHERINE COPYWRITER v2: check it\./);
});
