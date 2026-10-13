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
// Returns { lines: the first `max` quotes, count: every line that holds it }.
function findLines(text, phrase, max = MAX_QUOTES) {
  const needle = norm(phrase).toLowerCase();
  const out = [];
  let count = 0;
  if (!needle) return { lines: out, count };
  for (const raw of String(text || '').split(/\r?\n|(?<=[.!?])\s+(?=[A-Z0-9"])/)) {
    const line = norm(raw);
    const at = line.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    count += 1;
    if (out.length >= max) continue;
    if (line.length <= QUOTE_CHARS) { out.push(line); continue; }
    const from = Math.max(0, at - Math.floor((QUOTE_CHARS - needle.length) / 2));
    out.push(`${from > 0 ? '...' : ''}${line.slice(from, from + QUOTE_CHARS).trim()}${from + QUOTE_CHARS < line.length ? '...' : ''}`);
  }
  return { lines: out, count };
}

// ------------------------------------------------------------ the materials

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const ALL_DRIVES = { corpora: 'allDrives', includeItemsFromAllDrives: true, supportsAllDrives: true };

// Drive's text index, once per search: the ids of every file the Brain can see
// that holds the phrase. A refusal means the index could not be asked.
async function indexMatches(drive, phrase) {
  try {
    const r = await drive.listPage({ ...ALL_DRIVES, q: `fullText contains '"${q(phrase)}"' and trashed = false`, fields: 'files(id)' });
    return { ids: new Set((r.files || []).map((f) => f.id)) };
  } catch (e) { return { error: e.message }; }
}

// The file a material points at: its link on the map, or (no link) a file the
// Brain can see with exactly that name.
async function resolve(m, drive) {
  const link = m.link || { kind: 'none' };
  if (link.kind === 'canva') return { not_checked: 'a Canva design: the Box has no Canva connection that can read a design\'s text yet' };
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

async function checkFile(f, phrase, drive, index) {
  const at = { file: f.name, url: f.webViewLink || null };
  const exportAs = NATIVE[f.mimeType];
  if (exportAs) {
    try {
      const { lines, count } = findLines(await drive.exportText(f.id, exportAs), phrase);
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

async function searchMaterials(materials, phrase, drive) {
  const index = drive ? await indexMatches(drive, phrase) : { error: 'no Drive client' };
  const out = [];
  for (const m of materials) {
    const base = { company: m.company, section: m.section, title: m.title, archived: !!m.archived };
    if (!drive) { out.push({ ...base, status: 'NOT CHECKED', why: 'Drive is read on the Box only, and this run had no Drive client' }); continue; }
    const r = await resolve(m, drive);
    if (r.not_checked) { out.push({ ...base, status: 'NOT CHECKED', why: r.not_checked }); continue; }
    const files = [];
    for (const f of r.files) files.push(await checkFile(f, phrase, drive, index));
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
    if (count) hits.push({ page: pathOf(r.url || u), url: r.url || u, title, lines, count });
  }
  return { hits, read, failed };
}

// WordPress: its own search finds the pages and posts that hold every word;
// each one is then read as the public page and the exact phrase quoted.
async function searchWordPress(site, phrase, ctx) {
  const r = await get(`https://${site}/wp-json/wp/v2/search?search=${encodeURIComponent(phrase)}&per_page=${MAX_WP_HITS}&_fields=url,title,subtype`, ctx);
  if (r.status !== 200) return { site, platform: 'WordPress', status: 'NOT CHECKED', why: `WordPress search answered ${r.status || r.error}` };
  let list;
  try { list = JSON.parse(r.body); } catch (e) { return { site, platform: 'WordPress', status: 'NOT CHECKED', why: 'WordPress search did not answer in JSON' }; }
  const urls = [...new Set((Array.isArray(list) ? list : []).map((x) => x.url).filter(Boolean))];
  const p = await pagesWithPhrase(urls, phrase, ctx);
  const how = `WordPress search of page and post text (${urls.length} candidate${urls.length === 1 ? '' : 's'}); headers, footers and menus are not searched`;
  if (p.hits.length) return { site, platform: 'WordPress', status: 'FOUND', how, pages: p.hits, failed: p.failed };
  if (p.failed.length) return { site, platform: 'WordPress', status: 'NOT CHECKED', how, why: `${p.failed.length} candidate page(s) did not load: ${p.failed.slice(0, 3).join(', ')}` };
  return { site, platform: 'WordPress', status: 'NOT FOUND', how };
}

// Squarespace has no search API: the Cadet reads the pages its sitemap lists.
async function searchSquarespace(site, phrase, ctx) {
  const sm = await get(`https://${site}/sitemap.xml`, ctx);
  const locs = sm.status === 200 ? [...new Set([...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((x) => x[1]))] : [];
  if (!locs.length) return { site, platform: 'Squarespace', status: 'NOT CHECKED', why: `no sitemap to read (${sm.status || sm.error})` };
  const urls = locs.slice(0, MAX_PAGES);
  const p = await pagesWithPhrase(urls, phrase, ctx);
  const how = `read ${p.read} of ${locs.length} page(s) in the sitemap${locs.length > MAX_PAGES ? ` (first ${MAX_PAGES} only)` : ''}`;
  if (p.hits.length) return { site, platform: 'Squarespace', status: 'FOUND', how, pages: p.hits, failed: p.failed };
  if (p.failed.length || locs.length > MAX_PAGES) return { site, platform: 'Squarespace', status: 'NOT CHECKED', how, why: p.failed.length ? `${p.failed.length} page(s) did not load` : `the site has more than ${MAX_PAGES} pages; the rest were not read` };
  return { site, platform: 'Squarespace', status: 'NOT FOUND', how };
}

async function searchSites(phrase, ctx) {
  const out = [];
  for (const site of [...WP_SITES]) out.push(await searchWordPress(site, phrase, ctx));
  for (const site of SQUARESPACE_SITES) out.push(await searchSquarespace(site, phrase, ctx));
  return out;
}

// ------------------------------------------------------------ one search

async function search({ phrase, materials, drive, fetch = globalThis.fetch, now = () => new Date() }) {
  const p = checkPhrase(phrase);
  if (p.error) return { error: p.error };
  const mats = await searchMaterials(materials || [], p.phrase, drive);
  const sites = await searchSites(p.phrase, { fetch });
  const tally = (list) => ({ found: list.filter((x) => x.status === 'FOUND').length, not_found: list.filter((x) => x.status === 'NOT FOUND').length,
    not_checked: list.filter((x) => x.status === 'NOT CHECKED').length });
  return { phrase: p.phrase, searched_at: now().toISOString(), materials: mats, sites, tally: { materials: tally(mats), sites: tally(sites) } };
}

// The text for Dispatch's Change Log "Other places" box: one place per line.
function changeLogPlaces(result) {
  const lines = [];
  for (const m of result.materials || []) if (m.status === 'FOUND') lines.push(`${m.title} (${m.company})`);
  for (const s of result.sites || []) for (const pg of s.pages || []) lines.push(`${s.site}${pg.page}`);
  return lines;
}

module.exports = { search, searchMaterials, searchSites, searchWordPress, searchSquarespace, findLines, checkPhrase, resolve, rollUp, decode,
  changeLogPlaces, SQUARESPACE_SITES, MAX_PAGES, UA };
