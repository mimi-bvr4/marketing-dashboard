'use strict';
// ORDER #3617: the Archivist (collateral-cadet) answers a PLAIN QUESTION.
// On 11.19.2026 Katherine typed "where is The Estate at Cherokee Dock pricing
// listed?" and got "0 materials and 0 sites found; 114 not checked": the search
// matched the whole sentence literally (WordPress search ANDs every word, and
// findLines looked for the sentence itself). Now filler words drop, a named
// venue's own site is searched first, a short list of words expands to related
// forms, each hit carries its one matching sentence, and the 114 Canva materials
// say why they were not read. Read-only: public pages and Drive GETs only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Q = require('../lib/cadet-query');
const C = require('../lib/cadet-search');
const { SHEET_ID } = require('../lib/collateral-map');

const KATHERINE = 'where is The Estate at Cherokee Dock pricing listed?';
const ECD_SENTENCE = 'Sunday through Thursday events are priced significantly lower than Friday and Saturday events.';
const ECD_QUESTION = 'Does The Estate at Cherokee Dock offer lower pricing for weekday events or off-peak seasons?';

// Our sites as a visitor sees them. WordPress search here behaves like the real
// one measured on 11.19.2026: it ANDs every word, so the whole sentence finds
// nothing, while "pricing" / "priced" / "price" / "rates" find /faqs/.
function fakeWeb() {
  const seen = [];
  const wpHits = {
    'cherokeedock.com': { pricing: ['/faqs/'], priced: ['/faqs/'], price: ['/faqs/'], rates: ['/faqs/', '/weddings/'] },
    'infinityhospitalitygroup.com': { pricing: ['/catering/'], 'estate at cherokee dock': ['/venues/'] },
    'thebridgebuilding.com': { 'bridal suite': ['/the-bridge-building-faqs/'] },
  };
  const pages = {
    'https://cherokeedock.com/faqs/': `<html><head><title>FAQs</title></head><body><h2>Pricing</h2><p>${ECD_QUESTION} Yes. ${ECD_SENTENCE}</p><p>Every moment here is priceless.</p></body></html>`,
    'https://cherokeedock.com/weddings/': '<html><body><p>Ask about our rates for the Mansion.</p></body></html>',
    'https://infinityhospitalitygroup.com/catering/': '<html><body><p>Catering pricing starts with a tasting.</p></body></html>',
    'https://infinityhospitalitygroup.com/venues/': '<html><body><p>The Estate at Cherokee Dock is on Old Hickory Lake.</p><p>Pricing at The Estate at Cherokee Dock varies by day of the week.</p></body></html>',
    'https://thebridgebuilding.com/the-bridge-building-faqs/': '<html><body><p>The bridal suite has a private restroom.</p></body></html>',
  };
  return {
    seen,
    async fetch(url) {
      seen.push(url);
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      if (u.pathname === '/wp-json/wp/v2/search') {
        const term = u.searchParams.get('search').toLowerCase();
        const list = ((wpHits[host] || {})[term] || []).map((p) => ({ url: `https://${host}${p}`, title: 'x', subtype: 'page' }));
        return { status: 200, url, text: async () => JSON.stringify(list) };
      }
      if (u.pathname === '/sitemap.xml') return { status: 404, url, text: async () => '' };
      if (pages[url]) return { status: 200, url, text: async () => pages[url] };
      return { status: 404, url, text: async () => '' };
    },
  };
}

const canvaMaterial = (i) => ({ company: 'IHG', section: 'Venue Guides', title: `Guide ${i}`, archived: false, link: { kind: 'canva', uri: `https://canva.link/x${i}` } });
const nullDrive = { async listPage() { return { files: [] }; }, async getFile() { throw new Error('no'); }, async exportText() { return ''; } };

test('parse: Katherine\'s question drops the filler, finds ECD by its canonical name, and expands "pricing"', () => {
  const q = Q.parseQuery(KATHERINE);
  assert.strictEqual(q.mode, 'question');
  assert.deepStrictEqual(q.venues.map((v) => v.code), ['ECD']);
  assert.strictEqual(q.venues[0].site, 'cherokeedock.com');
  assert.strictEqual(q.groups.length, 1, JSON.stringify(q.groups));
  for (const f of ['pricing', 'price', 'priced', 'rates', 'cost']) assert.ok(q.groups[0].includes(f), f);
  for (const w of ['where', 'is', 'listed', 'the', 'estate', 'cherokee', 'dock']) assert.ok(!q.groups.flat().includes(w), w);
});

test('parse: a plain phrase stays an exact phrase (no regression for "bridal suite", "sparkling white wine")', () => {
  assert.deepStrictEqual(Q.parseQuery('bridal suite'), { mode: 'phrase', phrase: 'bridal suite' });
  assert.deepStrictEqual(Q.parseQuery('sparkling white wine'), { mode: 'phrase', phrase: 'sparkling white wine' });
  assert.strictEqual(Q.parseQuery('what do we have').mode, 'phrase', 'all filler: nothing to look for but the phrase itself');
});

test('parse: venues come only from the canonical names and codes; drift aliases map; nothing is guessed', () => {
  assert.deepStrictEqual(Q.parseQuery('Bell Tower capacity?').venues.map((v) => v.code), ['TBT']);
  assert.deepStrictEqual(Q.parseQuery('what is the COD parking').venues.map((v) => v.code), ['COR']);
  assert.deepStrictEqual(Q.parseQuery('Saddlewood Farm guests?').venues.map((v) => v.code), ['SWF']);
  assert.deepStrictEqual(Q.parseQuery('compare The Bell Tower and The Bridge Building capacity').venues.map((v) => v.code).sort(), ['TBB', 'TBT']);
  assert.deepStrictEqual(Q.parseQuery('where is the estate pricing?').venues, [], '"estate" alone names no venue');
  assert.deepStrictEqual(Q.parseQuery('is est pricing listed?').venues, [], 'a code counts only in capitals');
});

test('every venue name and alias the Archivist knows is written in Venue_Master_CANONICAL.md', (t) => {
  const tree = process.env.IHG_TREE || path.join(os.homedir(), 'Full_IH_Project');
  const file = path.join(tree, '05_AI_and_Brain', 'Venue_Master_CANONICAL.md');
  if (!fs.existsSync(file)) return t.skip('canonical venue file not on this machine');
  const canon = fs.readFileSync(file, 'utf8');
  for (const [code, names] of Object.entries(Q.ALIASES)) {
    assert.match(canon, new RegExp(`\\*\\*${code}\\*\\*`), `${code} is not a canonical code`);
    for (const n of names) assert.ok(canon.includes(n), `${n} (${code}) is not in the canonical file`);
  }
  for (const [alias, code] of Object.entries(Q.CODE_ALIASES)) { assert.ok(canon.includes(alias), alias); assert.ok(Q.ALIASES[code], code); }
});

test('lines: related forms match whole words only, and a line on another venue\'s site must name the venue', () => {
  const q = Q.parseQuery(KATHERINE);
  const own = Q.lineMatcher(q, { site: 'cherokeedock.com' });
  const other = Q.lineMatcher(q, { site: 'infinityhospitalitygroup.com' });
  assert.ok(own(ECD_SENTENCE) >= 0);
  assert.ok(own('Ask about our rates.') >= 0);
  assert.strictEqual(own('This day is priceless.'), -1, 'priceless is not price');
  assert.strictEqual(other('Catering pricing starts with a tasting.'), -1, 'pricing on another site that does not name ECD is not an answer');
  assert.ok(other('Pricing at The Estate at Cherokee Dock varies by day of the week.') >= 0);
});

test('Katherine\'s exact query: ECD\'s own site is searched first and its FAQ sentence is FOUND, one line per hit', async () => {
  const web = fakeWeb();
  const r = await C.search({ phrase: KATHERINE, materials: [], drive: nullDrive, fetch: web.fetch });
  assert.strictEqual(r.phrase, KATHERINE, 'the typed question is kept as asked');
  assert.strictEqual(r.sites[0].site, 'cherokeedock.com', 'the named venue\'s site comes first');
  assert.strictEqual(r.sites[0].venue_site, true);
  assert.strictEqual(r.sites[0].status, 'FOUND');
  const faq = r.sites[0].pages.find((p) => p.page === '/faqs/');
  assert.ok(faq, JSON.stringify(r.sites[0]));
  assert.ok(faq.lines.includes(ECD_SENTENCE), JSON.stringify(faq.lines));
  assert.ok(faq.lines.some((l) => l.includes(ECD_QUESTION)), 'the page text runs the heading into this sentence, so it is contained, not equal');
  assert.ok(!faq.lines.some((l) => /priceless/.test(l)));
  assert.strictEqual(typeof faq.line, 'string', 'each hit carries its one matching sentence');
  assert.ok(faq.lines.includes(faq.line));
  const ihg = r.sites.find((s) => s.site === 'infinityhospitalitygroup.com');
  assert.deepStrictEqual(ihg.pages.map((p) => [p.page, p.line]), [['/venues/', 'Pricing at The Estate at Cherokee Dock varies by day of the week.']]);
  assert.strictEqual(r.sites.length, 11, 'all 11 sites are still asked');
  assert.match(r.tally.answer, /cherokeedock\.com\/faqs\/: /);
  assert.ok(r.tally.answer.includes(ECD_QUESTION) || r.tally.answer.includes(ECD_SENTENCE));
  assert.ok(!web.seen.some((u) => u.includes(encodeURIComponent('where is'))), 'the whole sentence is never sent to WordPress search');
});

test('"bridal suite" is still the exact phrase: WordPress is asked for exactly that and the hit is quoted', async () => {
  const web = fakeWeb();
  const sites = await C.searchSites('bridal suite', { fetch: web.fetch });
  const tbb = sites.find((s) => s.site === 'thebridgebuilding.com');
  assert.strictEqual(tbb.status, 'FOUND');
  assert.strictEqual(tbb.pages[0].line, 'The bridal suite has a private restroom.');
  const wpTerms = web.seen.filter((u) => u.includes('/wp-json/')).map((u) => new URL(u).searchParams.get('search'));
  assert.ok(wpTerms.length === 8 && wpTerms.every((t) => t === 'bridal suite'), JSON.stringify(wpTerms));
});

test('honest Canva line: "114 materials not read: they are Canva designs, and the Archivist can\'t open Canva yet." with the Sheet', async () => {
  const mats = Array.from({ length: 114 }, (_, i) => canvaMaterial(i));
  const r = await C.search({ phrase: KATHERINE, materials: mats, drive: nullDrive, fetch: fakeWeb().fetch });
  assert.strictEqual(r.tally.materials.not_checked, 114);
  assert.ok(r.materials.every((m) => m.canva === true));
  assert.match(r.tally.summary, /114 materials not read: they are Canva designs, and the Archivist can't open Canva yet\./);
  assert.ok(!/114 not checked/.test(r.tally.summary));
  assert.strictEqual(r.tally.map_url, `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
  assert.strictEqual(C.summaryLine({ materials: { found: 0, not_found: 0, not_checked: 1 }, sites: { found: 1, not_found: 0, not_checked: 0 } }, 1),
    "0 materials and 1 site found. 1 material not read: it is a Canva design, and the Archivist can't open Canva yet.");
  assert.strictEqual(C.summaryLine({ materials: { found: 1, not_found: 0, not_checked: 3 }, sites: { found: 2, not_found: 0, not_checked: 1 } }, 2),
    "1 material and 2 sites found; 2 other places not checked. 2 materials not read: they are Canva designs, and the Archivist can't open Canva yet.");
  assert.strictEqual(C.summaryLine({ materials: { found: 0, not_found: 1, not_checked: 0 }, sites: { found: 0, not_found: 11, not_checked: 0 } }, 0),
    '0 materials and 0 sites found.');
});

test('the page shows the stored summary, the one-line answer and a pointer to the Collateral Map Sheet', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'cadet.html'), 'utf8');
  assert.match(html, /t\.summary/);
  assert.match(html, /t\.answer|tally\.answer/);
  assert.match(html, /map_url/);
  assert.match(html, /Open the Collateral Map Sheet/);
});
