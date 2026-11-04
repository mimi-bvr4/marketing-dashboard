'use strict';
// ORDER #2901: the Producer, slice 2. One queue, and the routing.
//
// Known-bad first, per chain: an owned keyword is skipped, an item already
// drafted is skipped, and no run queues more than 3. A Drive ask naming two
// team members becomes two queued runs, each with a REPLY line. Everything sits
// behind PRODUCER_QUEUE, which ships OFF; with it off, nothing changes.
// The web is fake: every call is refused unless a test answers it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const P = require('../lib/producer');
const chains = require('../lib/agent-chains');
const { gather } = require('../lib/agent-sources');
const { route } = require('../jobs/kh_route');
const { takeAndRun } = require('../jobs/agent_requests');

const ON = { PRODUCER_QUEUE: '1' };

const MAP = `# Blog keyword map

## 2. The map, by site

### TBB (thebridgebuilding.com)
| Focus keyword | Post | Status | Basis |
|---|---|---|---|
| outdoor wedding venue | \`/outdoor-wedding-venue/\` | published | sheet |
| winter wedding ideas nashville | cluster #9 | idea | cluster |
`;

function tree(t, files = { '07_Marketing_and_Brand/Blog_Agent/KEYWORD_MAP.md': MAP }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt2901-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function assertNothingDecided(store) {
  for (const c of store.cards) {
    assert.strictEqual(c.status, 'draft');
    assert.strictEqual(c.handoff || null, null);
  }
}

// ------------------------------------------------------------ the switch

test('PRODUCER_QUEUE ships OFF', () => {
  assert.strictEqual(P.queueOn({}), false);
  assert.strictEqual(P.queueOn({ PRODUCER_QUEUE: '' }), false);
  assert.strictEqual(P.queueOn({ PRODUCER_QUEUE: 'off' }), false);
  assert.strictEqual(P.queueOn({ PRODUCER_QUEUE: 'on' }), true);
});

// ------------------------------------------------------------ SEO to Bob, through the Producer

const seoCard = (id, lines) => ({ id, title: 'For Bloggy Bob: new posts', body: lines.map((l) => `- \`${l}\``).join('\n') });

test('KNOWN-BAD SEO to Bob: owned keyword skipped, already drafted skipped, at most 3 per run', async (t) => {
  const store = createMemoryStore({ lint });
  const env = { IHG_TREE: tree(t) };
  await store.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'blog draft', title: 'Historic', body: 'x',
    seen_key: 'target_keyword_or_url=historic venue nashville' });
  const card = seoCard(7, [
    'keyword: outdoor wedding venue · site: thebridgebuilding.com · post type: guide',
    'keyword: historic venue nashville · site: thebelltower.com · post type: guide',
    'keyword: rooftop wedding nashville · site: thebridgebuilding.com · post type: guide',
    'keyword: barn wedding nashville · site: saddlewoodsfarm.com · post type: guide',
    'keyword: lake wedding nashville · site: cherokeedock.com · post type: guide',
    'keyword: small wedding nashville · site: thecordelle.com · post type: guide',
  ]);
  const r = await P.afterRun({ slug: 'seo', cards: [card], store, env });
  const why = Object.fromEntries(r.skipped.map((s) => [s.item, s.why]));
  assert.strictEqual(why['outdoor wedding venue'], 'the keyword map already gives it to a page');
  assert.strictEqual(why['historic venue nashville'], 'Bloggy Bob already drafted it');
  assert.strictEqual(why['small wedding nashville'], 'over 3 for one run');
  assert.strictEqual(r.queued.length, 3);
  assert.ok(store.requests.every((q) => q.agent === 'bloggy-bob' && q.chain === chains.CHAIN_BOB && q.priority === 3));
  assertNothingDecided(store);
});

// ------------------------------------------------------------ Citations to Patty

function gapCard(id, domains) {
  return { id, title: 'Where AI gets its answers',
    body: '| Site AI cites | Pages cited | Searches it was cited for | Names of ours on those pages |\n|---|---|---|---|\n'
      + '| thebridgebuilding.com (OURS) | 2 | 3 | our own site |\n'
      + domains.map((d) => `| ${d} | 1 | 2 | NONE |`).join('\n') + '\n\nEnd.' };
}

test('KNOWN-BAD Citations to Patty: our own site and a marketplace skipped, already drafted skipped, at most 3 per run', async () => {
  const store = createMemoryStore({ lint });
  await store.insert({ agent: 'pr-patty', agent_name: 'PR Patty', job: 'press', title: 'Pitch', body: 'x', seen_key: 'request_id_or_url=partyslate.com' });
  const card = gapCard(9, ['peerspace.com', 'partyslate.com', 'a-blog.com', 'b-blog.com', 'c-blog.com', 'd-blog.com']);
  const r = await P.afterRun({ slug: 'citations', cards: [card], store, env: ON });
  const why = Object.fromEntries(r.skipped.map((s) => [s.item, s.why]));
  assert.match(why['peerspace.com'], /marketplace/);
  assert.strictEqual(why['partyslate.com'], 'PR Patty already drafted it');
  assert.strictEqual(why['d-blog.com'], 'over 3 for one run');
  assert.ok(!('thebridgebuilding.com' in why), 'our own site is never a pitch');
  assert.deepStrictEqual(r.queued.map((q) => q.item), ['a-blog.com', 'b-blog.com', 'c-blog.com']);
  assertNothingDecided(store);
});

// ------------------------------------------------------------ Scout to Bob (new)

const scoutCard = (id, moves) => ({ id, title: 'Scout report, week of 11.02.2026',
  body: `**1. Competitors this week.** No change: A, B.\n\n**4. Moves for us.**\n${moves.map((m) => `- ${m}`).join('\n')}\n\n**Sources**\nnone` });

test('KNOWN-BAD Scout to Bob: only with PRODUCER_QUEUE on; owned keyword skipped, already drafted skipped, at most 3 per run', async (t) => {
  const store = createMemoryStore({ lint });
  const root = tree(t);
  const card = scoutCard(11, [
    'Blog post for Bloggy Bob: "Outdoor wedding venue tips for fall at The Bridge Building"',
    'Blog post: "Cozy candlelit receptions at The Bell Tower"',
    'Blog post: "Micro weddings at The Cordelle this winter"',
    'Blog post: "Farm to table wedding menus at Saddle Woods Farm"',
    'Blog post: "Lakeside rehearsal dinners at Cherokee Dock"',
    'Blog post: "Holiday office parties at Estelle"',
    'Update the Saint Elle gallery with new photos',
  ]);
  // Bob already drafted one of them.
  await store.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'blog draft', title: 'Micro', body: 'x',
    seen_key: chains.bobKey('Micro weddings at The Cordelle this winter') });

  const off = await P.afterRun({ slug: 'scout', cards: [card], store, env: { IHG_TREE: root } });
  assert.strictEqual(off, null, 'switch off: the Scout route does not run');
  assert.strictEqual(store.requests.length, 0);

  const r = await P.afterRun({ slug: 'scout', cards: [card], store, env: { IHG_TREE: root, ...ON } });
  const why = Object.fromEntries(r.skipped.map((s) => [s.item, s.why]));
  assert.match(why['Outdoor wedding venue tips for fall at The Bridge Building'], /keyword map already gives "outdoor wedding venue"/);
  assert.strictEqual(why['Micro weddings at The Cordelle this winter'], 'Bloggy Bob already drafted it');
  assert.strictEqual(why['Holiday office parties at Estelle'], 'over 3 for one run');
  assert.deepStrictEqual(r.queued.map((q) => q.item),
    ['Cozy candlelit receptions at The Bell Tower', 'Farm to table wedding menus at Saddle Woods Farm', 'Lakeside rehearsal dinners at Cherokee Dock']);
  assert.ok(!r.skipped.concat(r.queued).some((x) => /gallery/.test(x.item)), 'a move that is not a blog post is never queued');
  for (const q of store.requests) {
    assert.strictEqual(q.agent, 'bloggy-bob');
    assert.strictEqual(q.chain, 'scout-to-bob');
    assert.strictEqual(q.from_card, 11);
    assert.match(q.ask, /A draft only: Approve on the Review tab saves an unpublished WordPress draft, and a person publishes\./);
    assert.doesNotMatch(q.ask, /ORDER|#29/);
  }
  const again = await P.afterRun({ slug: 'scout', cards: [card], store, env: { IHG_TREE: root, ...ON } });
  assert.deepStrictEqual(again.queued.map((q) => q.item), ['Holiday office parties at Estelle'], 'next run queues only the one the cap held back');
  assert.strictEqual(store.requests.length, 4, 'the three already queued are never queued twice');
  assert.strictEqual(new Set(store.requests.map((q) => q.ask)).size, 4);
  assertNothingDecided(store);
});

test('Scout: an unreadable keyword map queues nothing (fail closed)', async (t) => {
  const store = createMemoryStore({ lint });
  const root = tree(t, {});
  const r = await P.afterRun({ slug: 'scout', cards: [scoutCard(1, ['Blog post: "Cozy candlelit receptions at The Bell Tower"'])], store, env: { IHG_TREE: root, ...ON } });
  assert.strictEqual(store.requests.length, 0);
  assert.match(r.skipped[0].why, /keyword map could not be read/);
});

test('scoutBlogTitles reads quoted, italic and "blog title:" forms, only for blog moves', () => {
  const t = chains.scoutBlogTitles('**4. Moves for us.**\n- A blog post: *Winter brunch weddings at Estelle*\n- Call the florist about "Spring florals for everyone"\n- blog title: Rooftop toasts at The Bridge Building · venue: TBB\n\n**Sources**\n- post "Not a move at all, outside"');
  assert.deepStrictEqual(t, ['Winter brunch weddings at Estelle', 'Rooftop toasts at The Bridge Building']);
});

// ------------------------------------------------------------ new post to Paul

function wp(postsBySite) {
  return async (url) => {
    const m = String(url).match(/^https:\/\/([^/]+)\/wp-json\/wp\/v2\/posts\?/);
    if (!m || !postsBySite[m[1]]) throw new Error('no network in this test');
    const body = JSON.stringify(postsBySite[m[1]].map((p) => ({ link: p.link, date: p.date + 'T09:00:00', slug: p.slug, title: { rendered: p.title } })));
    return { status: 200, url, headers: { get: () => 'application/json; charset=UTF-8' }, text: async () => body };
  };
}
const at = (ymd) => () => new Date(`${ymd}T17:00:00Z`);
const SITE = 'saddlewoodsfarm.com';
const post = (slug, date) => ({ link: `https://${SITE}/${slug}/`, date, slug, title: slug });

test('KNOWN-BAD new post to Paul: already handled skipped, old post skipped, at most 3 per run with the switch on (the 4th waits a day)', async () => {
  const store = createMemoryStore({ lint });
  const posts = { [SITE]: [post('old', '2026-09-01')] };
  const fetchImpl = wp(posts);
  await chains.newPostsToPaul({ store, fetchImpl, now: at('2026-11-01'), sites: [SITE], cap: true });
  posts[SITE] = ['a', 'b', 'c', 'd'].map((s) => post(s, '2026-11-02')).concat([post('old', '2026-09-01'), post('late', '2026-09-20')]);
  const r = await chains.newPostsToPaul({ store, fetchImpl, now: at('2026-11-03'), sites: [SITE], cap: true });
  assert.strictEqual(r.queued.length, 3);
  assert.ok(r.skipped.some((s) => /over 3 for one run/.test(s.why)));
  assert.ok(r.skipped.some((s) => /published \d+ days ago/.test(s.why)));
  const next = await chains.newPostsToPaul({ store, fetchImpl, now: at('2026-11-04'), sites: [SITE], cap: true });
  assert.strictEqual(next.queued.length, 1, 'the post held back by the cap is queued the next day, once');
  assert.strictEqual(store.requests.length, 4);
  assert.ok(store.requests.every((q) => q.chain === 'new-post-to-paul' && q.priority === 3));
});

test('new post to Paul with the switch off keeps the #1759 behavior (no cap)', async () => {
  const store = createMemoryStore({ lint });
  const posts = { [SITE]: [] };
  const fetchImpl = wp(posts);
  await chains.newPostsToPaul({ store, fetchImpl, now: at('2026-11-01'), sites: [SITE] });
  posts[SITE] = ['a', 'b', 'c', 'd'].map((s) => post(s, '2026-11-02'));
  const r = await chains.newPostsToPaul({ store, fetchImpl, now: at('2026-11-03'), sites: [SITE] });
  assert.strictEqual(r.queued.length, 4);
});

test('dailyRoutes passes the cap only when the switch is on', async () => {
  const seen = [];
  const orig = chains.newPostsToPaul;
  chains.newPostsToPaul = async (a) => { seen.push(a.cap); return { queued: [], skipped: [] }; };
  try {
    await P.dailyRoutes({ store: {}, env: {} });
    await P.dailyRoutes({ store: {}, env: ON });
  } finally { chains.newPostsToPaul = orig; }
  assert.deepStrictEqual(seen, [false, true]);
});

// ------------------------------------------------------------ one queue, in priority order

test('one queue: with the switch on a deadline ask beats a person, a person beats a chain; off, oldest first', async () => {
  const build = async () => {
    const s = createMemoryStore({ lint });
    await s.chainRun({ chain: 'seo-to-bob', key: 'k1', agent: 'bloggy-bob', ask: 'chain', fromCard: 1 });
    await s.queueRun('seo', 'a person', 'katherine@x');
    await s.queueRun('pr-patty', 'deadline today', 'katherine@x');
    return s;
  };
  const order = async (env) => {
    const s = await build();
    const ran = [];
    await takeAndRun({ store: s, env, log: () => {}, runOne: async (agent) => { ran.push(agent); return { ok: true, cards: [] }; } });
    return ran;
  };
  assert.deepStrictEqual(await order(ON), ['pr-patty', 'seo', 'bloggy-bob']);
  assert.deepStrictEqual(await order({}), ['bloggy-bob', 'seo', 'pr-patty']);
  assert.deepStrictEqual([P.priorityOf({ agent: 'gbp' }), P.priorityOf({ agent: 'seo' }), P.priorityOf({ agent: 'pr-patty', chain: 'x' })], [1, 2, 3]);
});

// ------------------------------------------------------------ Drive asks naming two agents

function inbox(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt2901-inbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  return dir;
}
const KH = (title) => `# ORDER\nSTATUS: OPEN. GREEN\n\n- **TITLE:** ${title}\n- **OUTPUT:** drafts\n- **WHY:** spring push\n`;
const NOW = () => new Date('2026-11-03T18:00:00Z');

test('KNOWN-BAD: a two-agent Drive ask becomes two queued runs, each with a REPLY line', async (t) => {
  const dir = inbox(t, { 'ORDER_2026-11-03_9001_KH_spring.md': KH('A blog post about spring weddings and a Pinterest pin for it') });
  const store = createMemoryStore({ lint });
  const ran = [];
  const res = await route({ inbox: dir, now: NOW, log: () => {}, split: true,
    runOne: async (a) => { ran.push(a); return { ok: true, cards: [] }; },
    queue: (a, ask, who) => store.queueRun(a, ask, who), nameOf: (s) => ({ 'bloggy-bob': 'Bloggy Bob', 'pinterest-paul': 'Pinterest Paul' })[s] });
  assert.deepStrictEqual(ran, [], 'nothing runs inline; both go to the one queue');
  assert.deepStrictEqual(store.requests.map((q) => q.agent).sort(), ['bloggy-bob', 'pinterest-paul']);
  for (const q of store.requests) {
    assert.strictEqual(q.priority, 2, 'Katherine\'s own ask');
    assert.match(q.requested_by, /Katherine Howe/);
    assert.match(q.ask, /this run is (Bloggy Bob|Pinterest Paul)'s part only/);
    assert.doesNotMatch(q.ask, /9001|#\d/, 'no order numbers in anything Katherine sees');
  }
  const reply = fs.readdirSync(dir).find((f) => f.startsWith('REPLY_'));
  assert.strictEqual(reply, 'REPLY_2026-11-03_9001_marketing_producer_split.md');
  const text = fs.readFileSync(path.join(dir, reply), 'utf8');
  assert.match(text, /^CLAIMED: /m);
  assert.match(text, /^STATUS: QUEUED\. The ask names 2 team members/m);
  assert.strictEqual((text.match(/^- .*queued as run request \d+/gm) || []).length, 2, 'one REPLY line per queued run');
  assert.deepStrictEqual(res, [{ n: '9001', agents: ['bloggy-bob', 'pinterest-paul'], queued: 2 }]);

  await route({ inbox: dir, now: NOW, log: () => {}, split: true, runOne: async () => ({ ok: true }), queue: (a, ask, who) => store.queueRun(a, ask, who) });
  assert.strictEqual(store.requests.length, 2, 'an answered ask is never queued twice');
});

test('a split where one agent already has a run waiting says so on its own line', async (t) => {
  const dir = inbox(t, { 'ORDER_2026-11-03_9002_KH_x.md': KH('A blog post about spring weddings and a Pinterest pin for it') });
  const store = createMemoryStore({ lint });
  await store.queueRun('pinterest-paul', 'earlier', 'katherine@x');
  await route({ inbox: dir, now: NOW, log: () => {}, split: true, runOne: async () => ({ ok: true }), queue: (a, ask, who) => store.queueRun(a, ask, who) });
  const text = fs.readFileSync(path.join(dir, 'REPLY_2026-11-03_9002_marketing_producer_split.md'), 'utf8');
  assert.match(text, /^STATUS: PARTLY QUEUED\. 1 of 2/m);
  assert.match(text, /^- pinterest-paul \(pinterest-paul\): NOT queued: this agent already has a run waiting\./m);
});

test('switch off: a two-agent Drive ask is left for the lanes, exactly as before', async (t) => {
  const dir = inbox(t, { 'ORDER_2026-11-03_9003_KH_x.md': KH('A blog post about spring weddings and a Pinterest pin for it') });
  const store = createMemoryStore({ lint });
  const res = await route({ inbox: dir, now: NOW, log: () => {}, runOne: async () => ({ ok: true }), queue: (a, ask, who) => store.queueRun(a, ask, who) });
  assert.deepStrictEqual(res, [{ n: '9003', left: 'ambiguous' }]);
  assert.strictEqual(store.requests.length, 0);
  assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('REPLY_')));
});

test('four agents named is too broad to split and stays with the lanes', () => {
  assert.deepStrictEqual(P.splitAsk(['a', 'b', 'c', 'd']).split, false);
  assert.deepStrictEqual(P.splitAsk(['a']).split, false);
  assert.deepStrictEqual(P.splitAsk(['a', 'b']), { split: true, agents: ['a', 'b'] });
});

// ------------------------------------------------------------ Site Health's duplicate titles move to SEO

function crawlWeb() {
  const page = (title) => `<html><head><title>${title}</title><meta name="description" content="d"></head><body><h1>x</h1><p>plain words</p></body></html>`;
  const pages = {
    'https://a.com/': page('Same Title'), 'https://a.com/sitemap.xml': '<urlset><loc>https://a.com/p</loc></urlset>', 'https://a.com/p': page('Same Title'),
  };
  return async (url) => {
    const body = pages[String(url)];
    if (body === undefined) return { status: 404, url, headers: { get: () => 'text/html' }, text: async () => '' };
    return { status: 200, url, headers: { get: () => (String(url).endsWith('.xml') ? 'application/xml' : 'text/html') }, text: async () => body };
  };
}

test('duplicate titles: switch off, Site Health keeps them and SEO reads nothing new; on, they move to SEO', async () => {
  const sh = { type: 'site_crawl', sites: ['a.com'], same_titles_to_seo_when: 'PRODUCER_QUEUE' };
  const seo = { type: 'site_crawl', sites: ['a.com'], only: 'same_titles', when_flag: 'PRODUCER_QUEUE', label: 'our pages sharing one title' };

  const offSh = await gather([sh], { env: {}, fetch: crawlWeb(), lint });
  assert.match(offSh.got[0].text, /same title \| "Same Title"/);
  const offSeo = await gather([seo], { env: {}, fetch: crawlWeb(), lint });
  assert.deepStrictEqual([offSeo.got.length, offSeo.unavailable.length], [0, 0], 'switch off: the SEO source is not read and not reported');

  const onSh = await gather([sh], { env: ON, fetch: crawlWeb(), lint });
  assert.doesNotMatch(onSh.got[0].text, /"Same Title"/);
  assert.match(onSh.got[0].text, /on the SEO agent's card this week, not here/);
  const onSeo = await gather([seo], { env: ON, fetch: crawlWeb(), lint });
  assert.match(onSeo.got[0].text, /same title \| "Same Title" on a\.com\/, a\.com\/p/);
  assert.doesNotMatch(onSeo.got[0].text, /meta description|H1/);
});

test('the shipped agent files wire the move: Site Health hands titles off, SEO reads them, both behind PRODUCER_QUEUE', () => {
  const { loadAgent } = require('../lib/agent-runner');
  const sh = loadAgent('site-health').sources.find((s) => s.type === 'site_crawl');
  const seo = loadAgent('seo').sources.find((s) => s.type === 'site_crawl');
  assert.strictEqual(sh.same_titles_to_seo_when, 'PRODUCER_QUEUE');
  assert.strictEqual(seo.only, 'same_titles');
  assert.strictEqual(seo.when_flag, 'PRODUCER_QUEUE');
  assert.ok(!seo.required, 'never blocks SEO');
  assert.deepStrictEqual(seo.sites, sh.sites);
});
