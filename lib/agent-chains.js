// ORDER #1759: three agent-to-agent chains, drafts only.
//
//   seo-to-bob             SEO's "For Bloggy Bob" lines become queued Bob runs,
//                          unless the keyword map already owns the keyword or Bob
//                          already drafted it (#1758's seen-before key).
//   new-post-to-paul       a newly published post on one of our sites (the same
//                          public wp_posts read Bob uses) becomes a queued
//                          Pinterest Paul run. The pin still waits for Approve.
//   citation-gap-to-patty  a site AI assistants cite that names none of our
//                          venues (measured by Citations, never model-written)
//                          becomes a queued PR Patty request.
//
// A chain only ever QUEUES a run (agent_run_requests, the Run now queue). It
// never approves, publishes, sends or pins: every queued run ends at a draft card
// on the Review tab, exactly like a person's Run now. Each item is handled once,
// ever (agent_chains), and each queued run names the chain and the card it came from.
//
// NOT here (unruled): open dates feeding the Convention Connector or the GBP post idea.
'use strict';

const seenMem = require('./agent-seen');

const CHAIN_BOB = 'seo-to-bob';
const CHAIN_PAUL = 'new-post-to-paul';
const CHAIN_PATTY = 'citation-gap-to-patty';
// #2901: the Scout's blog move, routed by the Producer (PRODUCER_QUEUE on only).
const CHAIN_SCOUT_BOB = 'scout-to-bob';
const KEYWORD_MAP = '07_Marketing_and_Brand/Blog_Agent/KEYWORD_MAP.md';
// Per run, like SEO's own "at most 3" Bob requests.
const MAX_PER_RUN = 3;
// A post first seen more than this many days after its publish date is not new.
const NEW_POST_DAYS = 14;
// Citations SKILL item 3: hourly rental marketplaces are a business decision for
// Katherine and Mimi, never a pitch.
const MARKETPLACES = ['peerspace.com', 'giggster.com', 'swimply.com'];
// A keyword-map row with one of these statuses is owned by a real page or post.
const OWNED = /\b(published|archived|assigned|drafted)\b/i;

const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());

// ------------------------------------------------------------ SEO to Bob

// `keyword: <...> · site: <...> · post type: <...>`, one per line (agents/seo/SKILL.md item 3).
function bobLines(text) {
  const out = [];
  const re = /keyword:\s*([^·|;`\n]+?)\s*[·|;]\s*site:\s*([^·|;`\n]+?)\s*[·|;]\s*post type:\s*([^·|;`\n]+?)\s*(?:`|$)/gim;
  for (const m of String(text || '').matchAll(re)) {
    out.push({ keyword: m[1].trim(), site: m[2].trim(), post_type: m[3].trim(), line: `keyword: ${m[1].trim()} · site: ${m[2].trim()} · post type: ${m[3].trim()}` });
  }
  return out;
}

const normKeyword = (k) => seenMem.norm(String(k || '').replace(/\*/g, '').replace(/\([^)]*\)/g, ' '));

// Every keyword the map says a page of ours already owns. Section 1 (no Status
// column) lists contested keywords, all owned; section 2 rows count when the
// status is published, archived, assigned or drafted. An idea row does not own.
function ownedKeywords(mapText) {
  const owned = new Set();
  let kw = -1;
  let st = -1;
  for (const line of String(mapText || '').split('\n')) {
    if (!line.trim().startsWith('|')) { kw = -1; continue; }
    const c = cells(line);
    if (c.every((x) => /^:?-+:?$/.test(x))) continue;
    const k = c.findIndex((x) => /^focus keyword/i.test(x));
    if (k >= 0) { kw = k; st = c.findIndex((x) => /^status$/i.test(x)); continue; }
    if (kw < 0 || !c[kw]) continue;
    if (st >= 0 && !OWNED.test(c[st] || '')) continue;
    for (const alt of c[kw].split(/\s+\/\s+/)) { const n = normKeyword(alt); if (n) owned.add(n); }
  }
  return owned;
}

const bobKey = (keyword) => seenMem.seenKey({ key: ['target_keyword_or_url'] }, { target_keyword_or_url: keyword });

async function seoToBob({ store, cards, env, log }) {
  const out = { queued: [], skipped: [] };
  const found = [];
  for (const card of cards) for (const l of bobLines(require('./agent-runner').modelText(card.body))) found.push({ ...l, card });
  if (!found.length) return out;
  const { fileSource } = require('./agent-sources');
  const map = await fileSource({ path: KEYWORD_MAP }, { env });
  if (!map.ok) {
    // Fail closed: without the map the chain cannot tell an owned keyword, so it queues nothing and says so.
    out.skipped.push(...found.map((f) => ({ item: f.keyword, why: `the keyword map could not be read (${map.why})` })));
    return out;
  }
  const owned = ownedKeywords(map.text);
  for (const f of found) {
    const key = bobKey(f.keyword);
    if (!key) continue;
    if (owned.has(normKeyword(f.keyword))) { out.skipped.push({ item: f.keyword, why: 'the keyword map already gives it to a page' }); continue; }
    if ((await store.seenCards('bloggy-bob', [key])).length) { out.skipped.push({ item: f.keyword, why: 'Bloggy Bob already drafted it' }); continue; }
    if (out.queued.length >= MAX_PER_RUN) { out.skipped.push({ item: f.keyword, why: `over ${MAX_PER_RUN} for one run` }); continue; }
    const ask = `${f.line}\n\nQueued by the Box from SEO card #${f.card.id} ("${f.card.title}"), the "For Bloggy Bob" chain (ORDER #1759). `
      + 'A draft only: Approve on the Review tab saves an unpublished WordPress draft, and a person publishes.';
    const r = await store.chainRun({ chain: CHAIN_BOB, key, agent: 'bloggy-bob', ask, fromCard: f.card.id });
    if (r.request) out.queued.push({ item: f.keyword, request: r.request.id, from_card: f.card.id });
    else out.skipped.push({ item: f.keyword, why: r.skipped });
  }
  return out;
}

// ------------------------------------------------------------ citation gap to Patty

// The measured "Site AI cites" table (lib/agent-sources.js aiCitedSourcesSource):
// the sites cited for our searches whose cited pages name NONE of our venues.
function gapSites(body) {
  const out = [];
  let inTable = false;
  for (const line of String(body || '').split('\n')) {
    if (/^\|\s*Site AI cites\s*\|/i.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!line.trim().startsWith('|')) break;   // the table ends at its first non-row line
    const c = cells(line);
    if (c.every((x) => /^:?-+:?$/.test(x))) continue;
    const [site, pages, searches, names] = c;
    if (!site || /\(OURS\)/i.test(site) || names !== 'NONE') continue;
    out.push({ domain: site.toLowerCase().replace(/^www\./, ''), pages: Number(pages) || 0, searches: Number(searches) || 0 });
  }
  return out;
}

// #1758's norm() reads "partyslate.com" as words and "https://partyslate.com" as
// a URL, so a card Patty keyed either way is found: the URL form is the chain's key.
const pattyKeys = (domain) => [`https://${domain}`, domain].map((v) => seenMem.seenKey({ key: ['request_id_or_url'] }, { request_id_or_url: v }));

async function citationGapToPatty({ store, cards }) {
  const out = { queued: [], skipped: [] };
  const withTable = cards.filter((c) => gapSites(c.body).length);
  // Every card of a run carries the same measured table; the gap is the
  // "Where AI gets its answers" card's to-do (agents/citations/SKILL.md item 3).
  const card = withTable.find((c) => /where ai gets its answers/i.test(c.title)) || withTable[0];
  if (!card) return out;
  for (const g of gapSites(card.body)) {
    const keys = pattyKeys(g.domain);
    const key = keys[0];
    if (MARKETPLACES.includes(g.domain)) { out.skipped.push({ item: g.domain, why: 'an hourly rental marketplace is a business decision for Katherine and Mimi, not a pitch' }); continue; }
    if ((await store.seenCards('pr-patty', keys)).length) { out.skipped.push({ item: g.domain, why: 'PR Patty already drafted it' }); continue; }
    if (out.queued.length >= MAX_PER_RUN) { out.skipped.push({ item: g.domain, why: `over ${MAX_PER_RUN} for one run` }); continue; }
    const ask = `Draft a pitch to the editor of ${g.domain} to add our venues. AI assistants cite ${g.domain} for ${g.searches} of our searches `
      + `(${g.pages} page${g.pages === 1 ? '' : 's'}), and the Box read none of our venues on those pages.\n\n`
      + `Queued by the Box from Citations card #${card.id} ("${card.title}"), the citation gap chain (ORDER #1759). `
      + 'A draft only: Katherine sends any pitch herself.';
    const r = await store.chainRun({ chain: CHAIN_PATTY, key, agent: 'pr-patty', ask, fromCard: card.id });
    if (r.request) out.queued.push({ item: g.domain, request: r.request.id, from_card: card.id });
    else out.skipped.push({ item: g.domain, why: r.skipped });
  }
  return out;
}

// ------------------------------------------------------------ Scout to Bob (#2901)

// Scout's SKILL item 4: "Moves for us", at least one "a blog topic Bloggy Bob
// could write, phrased as a working title". A move counts as a blog move only
// when its line says blog or post AND carries the title in quotes or italics,
// or uses the explicit `blog title: <...>` form. Anything vaguer queues nothing.
function scoutBlogTitles(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  let inMoves = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/moves for us/i.test(line)) { inMoves = true; }
    else if (inMoves && (/^#{1,6}\s/.test(line) || /^(\d+\.\s*)?\*\*[^*]+\*\*\s*:?\s*$/.test(line))) inMoves = false;
    const explicit = line.match(/blog title:\s*([^·|;`\n]+?)\s*(?:[·|;`]|$)/i);
    if (explicit) { out.push(explicit[1].trim().replace(/^["“*_]+|["”*_]+$/g, '')); continue; }
    if (!inMoves || !/\b(blog|post)\b/i.test(line)) continue;
    const q = line.match(/[“"]([^”"]{8,120})[”"]/) || line.match(/(?:^|[\s(:])[*_]([^*_]{8,120})[*_](?=[\s).,;:]|$)/);
    if (q) out.push(q[1].trim());
  }
  return [...new Set(out)];
}

async function scoutToBob({ store, cards, env }) {
  const out = { queued: [], skipped: [] };
  const found = [];
  for (const card of cards) for (const title of scoutBlogTitles(require('./agent-runner').modelText(card.body))) found.push({ title, card });
  if (!found.length) return out;
  const { fileSource } = require('./agent-sources');
  const map = await fileSource({ path: KEYWORD_MAP }, { env });
  if (!map.ok) {
    out.skipped.push(...found.map((f) => ({ item: f.title, why: `the keyword map could not be read (${map.why})` })));
    return out;
  }
  // A working title is not a keyword, so it is owned when any owned keyword
  // appears inside it. That skips more than it should, never less.
  const owned = [...ownedKeywords(map.text)];
  for (const f of found) {
    const n = normKeyword(f.title);
    const key = bobKey(f.title);
    if (!key || !n) continue;
    const hit = owned.find((k) => ` ${n} `.includes(` ${k} `));
    if (hit) { out.skipped.push({ item: f.title, why: `the keyword map already gives "${hit}" to a page` }); continue; }
    if ((await store.seenCards('bloggy-bob', [key])).length) { out.skipped.push({ item: f.title, why: 'Bloggy Bob already drafted it' }); continue; }
    if ((await store.chainKeys(CHAIN_BOB, [key])).length) { out.skipped.push({ item: f.title, why: 'already queued from SEO' }); continue; }
    if (out.queued.length >= MAX_PER_RUN) { out.skipped.push({ item: f.title, why: `over ${MAX_PER_RUN} for one run` }); continue; }
    const ask = `Working title from the Scout: "${f.title}"\n\nQueued by the Producer from Scout card #${f.card.id} ("${f.card.title}"), the Scout's "Moves for us". `
      + 'A draft only: Approve on the Review tab saves an unpublished WordPress draft, and a person publishes.';
    const r = await store.chainRun({ chain: CHAIN_SCOUT_BOB, key, agent: 'bloggy-bob', ask, fromCard: f.card.id });
    if (r.request) out.queued.push({ item: f.title, request: r.request.id, from_card: f.card.id });
    else out.skipped.push({ item: f.title, why: r.skipped });
  }
  return out;
}

// ------------------------------------------------------------ after a run

// #2901: the routing moved into the Producer (lib/producer.js afterRun). Kept
// here so every existing caller reaches the same one place.
async function afterRun(args) {
  return require('./producer').afterRun(args);
}

// ------------------------------------------------------------ new post to Paul

const postKey = (link) => seenMem.norm(link);

function daysBetween(fromYmd, toYmd) {
  const a = Date.parse(`${fromYmd}T12:00:00Z`);
  const b = Date.parse(`${toYmd}T12:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 864e5) : null;
}

const mdY = (ymd) => { const [y, m, d] = ymd.split('-'); return `${m}.${d}.${y}`; };

function bobSites() {
  const src = (require('./agent-runner').loadAgent('bloggy-bob').sources || []).find((s) => s.type === 'wp_posts');
  return src ? src.sites : [];
}

// The first read of a site records every post already there and queues none, so
// turning the chain on never pins the back catalogue. After that, a post not seen
// before and published in the last 14 days is queued once.
// #2901 cap: with PRODUCER_QUEUE on, at most MAX_PER_RUN pins are queued per
// day; a new post over the cap is NOT marked, so the next day's read queues it.
async function newPostsToPaul({ store, fetchImpl, now = () => new Date(), log = () => {}, sites, cap = false }) {
  const { readWpPosts } = require('./agent-sources');
  const { OUR_SITES } = require('./pinterest');
  const list = (sites || bobSites()).filter((s) => OUR_SITES.includes(s));
  const { posts, miss, read } = await readWpPosts(list, { fetch: fetchImpl });
  const today = now().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const out = { queued: [], skipped: [], baseline: [], miss };
  for (const site of read) {
    const mine = posts.filter((p) => p.site === site && /^https:\/\//.test(p.link || ''));
    if (await store.chainMark(CHAIN_PAUL, `baseline:${site}`, `first read ${mdY(today)}: ${mine.length} posts recorded, none queued`)) {
      for (const p of mine) await store.chainMark(CHAIN_PAUL, postKey(p.link), 'published before the chain first read this site');
      out.baseline.push({ site, posts: mine.length });
      continue;
    }
    for (const p of mine) {
      const key = postKey(p.link);
      if ((await store.chainKeys(CHAIN_PAUL, [key])).length) continue;
      const age = daysBetween(p.date, today);
      if (age === null || age > NEW_POST_DAYS) {
        await store.chainMark(CHAIN_PAUL, key, age === null ? 'no publish date; not queued' : `published ${age} days before it was first seen; not queued`);
        out.skipped.push({ item: p.link, why: age === null ? 'no publish date' : `published ${age} days ago` });
        continue;
      }
      if (cap && out.queued.length >= MAX_PER_RUN) { out.skipped.push({ item: p.link, why: `over ${MAX_PER_RUN} for one run; the next read queues it` }); continue; }
      const bob = await store.bobCardForPost(site, p.slug);
      const ask = `Pin this new post: ${p.link}\n\n`
        + `Queued by the Box: a new post on ${site} ("${p.title}", published ${mdY(p.date)}), seen by the published-posts read, the new post chain (ORDER #1759). `
        + (bob ? `From Bloggy Bob card #${bob.id} ("${bob.title}"). ` : 'Not from a card: the post was written outside the Box. ')
        + 'The pin waits for Approve on the Review tab; nothing pins without it.';
      const r = await store.chainRun({ chain: CHAIN_PAUL, key, agent: 'pinterest-paul', ask, fromCard: bob ? bob.id : null });
      if (r.request) out.queued.push({ item: p.link, request: r.request.id, from_card: bob ? bob.id : null });
      else out.skipped.push({ item: p.link, why: r.skipped });
    }
  }
  log(`new posts: ${out.queued.length} Pinterest Paul run(s) queued`
    + (out.baseline.length ? `, first read of ${out.baseline.map((b) => `${b.site} (${b.posts} posts recorded)`).join(', ')}` : '')
    + (out.skipped.length ? `, ${out.skipped.length} not queued` : '') + (miss.length ? `, not read: ${miss.join(', ')}` : ''));
  return out;
}

module.exports = { afterRun, seoToBob, citationGapToPatty, scoutToBob, scoutBlogTitles, newPostsToPaul, bobLines, ownedKeywords, gapSites, normKeyword, bobKey,
  CHAIN_BOB, CHAIN_PAUL, CHAIN_PATTY, CHAIN_SCOUT_BOB, MAX_PER_RUN, NEW_POST_DAYS, MARKETPLACES };
