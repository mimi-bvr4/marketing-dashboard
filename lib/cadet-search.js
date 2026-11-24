// ORDER #1688: the Collateral Cadet's "where does this appear?" Katherine types
// a phrase; the Cadet looks for it in every material on the Collateral Map it
// can read and on our 11 public websites, and answers with each place and the
// line quoted.
//
// 🔴 THE LAWS THIS FILE CARRIES:
//   1. READ-ONLY. Drive is read with the drive.readonly token (GETs only, the
//      #1239 client); websites are read as public pages, like a visitor. Nothing
//      here edits, sends or publishes.
//   2. NEVER CLEAN BY DEFAULT. A material the Cadet could not read is NOT
//      CHECKED with the reason, never "not found". Only text the Cadet actually
//      read can say NOT FOUND.
//   3. A Drive file that is not a Google Doc, Sheet or Slides (a PDF, a Word
//      file, an image) is matched through Drive's own text index. A match is
//      FOUND (no quote: open the file to see where); no match is NOT CHECKED,
//      because the index misses image-only pages.
'use strict';

const { pageFacts } = require('./agent-sources');
const { WP_SITES } = require('./wp-draft');
const { SHEET_ID } = require('./collateral-map');
// ORDER #3617: a plain question ("where is The Estate at Cherokee Dock pricing
// listed?") is parsed into words, related forms and a named venue; a plain
// phrase stays an exact phrase. See lib/cadet-query.js.
const Q = require('./cadet-query');
const asQuery = (x) => (x && typeof x === 'object' && x.mode ? x : Q.parseQuery(x));
const MAP_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const CANVA_WHY = "a Canva design: the Archivist can't open Canva yet (open it from the Collateral Map Sheet)";
const CANVA_CANT_OPEN = "brain@ can't open this one"; // #3622, the same words as lib/canva.js CANT_OPEN

const UA = 'IHG-Brain-CollateralCadet/1.0 (+brain@infinityhospitality.net)';
const SQUARESPACE_SITES = ['thecordelle.com', 'thesaintelle.com', 'estellenashville.com'];
const MAX_PAGES = 60;          // a Squarespace site is read from its sitemap, this many pages at most
const MAX_WP_HITS = 25;        // pages WordPress's own search hands back, per site
const MAX_QUOTES = 5;          // lines quoted per place
const QUOTE_CHARS = 220;
const NATIVE = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

const norm = (s) => String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim();

// Page text arrives with HTML entities ("Wine &amp; Bar"): decode the common
// ones so a phrase matches what a visitor reads.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...' };
function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n === 8211 || n === 8212 ? '-' : String.fromCodePoint(n); }
    return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
  });
}

// A phrase Katherine may search: 2 to 120 characters, something to match.
function checkPhrase(raw) {
  const p = norm(raw);
  if (p.length < 2) return { error: 'type a word or phrase to look for' };
  if (p.length > 120) return { error: 'keep it under 120 characters' };
  return { phrase: p };
}

// Every line of `text` that holds the phrase (any case), cut to a readable
// quote around it. A "line" is a line break, or a sentence in running text.
// `phrase` may instead be a matcher, (line) => index or -1 (#3617, a question).
// Returns { lines: the first `max` quotes, count: every line that holds it }.
function findLines(text, phrase, max = MAX_QUOTES) {
  const fn = typeof phrase === 'function';
  const needle = fn ? '' : norm(phrase).toLowerCase();
  const out = [];
  let count = 0;
  if (!fn && !needle) return { lines: out, count };
  const span = fn ? 20 : needle.length;
  for (const raw of String(text || '').split(/\r?\n|(?<=[.!?])\s+(?=[A-Z0-9"])/)) {
    const line = norm(raw);
    if (!line) continue;
    const at = fn ? phrase(line) : line.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    count += 1;
    if (out.length >= max) continue;
    if (line.length <= QUOTE_CHARS) { out.push(line); continue; }
    const from = Math.max(0, at - Math.floor((QUOTE_CHARS - span) / 2));
    out.push(`${from > 0 ? '...' : ''}${line.slice(from, from + QUOTE_CHARS).trim()}${from + QUOTE_CHARS < line.length ? '...' : ''}`);
  }
  return { lines: out, count };
}

// ------------------------------------------------------------ the materials

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const ALL_DRIVES = { corpora: 'allDrives', includeItemsFromAllDrives: true, supportsAllDrives: true };

// Drive's text index, once per search: the ids of every file the Brain can see
// that holds the phrase. A refusal means the index could not be asked.
// A question (#3617) asks for files holding one form of every word group (or,
// with no words left, the venue's name).
function indexQuery(query) {
  if (query.mode !== 'question') return `fullText contains '"${q(query.phrase)}"'`;
  if (!query.groups.length) return `(${query.venues.map((v) => `fullText contains '"${q(v.names[0])}"'`).join(' or ')})`;
  return query.groups.map((g) => `(${g.map((f) => `fullText contains '${q(f)}'`).join(' or ')})`).join(' and ');
}

async function indexMatches(drive, phrase) {
  try {
    const r = await drive.listPage({ ...ALL_DRIVES, q: `${indexQuery(asQuery(phrase))} and trashed = false`, fields: 'files(id)' });
    return { ids: new Set((r.files || []).map((f) => f.id)) };
  } catch (e) { return { error: e.message }; }
}

// The file a material points at: its link on the map, or (no link) a file the
// Brain can see with exactly that name.
async function resolve(m, drive) {
  const link = m.link || { kind: 'none' };
  if (link.kind === 'canva') return { not_checked: CANVA_WHY, canva: true };
  if (link.kind === 'other') return { not_checked: `links to ${link.uri}, which is not a Drive file or a Canva design` };
  if (link.kind === 'drive' && link.type === 'folder') return { not_checked: 'links to a Drive folder, not one file' };
  if (link.kind === 'drive') {
    try { const f = await drive.getFile(link.id, 'id, name, mimeType, trashed, webViewLink'); return f.trashed ? { not_checked: 'the linked file is in the trash' } : { files: [f], via: 'link' }; }
    catch (e) { return { not_checked: `the linked file is not shared with the Brain (${e.message})` }; }
  }
  try {
    const r = await drive.listPage({ ...ALL_DRIVES, q: `name = '${q(m.title)}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`, fields: 'files(id, name, mimeType, webViewLink)' });
    const files = r.files || [];
    if (!files.length) return { not_checked: 'no link on the Collateral Map, and no file with this exact name is shared with the Brain' };
    return { files: files.slice(0, 3), via: 'name' };
  } catch (e) { return { not_checked: `Drive could not be asked (${e.message})` }; }
}

async function checkFile(f, phrase, drive, index, match = null) {
  const at = { file: f.name, url: f.webViewLink || null };
  const exportAs = NATIVE[f.mimeType];
  if (exportAs) {
    try {
      const { lines, count } = findLines(await drive.exportText(f.id, exportAs), match || phrase);
      return count ? { ...at, status: 'FOUND', lines, count } : { ...at, status: 'NOT FOUND' };
    } catch (e) { return { ...at, status: 'NOT CHECKED', why: `could not read its text (${e.message})` }; }
  }
  if (index.error) return { ...at, status: 'NOT CHECKED', why: `a ${f.mimeType} file, and Drive's text index could not be asked (${index.error})` };
  if (index.ids.has(f.id)) return { ...at, status: 'FOUND', lines: [], why: "Drive's text index matched it; open the file to see where" };
  return { ...at, status: 'NOT CHECKED', why: `a ${f.mimeType} file the Cadet cannot read itself; Drive's text index did not match it, which is not proof it is clean` };
}

// Worst of the files wins for the material's own status: FOUND beats all; a
// NOT CHECKED file keeps the material from reading NOT FOUND.
function rollUp(files) {
  if (files.some((f) => f.status === 'FOUND')) return 'FOUND';
  if (files.some((f) => f.status === 'NOT CHECKED')) return 'NOT CHECKED';
  return 'NOT FOUND';
}

// A material is the named venue's own when its title names the venue or starts
// with its code ("ECD Venue Guide"): then, like the venue's own site, a line
// need not repeat the venue's name.
function ownMaterial(query, title) {
  return (query.venues || []).some((v) => new RegExp(`^${v.code}\\b`).test(title)
    || v.names.some((n) => String(title).toLowerCase().includes(n.toLowerCase())));
}

// ORDER #3622: a Canva material, read through the Box's Canva reader (lib/canva.js)
// when CADET_CANVA_READ is on. Not signed in: #3617's honest line, unchanged. A
// design brain@ can't open is listed by the map's own title, never a guessed name.
async function checkCanva(m, base, query, canva) {
  const c = await canva.read(m);
  if (c.off) return { ...base, status: 'NOT CHECKED', why: CANVA_WHY, canva: true };
  if (c.denied) return { ...base, status: 'NOT CHECKED', why: CANVA_CANT_OPEN, canva_cant_open: true };
  if (c.not_checked) return { ...base, status: 'NOT CHECKED', why: c.not_checked };
  const match = query.mode === 'question' ? Q.lineMatcher(query, { own: ownMaterial(query, m.title) }) : query.phrase;
  const at = { file: `${m.title} (Canva)`, url: m.link.uri || null };
  const { lines, count } = findLines(c.text, match);
  const f = count ? { ...at, status: 'FOUND', lines, count } : { ...at, status: 'NOT FOUND' };
  return { ...base, status: f.status, via: 'canva', files: [f] };
}

async function searchMaterials(materials, phrase, drive, canva = null) {
  const query = asQuery(phrase);
  const text = query.phrase;
  const index = drive ? await indexMatches(drive, query) : { error: 'no Drive client' };
  const out = [];
  for (const m of materials) {
    const base = { company: m.company, section: m.section, title: m.title, archived: !!m.archived };
    if (!drive) { out.push({ ...base, status: 'NOT CHECKED', why: 'Drive is read on the Box only, and this run had no Drive client' }); continue; }
    const r = await resolve(m, drive);
    if (r.canva && canva) { out.push(await checkCanva(m, base, query, canva)); continue; }
    if (r.not_checked) { out.push({ ...base, status: 'NOT CHECKED', why: r.not_checked, ...(r.canva ? { canva: true } : {}) }); continue; }
    const match = query.mode === 'question' ? Q.lineMatcher(query, { own: ownMaterial(query, m.title) }) : null;
    const files = [];
    for (const f of r.files) files.push(await checkFile(f, text, drive, index, match));
    out.push({ ...base, status: rollUp(files), via: r.via, files });
  }
  return out;
}

// ------------------------------------------------------------ the websites

async function get(url, ctx) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ctx.timeoutMs || 20000);
  try {
    const r = await ctx.fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctl.signal });
    return { status: r.status, url: r.url || url, body: await r.text() };
  } catch (e) {
    return { status: 0, url, body: '', error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(t); }
}

const pathOf = (u) => { try { return new URL(u).pathname || '/'; } catch (e) { return u; } };

async function pagesWithPhrase(urls, phrase, ctx) {
  const hits = [];
  let read = 0;
  const failed = [];
  for (const u of urls) {
    const r = await get(u, ctx);
    if (r.status !== 200) { failed.push(`${pathOf(u)} (${r.status || r.error})`); continue; }
    read += 1;
    // The quote comes from the body; the <head> (title, meta) is not page copy.
    const title = decode(pageFacts(r.body).title);
    const { lines, count } = findLines(decode(pageFacts(r.body.replace(/<head[\s\S]*?<\/head>/i, ' ').replace(/<title[\s\S]*?<\/title>/gi, ' ')).text), phrase);
    // #3617: `line` is the one matching sentence shown beside the link.
    if (count) hits.push({ page: pathOf(r.url || u), url: r.url || u, title, line: lines[0], lines, count });
  }
  return { hits, read, failed };
}

const siteMatcher = (query, site) => (query.mode === 'question' ? Q.lineMatcher(query, { site }) : query.phrase);

// WordPress: its own search finds the pages and posts that hold every word;
// each one is then read as the public page and the exact phrase quoted.
// #3617: a question is asked as a few short terms (Q.searchTerms), never as the
// whole sentence, because WordPress search ANDs every word it is given.
async function searchWordPress(site, phrase, ctx) {
  const query = asQuery(phrase);
  const terms = Q.searchTerms(query, site);
  const found = [];
  let answered = 0;
  let lastWhy = null;
  for (const term of terms) {
    const r = await get(`https://${site}/wp-json/wp/v2/search?search=${encodeURIComponent(term)}&per_page=${MAX_WP_HITS}&_fields=url,title,subtype`, ctx);
    if (r.status !== 200) { lastWhy = `WordPress search answered ${r.status || r.error}`; continue; }
    let list;
    try { list = JSON.parse(r.body); } catch (e) { lastWhy = 'WordPress search did not answer in JSON'; continue; }
    answered += 1;
    for (const x of (Array.isArray(list) ? list : [])) if (x.url) found.push(x.url);
  }
  const venueSite = Q.isOwn(query, site) ? { venue_site: true } : {};
  if (!answered) return { site, platform: 'WordPress', status: 'NOT CHECKED', ...venueSite, why: lastWhy };
  const urls = [...new Set(found)].slice(0, MAX_WP_HITS);
  const p = await pagesWithPhrase(urls, siteMatcher(query, site), ctx);
  const asked = query.mode === 'question' ? ` for ${terms.map((t) => `"${t}"`).join(', ')}` : '';
  const how = `WordPress search of page and post text${asked} (${urls.length} candidate${urls.length === 1 ? '' : 's'}); headers, footers and menus are not searched`;
  if (answered < terms.length && !p.hits.length) return { site, platform: 'WordPress', status: 'NOT CHECKED', ...venueSite, how, why: `${terms.length - answered} of ${terms.length} searches did not answer (${lastWhy})` };
  if (p.hits.length) return { site, platform: 'WordPress', status: 'FOUND', ...venueSite, how, pages: p.hits, failed: p.failed };
  if (p.failed.length) return { site, platform: 'WordPress', status: 'NOT CHECKED', ...venueSite, how, why: `${p.failed.length} candidate page(s) did not load: ${p.failed.slice(0, 3).join(', ')}` };
  return { site, platform: 'WordPress', status: 'NOT FOUND', ...venueSite, how };
}

// Squarespace has no search API: the Cadet reads the pages its sitemap lists.
async function searchSquarespace(site, phrase, ctx) {
  const query = asQuery(phrase);
  const venueSite = Q.isOwn(query, site) ? { venue_site: true } : {};
  const sm = await get(`https://${site}/sitemap.xml`, ctx);
  const locs = sm.status === 200 ? [...new Set([...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((x) => x[1]))] : [];
  if (!locs.length) return { site, platform: 'Squarespace', status: 'NOT CHECKED', ...venueSite, why: `no sitemap to read (${sm.status || sm.error})` };
  const urls = locs.slice(0, MAX_PAGES);
  const p = await pagesWithPhrase(urls, siteMatcher(query, site), ctx);
  const how = `read ${p.read} of ${locs.length} page(s) in the sitemap${locs.length > MAX_PAGES ? ` (first ${MAX_PAGES} only)` : ''}`;
  if (p.hits.length) return { site, platform: 'Squarespace', status: 'FOUND', ...venueSite, how, pages: p.hits, failed: p.failed };
  if (p.failed.length || locs.length > MAX_PAGES) return { site, platform: 'Squarespace', status: 'NOT CHECKED', ...venueSite, how, why: p.failed.length ? `${p.failed.length} page(s) did not load` : `the site has more than ${MAX_PAGES} pages; the rest were not read` };
  return { site, platform: 'Squarespace', status: 'NOT FOUND', ...venueSite, how };
}

// #3617: a venue named in the question has its own site searched first.
async function searchSites(phrase, ctx) {
  const query = asQuery(phrase);
  const all = [...[...WP_SITES].map((site) => ({ site, wp: true })), ...SQUARESPACE_SITES.map((site) => ({ site, wp: false }))];
  const ordered = [...all.filter((s) => Q.isOwn(query, s.site)), ...all.filter((s) => !Q.isOwn(query, s.site))];
  const out = [];
  for (const s of ordered) out.push(s.wp ? await searchWordPress(s.site, query, ctx) : await searchSquarespace(s.site, query, ctx));
  return out;
}

// ------------------------------------------------------------ one search

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The one-line summary the page shows for a search (#3617). Canva materials say
// why they were not read, never a bare "not checked".
// #3622: a Canva design brain@ can't open is named by its map title.
function summaryLine(t, canva = 0, cantOpen = []) {
  const parts = [`${plural(t.materials.found, 'material', 'materials')} and ${plural(t.sites.found, 'site', 'sites')} found`];
  const other = t.materials.not_checked - canva - cantOpen.length + t.sites.not_checked;
  if (other > 0) parts.push(`${plural(other, 'other place', 'other places')} not checked`);
  let line = `${parts.join('; ')}.`;
  if (cantOpen.length) line += ` ${plural(cantOpen.length, 'Canva design', 'Canva designs')} brain@ can't open: ${cantOpen.join('; ')}.`;
  if (!canva) return line;
  return `${line} ${canva === 1 ? "1 material not read: it is a Canva design, and the Archivist can't open Canva yet."
    : `${canva} materials not read: they are Canva designs, and the Archivist can't open Canva yet.`}`;
}

// The answer itself, one line: the first matching sentence, the named venue's
// own site first, then any other site, then a material.
function answerLine(mats, sites) {
  for (const s of sites) for (const pg of s.pages || []) if (pg.line) return `${s.site}${pg.page}: ${pg.line}`;
  for (const m of mats) for (const f of m.files || []) if ((f.lines || [])[0]) return `${m.title} (${m.company}): ${f.lines[0]}`;
  return null;
}

// `canva` (#3622): the Box's Canva reader, passed only while CADET_CANVA_READ is on.
async function search({ phrase, materials, drive, fetch = globalThis.fetch, now = () => new Date(), canva = null }) {
  const p = checkPhrase(phrase);
  if (p.error) return { error: p.error };
  const query = Q.parseQuery(p.phrase);
  const mats = await searchMaterials(materials || [], query, drive, canva);
  const sites = await searchSites(query, { fetch });
  const tally = (list) => ({ found: list.filter((x) => x.status === 'FOUND').length, not_found: list.filter((x) => x.status === 'NOT FOUND').length,
    not_checked: list.filter((x) => x.status === 'NOT CHECKED').length });
  const t = { materials: tally(mats), sites: tally(sites) };
  const unread = mats.filter((m) => m.canva).length;
  const cantOpen = mats.filter((m) => m.canva_cant_open);
  t.summary = summaryLine(t, unread, cantOpen.map((m) => m.title));
  t.answer = answerLine(mats, sites);
  if (unread || cantOpen.length) t.map_url = MAP_URL;
  const out = { phrase: p.phrase, searched_at: now().toISOString(), materials: mats, sites, tally: t };
  if (query.mode === 'question') out.understood = { venues: query.venues.map((v) => v.code), words: query.groups.map((g) => g[0]) };
  return out;
}

// The draft Dispatch's Change Log form fills itself from (#1688). With `after`
// (#2902, a fact Katherine marked changed) the title names the new wording, so
// the entry arrives pre-filled with old -> new; Dispatch's form reads `title`
// and `before` today and ignores `after` until it learns it. An area owner still
// approves the entry before staff see it (ruling 10.13); nothing is posted here.
const CHANGE_LOG_PLACES = 40;
function changeLogDraft(result, { bucket = 'marketing', after = null } = {}) {
  const found = (result.materials || []).filter((m) => m.status === 'FOUND');
  const d = {
    from: 'cadet',
    bucket: ['marketing', 'menus'].includes(bucket) ? bucket : 'marketing',
    title: (after ? `Change "${result.phrase}" to "${after}"` : `Change "${result.phrase}"`).slice(0, 160),
    before: result.phrase,
    collateral: found.map((m) => ({ company: m.company, title: m.title })),
    places: changeLogPlaces({ sites: result.sites }).slice(0, CHANGE_LOG_PLACES),
  };
  if (after) d.after = String(after).slice(0, 600);
  return d;
}

// The text for Dispatch's Change Log "Other places" box: one place per line.
function changeLogPlaces(result) {
  const lines = [];
  for (const m of result.materials || []) if (m.status === 'FOUND') lines.push(`${m.title} (${m.company})`);
  for (const s of result.sites || []) for (const pg of s.pages || []) lines.push(`${s.site}${pg.page}`);
  return lines;
}

module.exports = { changeLogDraft, search, searchMaterials, searchSites, searchWordPress, searchSquarespace, findLines, checkPhrase, resolve, rollUp, decode,
  changeLogPlaces, summaryLine, answerLine, SQUARESPACE_SITES, MAX_PAGES, UA, MAP_URL };
