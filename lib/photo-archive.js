// ORDER #1008: the searchable photo archive, DECISION CORE.
//
// Pure functions only. Nothing here calls Drive, the vision model, the sheet or
// Postgres: the crawl hands in a `listPage` function, the rights rule is handed
// the sheet rows, and the page hands in photo rows. That is what makes every
// rule in the order testable without a network, and it is the same shape as
// #1007's `marketing_sheet.js` in planning.
//
// 🔴 THE THREE LAWS THIS FILE CARRIES, so a later client cannot forget them:
//   1. DRIVE_SCOPES is drive.readonly and nothing else (Amendment A). The service
//      account is fileOrganizer on the folder; read-only is enforced HERE.
//   2. listAll() follows nextPageToken until it is empty (Amendment B). A first
//      page is how SWF and STE went missing on 09.29.
//   3. Staff Photos is never walked (step 2). It is HR's, not sales material.
'use strict';

const { GROUPS, SYNONYMS, EVENT_CLASSES, CONSUMABLES } = require('./photo-vocabulary');

const DRIVE_SCOPES = Object.freeze(['https://www.googleapis.com/auth/drive.readonly']);
const ROOT_FOLDER_ID = '1zCNAoygAzceS6ZH6Lt0Y691l5o2nv3uL';          // Marketing / Photo + Video
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const EXCLUDED_TOP = ['staff photos'];
const DRIVE_FIELDS = 'nextPageToken, files(id, name, mimeType, size, md5Checksum, '
  + 'createdTime, parents, trashed, thumbnailLink, imageMediaMetadata(width, height, time), '
  + 'videoMediaMetadata(width, height))';

// Venue_Master_CANONICAL.md, including its drift aliases.
const VENUES = ['ECD', 'TBT', 'TBB', 'COR', 'EST', 'STE', 'SWF'];
const VENUE_ALIASES = { COD: 'COR', BBC: 'TBB', BBD: 'TBB', BBO: 'TBB' };
const ELLE_VENUES = ['COR', 'EST', 'STE'];
const TOP_BRANDS = { venues: 'IH', nlp: 'NLP', culinary: 'culinary', 'misc.': null };

function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- the crawl

// Every Drive list call, paged to the end. `listPage(params)` resolves to the
// files.list body: { files, nextPageToken }.
async function listAll(listPage, params) {
  const out = [];
  const seen = new Set();
  let pageToken;
  do {
    const body = await listPage({
      ...params,
      fields: DRIVE_FIELDS,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...((body && body.files) || []));
    pageToken = body && body.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw new Error(`Drive returned page token ${pageToken} twice`);
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  return out;
}

// Walk the tree under the root. Returns every non-folder file with the folder
// names above it, plus the run's counts. A folder that fails to list is counted
// and logged, and the walk goes on: one bad folder must not hide the rest.
async function crawlTree(listPage, rootId = ROOT_FOLDER_ID) {
  const files = [];
  const failed = [];
  const skipped = [];
  const venueCounts = {};
  const queue = [{ id: rootId, path: [] }];
  while (queue.length) {
    const folder = queue.shift();
    let children;
    try {
      children = await listAll(listPage, { q: `'${folder.id}' in parents and trashed = false` });
    } catch (e) {
      failed.push({ path: folder.path.join(' / ') || '(root)', error: String(e.message || e) });
      continue;
    }
    for (const c of children) {
      if (c.mimeType === FOLDER_MIME) {
        if (folder.path.length === 0 && EXCLUDED_TOP.includes(norm(c.name))) { skipped.push(c.name); continue; }
        const path = [...folder.path, c.name];
        if (path.length === 2 && norm(path[0]) === 'venues') venueCounts[c.name] = venueCounts[c.name] || 0;
        queue.push({ id: c.id, path });
      } else {
        files.push({ ...c, path: folder.path });
        if (folder.path.length >= 2 && norm(folder.path[0]) === 'venues') {
          venueCounts[folder.path[1]] = (venueCounts[folder.path[1]] || 0) + 1;
        }
      }
    }
  }
  return { files, failed, skipped, venueCounts };
}

// Compare the index as it was with the listing as it is now.
function diffIndex(previous, current) {
  const prev = new Map(previous.map((r) => [r.id, r]));
  const now = new Map(current.map((f) => [f.id, f]));
  const counts = { seen: current.length, new: 0, moved: 0, removed: 0, failed: 0 };
  const removed = [];
  for (const [id, f] of now) {
    const p = prev.get(id);
    if (!p) counts.new += 1;
    else if (p.path.join('/') !== f.path.join('/')) counts.moved += 1;
  }
  for (const id of prev.keys()) if (!now.has(id)) { counts.removed += 1; removed.push(id); }
  return { counts, removed };
}

// Nightly: one entry of the Drive changes feed -> what the index does with it.
function changeAction(change, indexed) {
  if (change.removed || !change.file || change.file.trashed) return indexed ? 'remove' : 'ignore';
  if (change.file.mimeType === FOLDER_MIME) return 'rewalk';
  return indexed ? 'refresh' : 'add';
}

// ---------------------------------------------------------------- the path

const GUEST_BAND = [
  [/^under (\d+)$/, (m) => `under ${m[1]}`],
  [/^(\d+) ?(?:to )?(\d+)$/, (m) => `${m[1]}-${m[2]}`],
  [/^(\d+) ?\+$/, (m) => `${m[1]}+`],
];
const EVENT_TYPE_WORDS = /\b(wedding|reception|ceremony|corporate|with a band|gala|nonprofit|fundraiser|social|holiday|school|prom|graduation|birthday|anniversary|shower|rehearsal|memorial)\b/;
const SETUP_WORDS = /^(cocktail|seated|plated|buffet|family style|banquet|theater|classroom|boardroom|u shape|hollow square|cabaret|reception standing|standing|lounge)$/;

function guestBand(seg) {
  const n = norm(seg).replace(/\s*\+\s*$/, '+');
  for (const [re, f] of GUEST_BAND) { const m = n.match(re); if (m) return f(m); }
  return null;
}

function eventClass(value) {
  const n = norm(value);
  if (!n) return null;
  if (/wedding|ceremony|rehearsal/.test(n)) return 'wedding';
  if (/corporate/.test(n)) return 'corporate';
  if (/gala|nonprofit|fundraiser/.test(n)) return 'nonprofit / gala';
  if (/holiday/.test(n)) return 'holiday';
  if (/school|prom|graduation/.test(n)) return 'school';
  if (/social|birthday|anniversary|shower|memorial/.test(n)) return 'social';
  return null;
}

function venueCode(seg) {
  const up = String(seg).trim().toUpperCase();
  if (VENUES.includes(up)) return up;
  return VENUE_ALIASES[up] || null;
}

// `segments` are the folder names under Photo + Video, top first.
// Each segment is placed by its DEPTH and its VALUE. One that fits no field, or
// a field already filled, becomes a plain tag and is reported in `unparsed`.
function parsePath(segments) {
  const out = {
    brand: null, venue: null, space: null, event_type: null, event_class: null,
    setup: null, guest_band: null, path_tags: [], unparsed: [], excluded: false,
  };
  if (!segments.length) return out;
  const top = norm(segments[0]);
  if (EXCLUDED_TOP.includes(top)) { out.excluded = true; return out; }
  if (Object.prototype.hasOwnProperty.call(TOP_BRANDS, top)) out.brand = TOP_BRANDS[top];
  else out.unparsed.push({ depth: 0, segment: segments[0], why: 'unknown top folder, brand unknown' });

  const miss = (depth, segment, why) => {
    out.unparsed.push({ depth, segment, why });
    const t = norm(segment);
    if (t && !out.path_tags.includes(t)) out.path_tags.push(t);
  };
  segments.slice(1).forEach((seg, i) => {
    const depth = i + 1;
    if (top === 'venues' && depth === 1) {
      const v = venueCode(seg);
      if (v) { out.venue = v; if (ELLE_VENUES.includes(v)) out.brand = 'Elle'; }
      else miss(depth, seg, 'not a venue code in Venue_Master_CANONICAL.md');
      return;
    }
    const n = norm(seg);
    const band = guestBand(seg);
    let field = null;
    if (band) field = ['guest_band', band];
    else if (EVENT_TYPE_WORDS.test(n)) field = ['event_type', String(seg).trim()];
    else if (SETUP_WORDS.test(n)) field = ['setup', String(seg).trim()];
    else if (top === 'venues' && depth === 2) field = ['space', String(seg).trim()];
    if (!field) return miss(depth, seg, 'fits no field');
    if (out[field[0]] != null) return miss(depth, seg, `${field[0]} already set to "${out[field[0]]}"`);
    out[field[0]] = field[1];
  });
  out.event_class = eventClass(out.event_type);
  return out;
}

// A folder or file that carries its HubSpot deal id. Never a name: #1008 step 4.
function dealIdFrom(names) {
  for (const n of names) {
    const s = String(n);
    const labelled = s.match(/deal\s*id\s*[:#_-]?\s*(\d{6,})/i);
    if (labelled) return labelled[1];
    if (/^\d{8,}$/.test(s.trim())) return s.trim();
  }
  return null;
}

// ---------------------------------------------------------------- dates, shape

const SEASONS = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'fall', 'fall', 'fall', 'winter'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// EXIF arrives as "2023:06:10 18:22:01". The date is read from the text, never
// through a Date, so a late-evening photo is not moved a day by a timezone.
function dateFacets(exifTime, createdTime) {
  let m = exifTime && String(exifTime).match(/^(\d{4})[:-](\d{2})[:-](\d{2})/);
  let source = 'exif';
  if (!m || m[1] === '0000') { m = createdTime && String(createdTime).match(/^(\d{4})-(\d{2})-(\d{2})/); source = 'drive_created'; }
  if (!m) return { taken_date: null, taken_source: null, month: null, season: null, year: null };
  const mo = Number(m[2]);
  return {
    taken_date: `${m[1]}-${m[2]}-${m[3]}`, taken_source: source,
    month: MONTHS[mo - 1], season: SEASONS[mo - 1], year: Number(m[1]),
  };
}

function orientation(w, h) {
  if (!w || !h) return null;
  if (w === h) return 'square';
  return w > h ? 'landscape' : 'portrait';
}

// One row per unique file. The same bytes in two folders show once, with both paths.
function dedupeByChecksum(files) {
  const byKey = new Map();
  for (const f of files) {
    const key = f.md5Checksum ? `md5:${f.md5Checksum}` : `id:${f.id}`;
    const p = f.path.join(' / ');
    if (!byKey.has(key)) byKey.set(key, { ...f, paths: [p], ids: [f.id] });
    else { const r = byKey.get(key); if (!r.paths.includes(p)) r.paths.push(p); r.ids.push(f.id); }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------- vocabulary

function splitTerm(term) {
  const parts = term.split(' / ').map((s) => s.trim()).filter(Boolean);
  return { tag: parts[0], synonyms: parts.slice(1) };
}

// Build the lookup: normalized word -> the tag it shows as. `items` is #1009's
// list, read-only: [{ house_name, synonyms, consumable }]. A synonym claimed by
// two different tags is REFUSED for both and reported, never picked.
function buildVocabulary({ groups = GROUPS, synonyms = SYNONYMS, items = [] } = {}) {
  const tags = new Map();        // norm(tag) -> { tag, group }
  const lookup = new Map();      // norm(word) -> tag
  const conflicts = [];
  const claim = (word, tag) => {
    const k = norm(word);
    if (!k) return;
    if (lookup.has(k) && lookup.get(k) !== tag) { conflicts.push({ word, tags: [lookup.get(k), tag] }); lookup.set(k, null); return; }
    if (!lookup.has(k)) lookup.set(k, tag);
  };
  for (const [group, terms] of Object.entries(groups)) {
    for (const term of terms) {
      const { tag, synonyms: syns } = splitTerm(term);
      tags.set(norm(tag), { tag, group });
      claim(tag, tag);
      syns.forEach((s) => claim(s, tag));
    }
  }
  for (const it of items) {
    if (!it || it.consumable || !it.house_name) continue;
    if (CONSUMABLES.some((c) => norm(it.house_name).includes(c))) continue;
    tags.set(norm(it.house_name), { tag: it.house_name, group: 'item' });
    claim(it.house_name, it.house_name);
    (it.synonyms || []).forEach((s) => claim(s, it.house_name));
  }
  for (const [word, tag] of Object.entries(synonyms)) claim(word, tag);
  for (const [k, v] of lookup) if (v === null) lookup.delete(k);
  return { tags, lookup, conflicts };
}

function canonicalTag(vocab, word) {
  return vocab.lookup.get(norm(word)) || null;
}

// Every word that means the same tag, the tag itself included.
function equivalents(vocab, tag) {
  const out = [];
  for (const [k, v] of vocab.lookup) if (v === tag) out.push(k);
  return out;
}

// ---------------------------------------------------------------- AI tags

const MAX_FREE_TAGS = 3;
const IDENTITY = /\b(name|named|face|faces|identity|ethnic|ethnicity|race|racial|religion|religious|years old|aged|celebrity|mr|mrs|ms|miss)\b/;

// What the vision model returned -> the tags it is allowed to keep.
// Vocabulary words land on their shown tag. Free text is kept only lowercase,
// short, capped, and never about who a person is. Consumables never survive.
function screenAiTags(vocab, raw) {
  const kept = new Map();
  const dropped = [];
  let free = 0;
  for (const t of raw || []) {
    const word = t && t.tag;
    const conf = Number(t && t.confidence) || 0;
    const n = norm(word);
    if (!n) continue;
    if (CONSUMABLES.some((c) => n.includes(c))) { dropped.push({ tag: word, why: 'consumable' }); continue; }
    if (IDENTITY.test(n)) { dropped.push({ tag: word, why: 'identifies a person' }); continue; }
    // The model sometimes echoes the prompt's group: "setting: night". The
    // group is not part of the tag, so a vocabulary word after it still lands
    // (#1278 sample: 12 tags on 3 photos were dropped as free text this way).
    const canon = canonicalTag(vocab, word) || (n.includes(':') ? canonicalTag(vocab, n.slice(n.lastIndexOf(':') + 1)) : null);
    if (canon) { if (!kept.has(canon) || kept.get(canon) < conf) kept.set(canon, conf); continue; }
    if (word !== String(word).toLowerCase() || !/^[a-z][a-z '&]{1,40}$/.test(n) || n.split(' ').length > 3) {
      dropped.push({ tag: word, why: 'free text must be short and lowercase' }); continue;
    }
    if (free >= MAX_FREE_TAGS) { dropped.push({ tag: word, why: `more than ${MAX_FREE_TAGS} free-text tags` }); continue; }
    free += 1;
    kept.set(n, conf);
  }
  return { tags: [...kept].map(([tag, confidence]) => ({ tag, confidence })), dropped };
}

// Final tags = AI + human added - human removed. A human edit always wins, and a
// removed tag stays removed however often the AI re-tags the photo.
function finalTags({ ai = [], added = [], removed = [], minConfidence = 0 }) {
  const gone = new Set(removed.map(norm));
  const out = [];
  const push = (t) => { if (!gone.has(norm(t)) && !out.some((o) => norm(o) === norm(t))) out.push(t); };
  added.forEach(push);
  ai.filter((t) => t.confidence >= minConfidence).forEach((t) => push(t.tag));
  return out;
}

// One tag edit by Katherine or Sam. Adding un-removes; removing un-adds.
function applyTagEdit(state, action, tag) {
  const k = norm(tag);
  const added = (state.added || []).filter((t) => norm(t) !== k);
  const removed = (state.removed || []).filter((t) => norm(t) !== k);
  if (action === 'add') added.push(tag);
  else if (action === 'remove') removed.push(tag);
  else throw new Error(`unknown tag edit "${action}"`);
  return { ...state, added, removed };
}

// ---------------------------------------------------------------- rights

const COOL_HEADER = 'cool with using photos';
const NOTES_SAY_NO = /\b(avoid|don'?t|don t|do not|never)\b[\w\s]{0,20}\b(photos?|pictures?|pics|images?)\b|\bno (photos?|pictures?|pics|images?)\b/;

function sheetValue(row, headerStart) {
  for (const [k, v] of Object.entries(row || {})) if (norm(k).startsWith(headerStart)) return v;
  return undefined;
}

// `rowsByDealId` is #1007's reader output keyed by DEALID. There is no name
// parameter on purpose: a photo is never matched to an event by its name.
// `venuesDefault` is 'cleared' until Katherine confirms (UNVERIFIED in #1008).
function rightsFor({ topFolder, dealId, rowsByDealId = {}, manualInternal = false, venuesDefault = 'cleared' }) {
  if (manualInternal) return { state: 'internal_only', reason: 'set to internal only by hand' };
  if (dealId) {
    const row = rowsByDealId[dealId];
    if (!row) return { state: 'unknown', reason: `DEALID ${dealId} is not on the marketing sheet` };
    const cool = norm(sheetValue(row, COOL_HEADER));
    const notes = norm(sheetValue(row, 'notes'));
    if (/^no\b/.test(cool)) return { state: 'internal_only', reason: 'sheet: client is not cool with photo use' };
    if (NOTES_SAY_NO.test(notes)) return { state: 'internal_only', reason: 'sheet Notes say not to use photos' };
    if (/^yes\b/.test(cool)) return { state: 'cleared', reason: 'sheet: client is cool with photo use' };
    return { state: 'unknown', reason: 'sheet row does not say yes or no' };
  }
  if (norm(topFolder) === 'venues') {
    return venuesDefault === 'cleared'
      ? { state: 'cleared', reason: "Venues folder, Katherine's curated sales set (default awaiting her confirmation)" }
      : { state: 'unknown', reason: 'Venues folder with no event link' };
  }
  return { state: 'unknown', reason: 'no event link' };
}

const BADGES = { internal_only: "Internal only, don't send to clients", unknown: 'Check with marketing', cleared: null };
const canDownload = (state) => state === 'cleared';

// ---------------------------------------------------------------- search

const FACETS = ['venue', 'space', 'event_type', 'event_class', 'setup', 'guest_band',
  'season', 'month', 'year', 'brand', 'photographer', 'orientation', 'rights_state'];

function haystack(photo) {
  const parts = [...(photo.tags || []), photo.name,
    ...['venue', 'space', 'event_type', 'event_class', 'setup', 'brand'].map((f) => photo[f])];
  return ` ${parts.filter(Boolean).map(norm).join(' | ')} `;
}

function hasPhrase(hay, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(hay);
}

// A query is one or more parts split on "+" or ","; every part must match.
// A part that is a vocabulary word searches its whole synonym family, so
// "media wall" and "step and repeat" return exactly the same set.
function matches(vocab, photo, query) {
  const parts = String(query || '').split(/[+,]/).map(norm).filter(Boolean);
  if (!parts.length) return true;
  const hay = haystack(photo);
  return parts.every((p) => {
    const tag = canonicalTag(vocab, p);
    const needles = tag ? equivalents(vocab, tag) : [p];
    if (tag && !needles.includes(norm(tag))) needles.push(norm(tag));
    return needles.some((n) => hasPhrase(hay, n));
  });
}

function passesFilters(photo, filters, except) {
  return Object.entries(filters || {}).every(([f, v]) => {
    if (f === except || v == null || v === '' || (Array.isArray(v) && !v.length)) return true;
    const want = Array.isArray(v) ? v.map(String) : [String(v)];
    return want.includes(String(photo[f]));
  });
}

// Results plus a count for every filter value. Each facet is counted with the
// OTHER filters applied, so picking TBT does not zero out every other venue.
function search(vocab, photos, { q, filters = {} } = {}) {
  const hits = photos.filter((p) => matches(vocab, p, q));
  const results = hits.filter((p) => passesFilters(p, filters));
  const facets = {};
  for (const f of FACETS) {
    const counts = {};
    for (const p of hits) {
      if (p[f] == null || !passesFilters(p, filters, f)) continue;
      counts[p[f]] = (counts[p[f]] || 0) + 1;
    }
    facets[f] = counts;
  }
  return { results, facets };
}

module.exports = {
  DRIVE_SCOPES, ROOT_FOLDER_ID, FOLDER_MIME, DRIVE_FIELDS, EVENT_CLASSES, BADGES, FACETS,
  norm, listAll, crawlTree, diffIndex, changeAction,
  parsePath, venueCode, guestBand, eventClass, dealIdFrom, dateFacets, orientation, dedupeByChecksum,
  buildVocabulary, canonicalTag, equivalents, screenAiTags, finalTags, applyTagEdit,
  rightsFor, canDownload, matches, search,
};
