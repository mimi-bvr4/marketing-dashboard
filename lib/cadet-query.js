// ORDER #3617: the Archivist (collateral-cadet) reads a PLAIN QUESTION.
// On 11.19.2026 Katherine typed "where is The Estate at Cherokee Dock pricing
// listed?" and got 0 sites: the search matched the whole sentence literally.
//
// parseQuery() turns what she typed into one of two shapes:
//   { mode: 'phrase', phrase }   a plain phrase ("bridal suite"): matched exactly,
//                                as before (#1688). Nothing about it changes.
//   { mode: 'question', phrase, venues, groups }
//                                a question: filler words dropped, any venue it
//                                names found by its canonical name, and each
//                                remaining word expanded to its related forms.
// It is a question when a filler word was dropped, a venue was named, or it ends
// in "?". A line answers it when it holds one form of every word group (whole
// words only); on a site that is not the named venue's own, the line must also
// name the venue. A line holding the whole typed phrase always counts.
//
// 🔴 VENUES ARE NEVER GUESSED. Names, aliases and codes come only from
// 05_AI_and_Brain/Venue_Master_CANONICAL.md (test/order3617_... checks every one
// against it). Two venues named: both are scoped, neither is picked.
'use strict';

const { VENUES } = require('./pinterest-venues');

const norm = (s) => String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Words that carry no meaning in a search: question words and glue.
const FILLER = new Set(('where is are was were be listed list lists find found show shows tell me us the a an '
  + 'what which who how many much do does did we have has our ours it its of on in at to for about any there '
  + 'can could i you your please info information look looking see get go give mention mentioned mentions page and or vs versus between compare')
  .split(' '));

// A short list of words and their related forms (#3617 Build 1). Only these
// expand; any other word is matched as itself.
const RELATED = [
  ['pricing', 'price', 'prices', 'priced', 'rate', 'rates', 'cost', 'costs'],
  ['capacity', 'guests', 'guest', 'seated', 'seats', 'seating', 'accommodate', 'accommodates'],
  ['parking', 'park', 'parked'],
  ['catering', 'caterer', 'caterers', 'catered'],
  ['lodging', 'overnight', 'accommodations'],
  ['deposit', 'deposits', 'retainer'],
  ['minimum', 'minimums'],
  ['ceremony', 'ceremonies'],
  ['availability', 'available'],
  ['alcohol', 'beverage', 'beverages', 'liquor'],
];
const formsOf = (w) => RELATED.find((g) => g.includes(w)) || [w];

// Every name below is written in Venue_Master_CANONICAL.md (its table, its
// NAMING LAW, its drift aliases). The first is the live public name, used as the
// WordPress search term on other sites. SWF's "The Estate at ..." rename is not
// live yet but is matched, so a question in the new name still finds the venue.
const ALIASES = {
  TBB: ['The Bridge Building', 'The Bridge Building Event Spaces', 'Bridge Building'],
  TBT: ['The Bell Tower', 'Bell Tower'],
  ECD: ['The Estate at Cherokee Dock', 'Estate at Cherokee Dock', 'Cherokee Dock'],
  SWF: ['Saddle Woods Farm', 'The Estate at Saddle Woods Farm', 'Saddlewood Farm'],
  STE: ['Saint Elle', 'St. Elle', 'St Elle'],
  COR: ['The Cordelle', 'Cordelle'],
  EST: ['Estelle'],
};
// Drift codes the canonical file maps on sight: COD is COR; BBC/BBD/BBO are spaces in TBB.
const CODE_ALIASES = { COD: 'COR', BBC: 'TBB', BBD: 'TBB', BBO: 'TBB' };

function venueOf(code) {
  const v = VENUES.find((x) => x.code === code);
  return { code, name: v ? v.name : ALIASES[code][0], site: v ? v.site : null, names: ALIASES[code] };
}

// Every venue named in `text`: { code, at, len } spans. Names match in any case
// on word boundaries; a code counts only in capitals ("ECD", never "est").
function venueSpans(text) {
  const spans = [];
  for (const [code, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const m = new RegExp(`(?<![A-Za-z0-9])${esc(n)}(?![A-Za-z0-9])`, 'i').exec(text);
      if (m) spans.push({ code, at: m.index, len: m[0].length });
    }
  }
  for (const c of [...Object.keys(ALIASES), ...Object.keys(CODE_ALIASES)]) {
    const m = new RegExp(`(?<![A-Za-z0-9])${c}(?![A-Za-z0-9])`).exec(text);
    if (m) spans.push({ code: CODE_ALIASES[c] || c, at: m.index, len: m[0].length });
  }
  return spans;
}

function parseQuery(raw) {
  const phrase = norm(raw);
  // Blank out each venue name, longest first, so its words are not searched.
  let rest = phrase;
  const codes = [];
  for (const s of venueSpans(phrase).sort((a, b) => b.len - a.len)) {
    if (rest.slice(s.at, s.at + s.len).trim() !== phrase.slice(s.at, s.at + s.len).trim()) continue; // overlaps a longer name
    rest = rest.slice(0, s.at) + ' '.repeat(s.len) + rest.slice(s.at + s.len);
    if (!codes.includes(s.code)) codes.push(s.code);
  }
  const words = rest.toLowerCase().replace(/[^a-z0-9'&-]+/g, ' ').split(' ').map((w) => w.replace(/^['-]+|['-]+$/g, '')).filter(Boolean);
  const kept = [...new Set(words.filter((w) => !FILLER.has(w)))];
  const question = kept.length < words.length || codes.length > 0 || /\?\s*$/.test(phrase);
  if (!question || (!kept.length && !codes.length)) return { mode: 'phrase', phrase };
  return { mode: 'question', phrase, venues: codes.map(venueOf), groups: kept.map(formsOf) };
}

const isOwn = (query, site) => !!site && (query.venues || []).some((v) => v.site === site);

// (line) => where the answer starts in it, or -1. `site` is the website the line
// came from (null for a material).
function lineMatcher(query, { site = null, own = null } = {}) {
  const needle = query.phrase.toLowerCase();
  if (query.mode !== 'question') return (line) => String(line).toLowerCase().indexOf(needle);
  const home = own == null ? isOwn(query, site) : own;
  const wordRe = (list) => new RegExp(`(?<![A-Za-z0-9])(?:${list.map(esc).join('|')})(?![A-Za-z0-9])`, 'i');
  const groups = query.groups.map(wordRe);
  const venue = query.venues.length ? wordRe(query.venues.flatMap((v) => v.names)) : null;
  return (raw) => {
    const line = String(raw);
    const exact = line.toLowerCase().indexOf(needle);
    if (exact >= 0) return exact;
    let at = -1;
    for (const re of groups) { const m = re.exec(line); if (!m) return -1; if (at < 0 || m.index < at) at = m.index; }
    if (venue && (!home || !groups.length)) { const m = venue.exec(line); if (!m) return -1; if (at < 0) at = m.index; }
    return at;
  };
}

const MAX_TERMS = 8;
// What to hand a site's own search (WordPress ANDs every word of a term).
// The named venue's own site, or no venue: one term per combination of related
// forms, at most 8. Another site when a venue is named: the venue's name.
function searchTerms(query, site) {
  if (query.mode !== 'question') return [query.phrase];
  if ((query.venues.length && !isOwn(query, site)) || !query.groups.length) {
    return [...new Set(query.venues.map((v) => v.names[0].replace(/^The /, '')))];
  }
  let acc = [[]];
  for (const g of query.groups) {
    const next = [];
    for (const p of acc) for (const f of g) next.push([...p, f]);
    acc = next.slice(0, MAX_TERMS);
  }
  return acc.map((a) => a.join(' '));
}

module.exports = { parseQuery, lineMatcher, searchTerms, isOwn, venueSpans, FILLER, RELATED, ALIASES, CODE_ALIASES, MAX_TERMS };
