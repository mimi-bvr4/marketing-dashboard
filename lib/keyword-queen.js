// ORDER #3163 (Mimi 11.09.2026, "Yes, file it"): the Keyword Queen. Once a
// week she writes ONE Review card: the top 10 blog topics for the week, each
// with its target keyword, monthly volume and difficulty (with the source),
// the venue or brand it serves, and why now. Approving one topic queues it for
// Bloggy Bob as his next request.
//
// The model drafts the table; THIS FILE decides what is saved. Before the card
// is saved, code:
//   - keeps a volume, difficulty or rank only when the same number sits on a
//     line of a source read this run that also names the keyword. Anything else
//     is blanked and the card says which figures were blanked. Never invented.
//   - drops a topic whose venue is not in Venue_Master_CANONICAL.md (or one of
//     the three brands), and fails closed if that file was not read.
//   - drops a keyword a page already owns (the keyword map), a live post
//     already covers (the WordPress posts read), or Bloggy Bob already drafted.
//   - drops a venue + keyword she suggested in the last 90 days, unless its
//     rank dropped since (a bigger position number, both measured).
//   - keeps at most 10, in her order, and writes the table itself.
//
// Approve a topic: one queued Bloggy Bob run per topic, ever (the chain table
// keys it on card + topic), at the approving person's priority and under their
// name. It is a draft request: Bob's card still waits on the Review tab, and
// nothing publishes.
//
// FEATURE FLAG: AGENT_KEYWORD_QUEEN default OFF. Off, she is never run (the
// Producer's switchOff) and the approve route refuses with 404.
'use strict';

const seenMem = require('./agent-seen');

const SLUG = 'keyword-queen';
const FLAG = 'AGENT_KEYWORD_QUEEN';
const CHAIN = 'keyword-queen-to-bob';
const MAX_TOPICS = 10;
const SEEN_DAYS = 90;
const VENUE_MASTER = 'Venue_Master_CANONICAL.md';
// The brands a topic may serve when it is not about one venue. Venue names come
// only from Venue_Master_CANONICAL.md; these are company names, not venues.
const BRANDS = ['Infinity Hospitality Group', 'Dream Events & Catering', 'DailyDish'];
// Venue codes in the master that are not venues a blog serves.
const NOT_VENUES = ['KITCHEN', 'OFFSITE', 'OS'];

function queenOn(env = process.env) {
  return /^(1|on|true|yes)$/i.test(String((env || {})[FLAG] || '').trim());
}

const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
const isRule = (c) => c.length && c.every((x) => /^:?-+:?$/.test(x));
const plainName = (s) => String(s || '').replace(/\*\*/g, '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
const nameKey = (s) => plainName(s).toLowerCase().replace(/^the\s+/, '').replace(/^st\.?\s+/, 'saint ').replace(/[^a-z0-9&]+/g, ' ').trim();

// Every venue name in the master: the first cell of a table row whose second
// cell is a venue code (TBB, STE, ...). The "The" forms of the naming law are
// the same names once "the" is dropped, so both spellings match.
function canonicalVenues(masterText) {
  const out = new Map();
  for (const line of String(masterText || '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const c = cells(line);
    if (c.length < 2 || isRule(c)) continue;
    const code = c[1].replace(/\*\*/g, '').trim();
    if (!/^[A-Z]{2,8}$/.test(code) || NOT_VENUES.includes(code)) continue;
    const name = plainName(c[0]);
    if (name && !out.has(nameKey(name))) out.set(nameKey(name), { name, code });
  }
  return out;
}

function venueOf(raw, venues) {
  const k = nameKey(raw);
  if (!k) return null;
  if (venues.has(k)) return venues.get(k).name;
  for (const v of venues.values()) if (v.code === String(raw).trim().toUpperCase()) return v.name;
  const brand = BRANDS.find((b) => nameKey(b) === k);
  return brand || null;
}

// The topic table the skill asks for. Columns are found by header name, so a
// reordered table still reads; a row with no keyword is not a topic.
const COLS = {
  topic: /^(blog )?topic|^title|working title/i,
  keyword: /keyword/i,
  venue: /venue|brand/i,
  volume: /volume/i,
  difficulty: /difficulty|\bsd\b|\bkd\b/i,
  rank: /rank|position/i,
  source: /source/i,
  why: /why/i,
};
function parseTopics(body) {
  const out = [];
  let idx = null;
  for (const line of String(body || '').split('\n')) {
    if (!line.trim().startsWith('|')) { if (idx && out.length) break; idx = null; continue; }
    const c = cells(line);
    if (isRule(c)) continue;
    if (!idx) {
      const map = {};
      for (const [k, re] of Object.entries(COLS)) {
        const i = c.findIndex((h, j) => re.test(h) && !Object.values(map).includes(j));
        if (i >= 0) map[k] = i;
      }
      if (map.keyword != null && map.topic != null) idx = map;
      continue;
    }
    const get = (k) => (idx[k] != null ? String(c[idx[k]] || '').trim() : '');
    const keyword = get('keyword').replace(/^["“]|["”]$/g, '');
    if (!keyword) continue;
    out.push({ topic: get('topic'), keyword, venue: get('venue'), volume: get('volume'), difficulty: get('difficulty'),
      rank: get('rank'), source: get('source'), why_now: get('why') });
  }
  return out;
}

const BLANKISH = /^(|-|n\/?a|none|unknown|blank|\(blank\)|\?|tbd|not (known|available))$/i;
const num = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (BLANKISH.test(s)) return null;
  const m = s.replace(/,/g, '').match(/^~?\s*(\d+(?:\.\d+)?)\s*(k)?\b/i);
  if (!m) return null;
  return m[2] ? null : Number(m[1]); // "1.2k" is a rounding, not the source's number
};

// The lines of this run's sources that name the keyword.
function keywordLines(keyword, texts) {
  const k = seenMem.norm(keyword);
  if (!k) return [];
  const out = [];
  for (const t of texts) for (const line of String(t || '').split('\n')) if (` ${seenMem.norm(line)} `.includes(` ${k} `)) out.push(line);
  return out;
}
function onLine(n, lines) {
  const want = String(n);
  return lines.some((l) => (l.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) || []).includes(want));
}

// A figure stays only when a source line names the keyword AND carries the
// number, and the card names a source. Otherwise it is blank, and says so.
function checkFigures(t, texts) {
  const lines = keywordLines(t.keyword, texts);
  const blanked = [];
  const out = { ...t };
  for (const f of ['volume', 'difficulty', 'rank']) {
    const n = num(t[f]);
    const raw = String(t[f] || '').trim();
    if (n == null) { if (raw && !BLANKISH.test(raw)) blanked.push(f); out[f] = ''; continue; }
    if (!String(t.source || '').trim() || !onLine(n, lines)) { blanked.push(f); out[f] = ''; continue; }
    out[f] = String(n);
  }
  if (!out.volume && !out.difficulty && !out.rank) out.source = '';
  return { topic: out, blanked };
}

const topicKey = (venue, keyword) => `${nameKey(venue)}|${seenMem.norm(keyword)}`;

// Venue + keyword suggestions on her earlier cards, newest first.
// cards: her earlier cards with payload.topics and created_at.
function recentTopics(cards, now = new Date(), days = SEEN_DAYS) {
  const since = now.getTime() - days * 864e5;
  const out = new Map();
  for (const c of cards || []) {
    const at = new Date(c.created_at).getTime();
    if (!Number.isFinite(at) || at < since) continue;
    for (const t of (c.payload && c.payload.topics) || []) {
      const k = t.key || topicKey(t.venue, t.keyword);
      const prev = out.get(k);
      if (!prev || prev.at < at) out.set(k, { at, rank: num(t.rank), card: c.id });
    }
  }
  return out;
}
// Back inside 90 days only when the rank dropped: both measured, the new
// position number bigger than the old one.
function seenVerdict(prev, rank) {
  if (!prev) return { keep: true };
  const now = num(rank);
  if (prev.rank != null && now != null && now > prev.rank) return { keep: true, back: `its rank dropped from ${prev.rank} to ${now}` };
  return { keep: false, why: `suggested in the last ${SEEN_DAYS} days (card #${prev.card})` };
}

// A live post that already covers the keyword: every word of the keyword is in
// one post line of the WordPress read.
function coveredByPost(keyword, postsText) {
  const words = seenMem.norm(keyword).split(' ').filter((w) => w.length > 2);
  if (!words.length) return null;
  for (const line of String(postsText || '').split('\n')) {
    const l = ` ${seenMem.norm(line)} `;
    if (words.every((w) => l.includes(` ${w} `))) return line.trim().slice(0, 140);
  }
  return null;
}

function cell(v) { return String(v == null ? '' : v).replace(/\|/g, '/').replace(/\n+/g, ' ').trim(); }

function tableOf(topics) {
  const head = '| # | Topic | Target keyword | Venue or brand | Monthly volume | Difficulty | Our rank | Source | Why now |\n|---|---|---|---|---|---|---|---|---|';
  return head + '\n' + topics.map((t) => `| ${t.n} | ${cell(t.topic)} | ${cell(t.keyword)} | ${cell(t.venue)} | ${cell(t.volume)} | ${cell(t.difficulty)} | ${cell(t.rank)} | ${cell(t.source)} | ${cell(t.why_now)} |`).join('\n');
}

// The one card, checked. ctx: { got, store, now, log, ownedKeywords }.
//   got: this run's sources ({ label, type, text, path? }).
async function finishCard(card, { got = [], store = null, now = new Date(), log = () => {}, owned = null } = {}) {
  const drafted = parseTopics(card.body);
  if (!drafted.length) { log(`${SLUG}: no topic table on the card; saved as drafted`); return card; }
  const texts = got.map((g) => g.text);
  const master = got.find((g) => String(g.label || '').includes(VENUE_MASTER) || String(g.path || '').includes(VENUE_MASTER));
  const venues = master ? canonicalVenues(master.text) : new Map();
  const posts = got.filter((g) => g.type === 'wp_posts').map((g) => g.text).join('\n');
  let mapOwned = owned;
  if (!mapOwned) {
    const map = got.find((g) => /KEYWORD_MAP\.md/.test(String(g.label || g.path || '')));
    mapOwned = map ? require('./agent-chains').ownedKeywords(map.text) : new Set();
  }
  const earlier = store && store.list
    ? (await Promise.all(['draft', 'ready', 'rejected', 'archived'].map((s) => store.list({ status: s, agent: SLUG, limit: 200, includeReference: true })))).flat()
    : [];
  const recent = recentTopics(earlier, now);
  const kept = [];
  const dropped = [];
  const blanks = [];
  const thisRun = new Set();
  for (const t0 of drafted) {
    const venue = master ? venueOf(t0.venue, venues) : null;
    if (!master) { dropped.push({ keyword: t0.keyword, why: `${VENUE_MASTER} was not read this run, so no venue could be checked` }); continue; }
    if (!venue) { dropped.push({ keyword: t0.keyword, why: `"${t0.venue || 'no venue'}" is not a venue in ${VENUE_MASTER} or one of our brands` }); continue; }
    const key = topicKey(venue, t0.keyword);
    if (thisRun.has(key)) { dropped.push({ keyword: t0.keyword, why: 'listed twice on this card' }); continue; }
    if (mapOwned.has(require('./agent-chains').normKeyword(t0.keyword))) { dropped.push({ keyword: t0.keyword, why: 'the keyword map already gives it to a page' }); continue; }
    const post = coveredByPost(t0.keyword, posts);
    if (post) { dropped.push({ keyword: t0.keyword, why: `a live post already covers it (${post})` }); continue; }
    if (store && store.seenCards && (await store.seenCards('bloggy-bob', [require('./agent-chains').bobKey(t0.keyword)])).length) {
      dropped.push({ keyword: t0.keyword, why: 'Bloggy Bob already drafted it' }); continue;
    }
    const { topic, blanked } = checkFigures({ ...t0, venue }, texts);
    const sv = seenVerdict(recent.get(key), topic.rank);
    if (!sv.keep) { dropped.push({ keyword: t0.keyword, why: sv.why }); continue; }
    if (kept.length >= MAX_TOPICS) { dropped.push({ keyword: t0.keyword, why: `over ${MAX_TOPICS} for one week` }); continue; }
    thisRun.add(key);
    if (blanked.length) blanks.push(`${t0.keyword}: ${blanked.join(', ')}`);
    kept.push({ ...topic, n: kept.length + 1, key, ...(sv.back ? { back: sv.back } : {}) });
  }
  // Her own words above and below the table stay; the table is the checked one.
  const lines = String(card.body).split('\n');
  const first = lines.findIndex((l) => l.trim().startsWith('|'));
  let last = first;
  while (last + 1 < lines.length && lines[last + 1].trim().startsWith('|')) last++;
  const before = first > 0 ? lines.slice(0, first).join('\n').trim() : '';
  const after = first >= 0 ? lines.slice(last + 1).join('\n').trim() : '';
  const notes = ['### Checked by the Box',
    `${kept.length} topic${kept.length === 1 ? '' : 's'} kept of ${drafted.length} drafted. A figure is shown only when the same number is on a source line that names the keyword; anything else is blank.`];
  if (blanks.length) notes.push(`Blanked (not found in a source this run): ${blanks.join('; ')}.`);
  for (const t of kept) if (t.back) notes.push(`Back inside ${SEEN_DAYS} days: ${t.keyword}, ${t.back}.`);
  if (dropped.length) notes.push('Not suggested:\n' + dropped.map((d) => `- ${d.keyword}: ${d.why}`).join('\n'));
  log(`${SLUG}: ${kept.length} topics kept, ${dropped.length} dropped, ${blanks.length} with blanked figures`);
  return { ...card,
    body: [before, kept.length ? tableOf(kept) : 'No topic passed the checks this week.', after, notes.join('\n\n')].filter(Boolean).join('\n\n'),
    topics: kept.map(({ back, ...t }) => t) };
}

// Approving one topic: exactly one queued Bloggy Bob run, ever, per card topic.
async function approveTopic({ card, n, who, store, env = process.env }) {
  if (!queenOn(env)) return { error: 'not turned on', status: 404 };
  if (!who) return { error: 'no person to record', status: 403 };
  if (!card || card.agent !== SLUG) return { error: 'no such Keyword Queen card', status: 404 };
  if (!['draft', 'ready'].includes(card.status)) return { error: 'this card was already rejected or archived', status: 409 };
  const topics = (card.payload && card.payload.topics) || [];
  const t = topics.find((x) => Number(x.n) === Number(n));
  if (!t) return { error: 'no such topic on this card', status: 404 };
  const figures = [t.volume ? `monthly volume ${t.volume}` : null, t.difficulty ? `difficulty ${t.difficulty}` : null].filter(Boolean);
  const ask = `keyword: ${t.keyword} · site: ${t.venue} · post type: blog post\n\n`
    + `Topic: ${t.topic || t.keyword}\nWhy now: ${t.why_now || '(not given)'}\n`
    + (figures.length ? `${figures.join(', ')} (source: ${t.source})\n` : 'No measured volume or difficulty for this keyword.\n')
    + `\nApproved by ${who} from Keyword Queen card #${card.id}, topic ${t.n} (ORDER #3163). `
    + 'A draft only: Approve on the Review tab saves an unpublished WordPress draft, and a person publishes.';
  const { PRIORITY } = require('./producer');
  const r = await store.chainRun({ chain: CHAIN, key: `card-${card.id}:${t.n}`, agent: 'bloggy-bob', ask, fromCard: card.id,
    priority: PRIORITY.person, requestedBy: who });
  if (!r.request) return { already: true, why: r.skipped };
  return { request: r.request };
}

// Which topics of a card are already queued for Bob.
async function queuedTopics(card, store) {
  const topics = (card && card.payload && card.payload.topics) || [];
  if (!topics.length || !store.chainKeys) return [];
  const rows = await store.chainKeys(CHAIN, topics.map((t) => `card-${card.id}:${t.n}`));
  return rows.map((r) => Number(String(r.key).split(':').pop()));
}

module.exports = { SLUG, FLAG, CHAIN, MAX_TOPICS, SEEN_DAYS, BRANDS, queenOn, canonicalVenues, venueOf, parseTopics, checkFigures,
  keywordLines, recentTopics, seenVerdict, coveredByPost, topicKey, tableOf, finishCard, approveTopic, queuedTopics };
