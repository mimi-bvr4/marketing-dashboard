'use strict';
// ORDER #1759: three agent-to-agent chains, drafts only.
//
// Known-bad first: on main (e48851b) SEO's "For Bloggy Bob" lines, a newly
// published post and a Citations gap site queue nothing; a person has to paste
// each one into a Run now. Each chain below must queue exactly one run, name the
// card it came from, and never approve, publish, send or pin. The web is fake:
// only the WordPress posts read answers, and every other call is refused.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore, CHAIN_WHO } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');
const sources = require('../lib/agent-sources');
const chains = require('../lib/agent-chains');
const { takeAndRun } = require('../jobs/agent_requests');

const MAP = `# Blog keyword map

## 1. Cannibalization: one keyword, more than one site

| # | Focus keyword (or near-same) | Who targets it today | Suggested single owner | What the others do |
|---|---|---|---|---|
| C2 | **corporate event space** | TBT (published) | **TBT** | n/a |

## 2. The map, by site

### TBB (thebridgebuilding.com)
| Focus keyword | Post | Status | Basis |
|---|---|---|---|
| outdoor wedding venue | \`/outdoor-wedding-venue/\` | published | sheet |
| waterfront wedding venue nashville | cluster #2 | drafted | cluster |
| industrial wedding venue nashville (cluster #6) | cluster #6 | idea | cluster |
`;

function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt1759-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return { IHG_TREE: root };
}

function model(cards) {
  const calls = [];
  return { model: 'fake', calls, async complete(req) { calls.push(req); return JSON.stringify({ cards: cards(req) }); } };
}

// Every call refused and counted. Nothing may go out.
function web() {
  const calls = [];
  const f = async (url) => { calls.push(String(url)); throw new Error('no network in this test'); };
  f.calls = calls;
  return f;
}

const KMAP = { '07_Marketing_and_Brand/Blog_Agent/KEYWORD_MAP.md': MAP, 'gsc.md': '# Search Console, last 28 days\n- "rooftop wedding venue nashville": position 14' };
const seoDef = () => ({ ...loadAgent('seo'), sources: [{ type: 'file', path: 'gsc.md', required: true, label: 'Google Search Console' }] });
const seoCard = (lines) => [{ title: 'For Bloggy Bob: new posts', target: 'Bloggy Bob',
  body: `Three searches no page of ours owns:\n\n${lines.map((l) => `- \`${l}\``).join('\n')}` }];

// The two things a chain must never do: decide a card, or hand one off.
function assertNothingDecided(store) {
  for (const c of store.cards) {
    assert.strictEqual(c.status, 'draft', `card #${c.id} was not left as a draft`);
    assert.strictEqual(c.handoff, null, `card #${c.id} was handed off`);
    assert.strictEqual(c.decided_by, null);
  }
}

test('KNOWN-BAD: an SEO "For Bloggy Bob" line queues exactly one Bob run that names its card', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, KMAP);
  const fetchImpl = web();
  const llm = model(() => seoCard(['keyword: rooftop wedding venue nashville · site: thebridgebuilding.com · post type: venue guide']));
  const r = await runAgent({ def: seoDef(), store, llm, env, fetchImpl, scheduled: true });
  assert.ok(r.ok, r.error);
  assert.strictEqual(store.requests.length, 1, 'one Bob run is queued');
  const q = store.requests[0];
  assert.strictEqual(q.agent, 'bloggy-bob');
  assert.strictEqual(q.status, 'queued');
  assert.strictEqual(q.chain, 'seo-to-bob');
  assert.strictEqual(q.requested_by, CHAIN_WHO);
  assert.strictEqual(q.from_card, r.cards[0].id, 'the run names the card it came from');
  assert.match(q.ask, /^keyword: rooftop wedding venue nashville · site: thebridgebuilding\.com · post type: venue guide\n/);
  assert.match(q.ask, new RegExp(`from SEO card #${r.cards[0].id} \\("For Bloggy Bob: new posts"\\)`));
  assert.match(store.runList[0].note, /1 Bloggy Bob run queued/);
  assertNothingDecided(store);
  assert.strictEqual(fetchImpl.calls.length, 0, 'nothing went out');

  // The next Monday says the same thing: nothing is queued twice.
  await runAgent({ def: seoDef(), store, llm, env, fetchImpl, scheduled: true });
  assert.strictEqual(store.requests.length, 1, 'the same keyword is not queued a second time');
});

test('a keyword the map already owns is not queued; an idea row does not own; a keyword Bob drafted is not queued', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, KMAP);
  // Bob already drafted "historic venue nashville" (#1758 seen-before key).
  await store.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'blog draft', title: 'Historic venue', body: 'x',
    seen_key: 'target_keyword_or_url=historic venue nashville' });
  const llm = model(() => seoCard([
    'keyword: Outdoor Wedding Venue · site: thebridgebuilding.com · post type: guide',               // published in the map
    'keyword: corporate event space · site: thebelltower.com · post type: guide',                    // contested, section 1
    'keyword: waterfront wedding venue nashville · site: thebridgebuilding.com · post type: guide',  // drafted in the map
    'keyword: historic venue nashville · site: thebelltower.com · post type: guide',                 // Bob drafted it
    'keyword: industrial wedding venue nashville · site: thebridgebuilding.com · post type: guide',  // an idea: free to write
  ]));
  const r = await runAgent({ def: seoDef(), store, llm, env, fetchImpl: web(), scheduled: true });
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(store.requests.map((q) => q.ask.split('\n')[0]),
    ['keyword: industrial wedding venue nashville · site: thebridgebuilding.com · post type: guide']);
  const why = Object.fromEntries(r.chained.skipped.map((s) => [s.item, s.why]));
  assert.strictEqual(why['Outdoor Wedding Venue'], 'the keyword map already gives it to a page');
  assert.strictEqual(why['corporate event space'], 'the keyword map already gives it to a page');
  assert.strictEqual(why['waterfront wedding venue nashville'], 'the keyword map already gives it to a page');
  assert.strictEqual(why['historic venue nashville'], 'Bloggy Bob already drafted it');
  assert.match(store.runList[0].note, /1 Bloggy Bob run queued, 4 not queued/);
});

test('no keyword map, no Bob run: the chain fails closed and the run note says why', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, { 'gsc.md': KMAP['gsc.md'] });
  const llm = model(() => seoCard(['keyword: rooftop wedding venue nashville · site: thebridgebuilding.com · post type: guide']));
  const r = await runAgent({ def: seoDef(), store, llm, env, fetchImpl: web(), scheduled: true });
  assert.ok(r.ok, 'the SEO run itself still succeeds');
  assert.strictEqual(store.requests.length, 0);
  assert.match(store.runList[0].note, /0 Bloggy Bob runs queued, 1 not queued \(rooftop wedding venue nashville: the keyword map could not be read/);
});

// A measured "pages AI assistants cite" table, as aiCitedSourcesSource writes it.
const CITED = `Asked 9 searches of claude; 12 cited pages on 5 sites.

| Site AI cites | Pages cited | Searches it was cited for | Names of ours on those pages |
|---|---|---|---|
| partyslate.com | 3 | 6 | NONE |
| peerspace.com | 2 | 5 | NONE |
| thebridgebuilding.com (OURS) | 2 | 4 | our own site |
| theknot.com | 3 | 3 | The Bridge Building, Saddle Woods Farm |
| oldblog.example | 1 | 1 | (not readable) |

| Cited page | Cited by | Searches | Names of ours |
|---|---|---|---|
| https://www.theknot.com/x | claude | a | NONE |`;

function fakeCited(t) {
  const real = sources.REGISTRY.ai_cited_sources;
  sources.REGISTRY.ai_cited_sources = async () => ({ ok: true, table: CITED, text: CITED });
  t.after(() => { sources.REGISTRY.ai_cited_sources = real; });
}

const citationsDef = () => ({ ...loadAgent('citations'),
  sources: [{ type: 'ai_cited_sources', label: 'pages AI assistants cite for our searches', required: true }] });

test('KNOWN-BAD: a Citations gap site queues exactly one PR Patty request that names its card', async (t) => {
  fakeCited(t);
  const store = createMemoryStore({ lint });
  const fetchImpl = web();
  const llm = model(() => [
    { title: 'Listings: two fixes', target: 'our sites', body: 'Two mismatches with the canonical facts.' },
    { title: 'Where AI gets its answers', target: 'AI assistants', body: 'PartySlate is cited most and names none of our venues.' },
  ]);
  const r = await runAgent({ def: citationsDef(), store, llm, fetchImpl, scheduled: true });
  assert.ok(r.ok, r.error);
  assert.strictEqual(store.requests.length, 1, 'one gap site, one Patty request (the marketplace is not pitched)');
  const q = store.requests[0];
  const card = r.cards.find((c) => c.title === 'Where AI gets its answers');
  assert.strictEqual(q.agent, 'pr-patty');
  assert.strictEqual(q.chain, 'citation-gap-to-patty');
  assert.strictEqual(q.from_card, card.id, 'it names the "Where AI gets its answers" card');
  assert.match(q.ask, /^Draft a pitch to the editor of partyslate\.com to add our venues\. AI assistants cite partyslate\.com for 6 of our searches \(3 pages\)/);
  assert.match(q.ask, new RegExp(`from Citations card #${card.id} \\("Where AI gets its answers"\\)`));
  assert.match(q.ask, /Katherine sends any pitch herself/);
  assert.match(r.chained.skipped[0].why, /business decision for Katherine and Mimi/);
  assertNothingDecided(store);
  assert.strictEqual(fetchImpl.calls.length, 0);

  await runAgent({ def: citationsDef(), store, llm, fetchImpl, scheduled: true });
  assert.strictEqual(store.requests.length, 1, 'next month the same gap site is not queued again');
});

test('a gap site PR Patty already drafted is not queued', async (t) => {
  fakeCited(t);
  const store = createMemoryStore({ lint });
  await store.insert({ agent: 'pr-patty', agent_name: 'PR Patty', job: 'press', title: 'Pitch PartySlate', body: 'x',
    seen_key: 'request_id_or_url=partyslate.com' });
  const llm = model(() => [{ title: 'Where AI gets its answers', target: 'AI', body: 'The gap list.' }]);
  const r = await runAgent({ def: citationsDef(), store, llm, fetchImpl: web(), scheduled: true });
  assert.strictEqual(store.requests.length, 0);
  assert.ok(r.chained.skipped.some((s) => s.item === 'partyslate.com' && s.why === 'PR Patty already drafted it'));
});

// ------------------------------------------------------------ new post to Paul

function wp(postsBySite) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    const m = String(url).match(/^https:\/\/([^/]+)\/wp-json\/wp\/v2\/posts\?/);
    if (!m || !postsBySite[m[1]]) throw new Error('no network in this test');
    const body = JSON.stringify(postsBySite[m[1]].map((p) => ({ link: p.link, date: p.date + 'T09:00:00', slug: p.slug, title: { rendered: p.title } })));
    return { status: 200, url, headers: { get: () => 'application/json; charset=UTF-8' }, text: async () => body };
  };
  f.calls = calls;
  return f;
}

const at = (ymd) => () => new Date(`${ymd}T17:00:00Z`);
const SITE = 'saddlewoodsfarm.com';
const OLD = { link: `https://${SITE}/fall-barn-weddings/`, date: '2026-09-01', slug: 'fall-barn-weddings', title: 'Fall barn weddings' };
const NEW = { link: `https://${SITE}/winter-farm-weddings/`, date: '2026-10-13', slug: 'winter-farm-weddings', title: 'Winter farm weddings' };

test('KNOWN-BAD: a newly published post queues exactly one Pinterest Paul run; the first read pins no back catalogue', async () => {
  const store = createMemoryStore({ lint });
  const posts = { [SITE]: [OLD] };
  const fetchImpl = wp(posts);
  const first = await chains.newPostsToPaul({ store, fetchImpl, now: at('2026-10-12'), sites: [SITE] });
  assert.deepStrictEqual(first.baseline, [{ site: SITE, posts: 1 }]);
  assert.strictEqual(store.requests.length, 0, 'turning the chain on queues nothing for posts already there');

  posts[SITE] = [NEW, OLD];
  const second = await chains.newPostsToPaul({ store, fetchImpl, now: at('2026-10-14'), sites: [SITE] });
  assert.strictEqual(second.queued.length, 1);
  assert.strictEqual(store.requests.length, 1);
  const q = store.requests[0];
  assert.strictEqual(q.agent, 'pinterest-paul');
  assert.strictEqual(q.chain, 'new-post-to-paul');
  assert.match(q.ask, /^Pin this new post: https:\/\/saddlewoodsfarm\.com\/winter-farm-weddings\/\n/);
  assert.match(q.ask, /published 10\.13\.2026/);
  assert.match(q.ask, /Not from a card: the post was written outside the Box\./);
  assert.match(q.ask, /The pin waits for Approve on the Review tab; nothing pins without it\./);

  await chains.newPostsToPaul({ store, fetchImpl, now: at('2026-10-15'), sites: [SITE] });
  assert.strictEqual(store.requests.length, 1, 'the same post is never queued twice');
  assert.ok(fetchImpl.calls.every((u) => u.includes('/wp-json/wp/v2/posts?')), 'only the public posts read went out');
});

test('a new post that came from an approved Bob card names that card; an old post first seen late is not queued', async () => {
  const store = createMemoryStore({ lint });
  const posts = { [SITE]: [OLD] };
  const fetchImpl = wp(posts);
  await chains.newPostsToPaul({ store, fetchImpl, now: at('2026-10-12'), sites: [SITE] });
  const bob = await store.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'blog draft', title: 'Winter farm weddings', body: 'x',
    payload: { post: { site: 'www.saddlewoodsfarm.com', slug: 'winter-farm-weddings', title: 'Winter farm weddings', content_md: '# W' } } });
  const RESTORED = { link: `https://${SITE}/spring-2024/`, date: '2024-04-01', slug: 'spring-2024', title: 'Spring 2024' };
  posts[SITE] = [NEW, RESTORED, OLD];
  const r = await chains.newPostsToPaul({ store, fetchImpl, now: at('2026-10-14'), sites: [SITE] });
  assert.strictEqual(store.requests.length, 1);
  assert.strictEqual(store.requests[0].from_card, bob.id);
  assert.match(store.requests[0].ask, new RegExp(`From Bloggy Bob card #${bob.id} \\("Winter farm weddings"\\)\\.`));
  assert.deepStrictEqual(r.skipped.map((s) => s.item), [RESTORED.link]);
  assert.strictEqual(bob.status, 'draft', 'the Bob card is untouched');
});

test('a queued Paul run ends at a DRAFT pin card: the chain never approves or pins', async () => {
  const store = createMemoryStore({ lint });
  const posts = { [SITE]: [OLD] };
  await chains.newPostsToPaul({ store, fetchImpl: wp(posts), now: at('2026-10-12'), sites: [SITE] });
  posts[SITE] = [NEW, OLD];
  await chains.newPostsToPaul({ store, fetchImpl: wp(posts), now: at('2026-10-14'), sites: [SITE] });

  // The Box's Run now worker takes the queued request. The post page answers; Pinterest and everything else refuse.
  const html = `<html><head><title>Winter farm weddings</title></head><body><h1>Winter</h1><img src="https://${SITE}/wp-content/uploads/barn.jpg" alt="The barn in snow"></body></html>`;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url) === NEW.link) return { status: 200, url: NEW.link, headers: { get: () => 'text/html' }, text: async () => html };
    throw new Error('no network in this test');
  };
  const def = { ...loadAgent('pinterest-paul'), copy_prepass: false, sources: [{ type: 'blog_post', required: true, max_images: 5 }] };
  const llm = model(() => [{ title: 'Pin: Winter farm weddings', target: 'Pinterest', body: 'One pin for the new post.',
    pin: { board: 'Farm Weddings', title: 'Winter farm weddings in Tennessee', description: 'A snowy barn wedding at Saddle Woods Farm.',
      link: NEW.link, image_url: `https://${SITE}/wp-content/uploads/barn.jpg`, alt_text: 'The barn in snow' } }]);
  const n = await takeAndRun({ store, log: () => {}, runOne: (slug, ask) => runAgent({ slug, def, store, llm, ask, fetchImpl }) });
  assert.strictEqual(n, 1);
  assert.strictEqual(store.requests[0].status, 'done');
  assert.strictEqual(store.cards.length, 1);
  assert.ok(store.cards[0].payload.pin, 'the card carries the pin for Katherine to approve');
  assertNothingDecided(store);
  assert.deepStrictEqual(calls, [NEW.link], 'only the post was read; nothing went to Pinterest');
});

test('a run a chain queued never blocks a person\'s Run now', async () => {
  const store = createMemoryStore({ lint });
  await store.chainRun({ chain: 'seo-to-bob', key: 'target_keyword_or_url=x', agent: 'bloggy-bob', ask: 'keyword: x', fromCard: 1 });
  const mine = await store.queueRun('bloggy-bob', 'a post on y', 'katherine@infinityhospitality.net');
  assert.ok(mine.request, mine.error);
  const again = await store.queueRun('bloggy-bob', 'a post on z', 'katherine@infinityhospitality.net');
  assert.strictEqual(again.status, 409, 'two of her own still wait in line, as before');
});

test('a dry run and every other agent queue nothing', async (t) => {
  const store = createMemoryStore({ lint });
  const env = tree(t, KMAP);
  const llm = model(() => seoCard(['keyword: rooftop wedding venue nashville · site: thebridgebuilding.com · post type: guide']));
  await runAgent({ def: seoDef(), store, llm, env, fetchImpl: web(), dryRun: true });
  const gbp = { ...seoDef(), slug: 'gbp', seen_before: undefined };
  await runAgent({ def: gbp, store, llm, env, fetchImpl: web(), scheduled: true });
  assert.strictEqual(store.requests.length, 0);
});

test('parsers: the SEO line shape, the map\'s owned keywords, the measured gap rows', () => {
  assert.deepStrictEqual(chains.bobLines('- `keyword: a b · site: ihg · post type: venue list`\nkeyword: c | site: d | post type: e').map((l) => [l.keyword, l.site, l.post_type]),
    [['a b', 'ihg', 'venue list'], ['c', 'd', 'e']]);
  const owned = chains.ownedKeywords(MAP);
  assert.ok(owned.has('outdoor wedding venue'));
  assert.ok(owned.has('corporate event space'));
  assert.ok(owned.has('waterfront wedding venue nashville'));
  assert.ok(!owned.has('industrial wedding venue nashville'), 'an idea row does not own its keyword');
  assert.deepStrictEqual(chains.gapSites(CITED).map((g) => g.domain), ['partyslate.com', 'peerspace.com'],
    'only NONE rows of the site table: never our own site, a site that names us, an unreadable one, or the page table below');
});

test('the real keyword map parses, when this machine has it', (t) => {
  const root = sources.treeRoot();
  const p = root && path.join(root, '07_Marketing_and_Brand/Blog_Agent/KEYWORD_MAP.md');
  if (!p || !fs.existsSync(p)) { t.skip('no project tree here'); return; }
  const owned = chains.ownedKeywords(fs.readFileSync(p, 'utf8'));
  assert.ok(owned.has('outdoor wedding venue'), 'TBB\'s published post owns it');
  assert.ok(owned.size >= 20, `only ${owned.size} owned keywords parsed`);
});

test('the WordPress posts read keeps the JSON body (it used to drop it, so every read came back empty)', async () => {
  const r = await sources.readWpPosts([SITE], { fetch: wp({ [SITE]: [NEW] }) });
  assert.deepStrictEqual(r.read, [SITE]);
  assert.deepStrictEqual(r.posts.map((p) => p.link), [NEW.link]);
});
