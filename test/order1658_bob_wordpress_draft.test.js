'use strict';
// ORDER #1658: an approved Bloggy Bob card becomes an UNPUBLISHED WordPress
// draft, once, and nothing in the path can publish. Every guard is shown
// refusing a known-bad (iron rule 14).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createDraft, normalizeSite, stripH1 } = require('../lib/wp-draft');
const { mdToHtml } = require('../lib/md-html');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { handoff } = require('../jobs/agent_handoff');
const { runAgent, parseCards } = require('../lib/agent-runner');

const EM = '—';
const POST = { site: 'saddlewoodsfarm.com', title: 'Outdoor wedding venues near Nashville', slug: 'Outdoor Wedding Venues Nashville!',
  seo_description: 'A farm venue 40 minutes from downtown.', content_md: '# Outdoor wedding venues near Nashville\n\nSaddle Woods Farm sits on rolling acres.\n\n## The lawn\n\n- One\n- Two' };
const login = () => ({ user: 'brain@infinityhospitality.net', pass: 'app-pass-test' });

function fakeWp({ createStatus = 201, readStatus = 'draft', readCode = 200, createBody } = {}) {
  const calls = [];
  const fetchImpl = async (url, opt = {}) => {
    calls.push({ url, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : null, auth: opt.headers && opt.headers.Authorization });
    if ((opt.method || 'GET') === 'POST') {
      const b = createBody || { id: 4321 };
      return { status: createStatus, text: async () => JSON.stringify(b) };
    }
    return { status: readCode, text: async () => JSON.stringify({ id: 4321, status: readStatus }) };
  };
  return { calls, fetchImpl };
}

test('createDraft: POSTs status "draft" as brain@, strips the H1 into the title, slugs, reads back', async () => {
  const w = fakeWp();
  const r = await createDraft({ post: POST, fetchImpl: w.fetchImpl, login });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'draft');
  assert.strictEqual(r.edit_link, 'https://saddlewoodsfarm.com/wp-admin/post.php?post=4321&action=edit');
  const post = w.calls[0];
  assert.strictEqual(post.url, 'https://saddlewoodsfarm.com/wp-json/wp/v2/posts');
  assert.strictEqual(post.body.status, 'draft');
  assert.strictEqual(post.body.slug, 'outdoor-wedding-venues-nashville');
  assert.ok(!post.body.content.includes('<h1>'), 'the H1 is the WordPress title, not body text');
  assert.match(post.body.content, /<h2>The lawn<\/h2>/);
  assert.strictEqual(post.auth, 'Basic ' + Buffer.from('brain@infinityhospitality.net:app-pass-test').toString('base64'));
  assert.match(w.calls[1].url, /posts\/4321\?context=edit$/);
});

test('createDraft KNOWN-BAD: a read-back that is not a draft is an ALARM, not a success', async () => {
  const r = await createDraft({ post: POST, fetchImpl: fakeWp({ readStatus: 'publish' }).fetchImpl, login });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.alarm, true);
  assert.match(r.why, /ALARM/);
});

test('createDraft refuses: a Squarespace site, no Keychain item, a WordPress refusal, an empty post', async () => {
  const w = fakeWp();
  const sq = await createDraft({ post: { ...POST, site: 'https://www.thecordelle.com/blog' }, fetchImpl: w.fetchImpl, login });
  assert.strictEqual(sq.skip, true);
  assert.strictEqual(w.calls.length, 0, 'nothing is sent for a non-WordPress site');
  const nokey = await createDraft({ post: POST, fetchImpl: w.fetchImpl, login: () => null });
  assert.match(nokey.why, /no Keychain item wp-app-password-saddlewoodsfarm\.com/);
  assert.strictEqual(w.calls.length, 0);
  const refused = await createDraft({ post: POST, fetchImpl: fakeWp({ createStatus: 401, createBody: { code: 'rest_cannot_create', message: 'Sorry' } }).fetchImpl, login });
  assert.match(refused.why, /HTTP 401 rest_cannot_create: Sorry/);
  assert.match((await createDraft({ post: { site: 'saddlewoodsfarm.com' }, fetchImpl: w.fetchImpl, login })).why, /no post title or body/);
});

test('THE FENCE: lib/wp-draft.js sends one status and has no other write verb', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wp-draft.js'), 'utf8');
  for (const bad of ["'publish'", '"publish"', "'future'", "'private'", "'pending'", "'trash'", 'DELETE', "method: 'PUT'", 'force=true']) {
    assert.ok(!src.includes(bad), `wp-draft.js must not contain ${bad}`);
  }
  assert.match(src, /const DRAFT = 'draft';/);
  assert.strictEqual((src.match(/status: DRAFT/g) || []).length, 1, 'exactly one place sets the status');
});

test('normalizeSite and stripH1', () => {
  assert.strictEqual(normalizeSite('https://www.TheBellTower.com/weddings'), 'thebelltower.com');
  assert.strictEqual(stripH1('# Title\n\nBody'), 'Body');
  assert.strictEqual(stripH1('Body only'), 'Body only');
});

test('mdToHtml escapes HTML so a draft cannot carry a script into WordPress', () => {
  const h = mdToHtml('Hi <script>alert(1)</script> and [x](javascript:alert(1)) and [ok](https://a.com)');
  assert.ok(!h.includes('<script>'));
  assert.ok(!h.includes('href="javascript'));
  assert.match(h, /<a href="https:\/\/a\.com">ok<\/a>/);
});

// ------------------------------------------------------------- the store and the job

async function bobCard(store, post = POST) {
  return store.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'blog draft', title: 'Draft: x', body: 'Card text.', payload: { post } });
}

test('store: an edit on a post card changes the POST (what goes to WordPress), not the card text', async () => {
  const s = createMemoryStore({ lint });
  const c = await bobCard(s);
  const r = await s.decide(c.id, { action: 'edit', who: 'khowe@x', body: '# New\n\nKatherine wrote this.' });
  assert.strictEqual(r.card.payload.post.content_md, '# New\n\nKatherine wrote this.');
  assert.strictEqual(r.card.body, 'Card text.');
  assert.strictEqual(r.card.edited, true);
});

test('store KNOWN-BAD: approve refuses when the POST has an em dash even if the card text is clean', async () => {
  const s = createMemoryStore({ lint });
  const c = await bobCard(s, { ...POST, content_md: `# T\n\nA farm ${EM} by the river.` });
  assert.match((await s.decide(c.id, { action: 'approve', who: 'k@x' })).error, /em dash/);
});

test('handoff: only READY post cards go; each goes once; a skip is recorded; a retryable refusal is not', async () => {
  const s = createMemoryStore({ lint });
  const draftOnly = await bobCard(s);                                   // not approved: must not go
  const good = await bobCard(s);
  const elle = await bobCard(s, { ...POST, site: 'thecordelle.com' });
  const nokey = await bobCard(s, { ...POST, site: 'thebridgebuilding.com' });
  for (const c of [good, elle, nokey]) await s.decide(c.id, { action: 'approve', who: 'k@x' });
  const w = fakeWp();
  const logs = [];
  const loginSome = (d) => (d === 'thebridgebuilding.com' ? null : login(d));
  const r1 = await handoff({ store: s, fetchImpl: w.fetchImpl, login: loginSome, log: (l) => logs.push(l) });
  assert.strictEqual(r1.done, 1);
  assert.strictEqual((await s.get(good.id)).handoff.wp_id, 4321);
  assert.strictEqual((await s.get(elle.id)).handoff.ok, false);
  assert.match((await s.get(elle.id)).handoff.why, /not one of our WordPress sites/);
  assert.strictEqual((await s.get(nokey.id)).handoff, null, 'a missing key is retried next run, not closed');
  assert.strictEqual((await s.get(draftOnly.id)).handoff, null);
  const posts = w.calls.filter((c) => c.method === 'POST').length;
  const r2 = await handoff({ store: s, fetchImpl: w.fetchImpl, login: loginSome, log: () => {} });
  assert.strictEqual(w.calls.filter((c) => c.method === 'POST').length, posts, 'a second run never makes a second post');
  assert.strictEqual(r2.done, 0);
  assert.match(logs.join('\n'), /will retry, no Keychain item/);
});

// ------------------------------------------------------------- the runner keeps the post

test('runner: a post_fields agent stores the post as payload, and the lint covers the post text', async () => {
  const store = createMemoryStore({ lint });
  const def = { slug: 'bloggy-bob', name: 'Bloggy Bob', job: 'blog draft', post_fields: true, max_cards: 1, skill: '# Bob',
    sources: [{ type: 'request', required: true, label: 'the request' }] };
  const calls = [];
  const llm = { model: 'fake', async complete(req) {
    calls.push(req);
    const content = calls.length === 1 ? `# T\n\nA farm ${EM} by the river.` : '# T\n\nA farm by the river.';
    return JSON.stringify({ cards: [{ title: 'Draft: T (saddlewoodsfarm.com)', body: 'Card.', post: { ...POST, content_md: content } }] });
  } };
  await runAgent({ def, store, llm, ask: 'SWF post' });
  assert.match(calls[0].system, /"post"/);
  assert.strictEqual(calls.length, 2, 'the em dash in the POST sent it back for a rewrite');
  const c = store.cards[0];
  assert.strictEqual(c.payload.post.content_md, '# T\n\nA farm by the river.');
  assert.strictEqual(c.checks.ai_tells.clean, true);
});

test('parseCards: a post without a title or body is dropped, the card is kept', () => {
  const c = parseCards(JSON.stringify({ cards: [{ title: 'a', body: 'b', post: { site: 'x.com' } }] }), 1)[0];
  assert.strictEqual(c.post, null);
});

// ------------------------------------------------------------- 10.11.2026 live run fixes

const { unquoted, replaceDashes } = require('../lib/ai-tells');
const { modelText } = require('../lib/agent-runner');

test('lint: words a bot QUOTES (the ban list, a review) are not its own; dashes still count everywhere', () => {
  assert.strictEqual(lint('Checklist: no "delve", no "seamless", no `elevate`.').flags.length, 0);
  assert.strictEqual(lint('We delve into it.').flags.length, 1);
  assert.strictEqual(lint(`Quote: "great day ${EM} truly".`).fails.length, 1);
  assert.strictEqual(unquoted('a "b" c').length, 'a "b" c'.length, 'positions are kept, so line numbers stay right');
});

test('replaceDashes: a range becomes "to", any other dash a comma, and the count is returned', () => {
  assert.deepStrictEqual(replaceDashes(`RED ${EM} Reply, 5 – 7 p.m., 150${EM}200 guests`), { text: 'RED, Reply, 5 to 7 p.m., 150 to 200 guests', replaced: 3 });
  assert.deepStrictEqual(replaceDashes('clean text'), { text: 'clean text', replaced: 0 });
});

test('runner: a dash that survives the rewrite is replaced and the card says so; the lint ignores the appended tables', async () => {
  const store = createMemoryStore({ lint });
  const def = { slug: 'gbp', name: 'Google Business', job: 'replies', max_cards: 1, skill: '# GBP',
    sources: [{ type: 'request', required: true, label: 'the request' }] };
  const stubborn = JSON.stringify({ cards: [{ title: `RED ${EM} Reply draft`, body: `Thank you ${EM} truly.` }] });
  const llm = { model: 'fake', calls: 0, async complete() { this.calls++; return stubborn; } };
  await runAgent({ def, store, llm, ask: 'x' });
  const c = store.cards[0];
  assert.strictEqual(c.title, 'RED, Reply draft');
  assert.match(c.body, /^Thank you, truly\./);
  assert.strictEqual(c.checks.ai_tells.fails.length, 0);
  assert.match(c.checks.ai_tells_summary, /2 dashes replaced by the Box/);
  assert.strictEqual(modelText('Mine.\n\n### Measured: crawl (x)\n\n| a | AI-tell words: seamless |'), 'Mine.\n');
});

test('store: approve reads only the bot\'s own words, so a measured table cannot block it', async () => {
  const s = createMemoryStore({ lint });
  const c = await s.insert({ agent: 'site-health', agent_name: 'Site Health', job: 'j', title: 'Week',
    body: `Fix list.\n\n### Measured: crawl (10.11.2026 CT)\n\n| site | page | quoted copy: "a ${EM} b" |` });
  assert.strictEqual((await s.decide(c.id, { action: 'approve', who: 'k@x' })).card.status, 'ready');
});

test('relint: recomputes checks from the bot\'s own words and never touches title or body', async () => {
  const { relint } = require('../jobs/agent_relint');
  const row = { id: 1, title: 'Week', body: 'Clean words.\n\n### Measured: crawl (x)\n\n| AI-tell words: seamless, delve |', payload: null, checks: { ai_tells_summary: 'AI-tells: 173 flags' } };
  const writes = [];
  const pool = { async query(sql, args) { if (/^SELECT/.test(sql)) return { rows: [row] }; writes.push({ sql, args }); return { rows: [] }; } };
  await relint(pool, () => {});
  assert.strictEqual(writes.length, 1);
  assert.match(writes[0].sql, /^UPDATE agent_cards SET checks = \$2 WHERE id = \$1$/);
  assert.strictEqual(JSON.parse(writes[0].args[1]).ai_tells_summary, 'AI-tells: clean');
});
