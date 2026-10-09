// ORDER #1008: the searchable photo archive, decision core.
//
// Every fixture below is invented. Folder names copy the REAL tree's shape as
// the order read it live on 09.29 (Venues / TBT / Patio / Wedding Reception /
// Cocktail / 100-200), but no client, guest or deal from the sheet is here.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/photo-archive');

const vocab = A.buildVocabulary({
  items: [
    { house_name: 'Fruitwood Chiavari Chair', synonyms: ['chiavari', 'chiavari chair'] },
    { house_name: 'Wooden Crossback Chair', synonyms: ['cross back chair'] },
    { house_name: 'Boxwood Wall', synonyms: ['greenery wall'] },
    { house_name: 'House Red Wine', synonyms: ['red wine'], consumable: true },
  ],
});

// ------------------------------------------------------------ the three laws

test('LAW: the crawler asks for drive.readonly and NOTHING else (Amendment A)', () => {
  assert.deepStrictEqual([...A.DRIVE_SCOPES], ['https://www.googleapis.com/auth/drive.readonly']);
  assert.ok(Object.isFrozen(A.DRIVE_SCOPES), 'the scope list must not be appendable at runtime');
});

test('LAW: listAll reads the SECOND page, and every call passes both shared-drive flags (Amendment B)', async () => {
  const calls = [];
  const pages = {
    undefined: { files: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' },
    p2: { files: [{ id: 'SWF' }, { id: 'STE' }] },
  };
  const files = await A.listAll(async (params) => { calls.push(params); return pages[params.pageToken]; }, { q: 'x' });
  assert.deepStrictEqual(files.map((f) => f.id), ['a', 'b', 'SWF', 'STE']);
  assert.strictEqual(calls.length, 2);
  for (const c of calls) {
    assert.strictEqual(c.supportsAllDrives, true);
    assert.strictEqual(c.includeItemsFromAllDrives, true);
    assert.match(c.fields, /nextPageToken/, 'without nextPageToken in fields Drive never returns one');
  }
});

test('KNOWN-BAD: a page token Drive repeats is refused, not looped on forever', async () => {
  await assert.rejects(A.listAll(async () => ({ files: [], nextPageToken: 'same' }), {}), /twice/);
});

// A tiny tree: root -> Venues (TBT, SWF-empty, a paged folder), Staff Photos, NLP.
function fakeDrive() {
  const F = A.FOLDER_MIME;
  const kids = {
    root: [[{ id: 'ven', name: 'Venues', mimeType: F }, { id: 'staff', name: 'Staff Photos', mimeType: F }], [{ id: 'nlp', name: 'NLP', mimeType: F }]],
    ven: [[{ id: 'tbt', name: 'TBT', mimeType: F }], [{ id: 'swf', name: 'SWF', mimeType: F }, { id: 'ste', name: 'STE', mimeType: F }]],
    tbt: [[{ id: 'patio', name: 'Patio', mimeType: F }]],
    patio: [[{ id: 'p1', name: 'IMG_1.jpg', mimeType: 'image/jpeg', md5Checksum: 'x1' }]],
    swf: [[]],
    ste: [[{ id: 's1', name: 'IMG_9.jpg', mimeType: 'image/jpeg', md5Checksum: 'x1' }]],
    staff: [[{ id: 'hr1', name: 'headshot.jpg', mimeType: 'image/jpeg' }]],
    nlp: null,                                     // this folder fails to list
  };
  const listed = [];
  const listPage = async (params) => {
    const id = params.q.match(/'([^']+)' in parents/)[1];
    listed.push(id);
    if (kids[id] === null) throw new Error('403 insufficient permissions');
    const pages = kids[id];
    const i = params.pageToken ? Number(params.pageToken) : 0;
    return { files: pages[i], nextPageToken: i + 1 < pages.length ? String(i + 1) : undefined };
  };
  return { listPage, listed };
}

test('LAW: Staff Photos is never listed, never indexed (step 2)', async () => {
  const d = fakeDrive();
  const run = await A.crawlTree(d.listPage, 'root');
  assert.ok(!d.listed.includes('staff'), 'the crawl must not even open Staff Photos');
  assert.ok(!run.files.some((f) => f.id === 'hr1'));
  assert.deepStrictEqual(run.skipped, ['Staff Photos']);
});

test('the crawl follows pages at every level, names an EMPTY venue, and survives a failed folder', async () => {
  const run = await A.crawlTree(fakeDrive().listPage, 'root');
  assert.deepStrictEqual(run.files.map((f) => f.id).sort(), ['p1', 's1']);
  assert.deepStrictEqual(run.venueCounts, { TBT: 1, SWF: 0, STE: 1 },
    'SWF and STE sit on page 2 of Venues; SWF has zero files and is named, not skipped');
  assert.deepStrictEqual(run.failed.map((f) => f.path), ['NLP']);
  assert.deepStrictEqual(run.files.find((f) => f.id === 'p1').path, ['Venues', 'TBT', 'Patio']);
});

test('the same bytes in two folders show once, with every path', async () => {
  const run = await A.crawlTree(fakeDrive().listPage, 'root');
  const rows = A.dedupeByChecksum(run.files);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].paths.sort(), ['Venues / STE', 'Venues / TBT / Patio']);
});

test('run counts: seen, new, moved, removed', () => {
  const prev = [{ id: 'a', path: ['Venues', 'TBT'] }, { id: 'b', path: ['Venues', 'TBT'] }, { id: 'c', path: ['NLP'] }];
  const now = [{ id: 'a', path: ['Venues', 'TBT'] }, { id: 'b', path: ['Venues', 'ECD'] }, { id: 'd', path: ['NLP'] }];
  const { counts, removed } = A.diffIndex(prev, now);
  assert.deepStrictEqual(counts, { seen: 3, new: 1, moved: 1, removed: 1, failed: 0 });
  assert.deepStrictEqual(removed, ['c']);
});

test('KNOWN-BAD: a trashed or removed file leaves the index on the nightly change', () => {
  assert.strictEqual(A.changeAction({ file: { trashed: true, mimeType: 'image/jpeg' } }, true), 'remove');
  assert.strictEqual(A.changeAction({ removed: true }, true), 'remove');
  assert.strictEqual(A.changeAction({ file: { mimeType: 'image/jpeg' } }, false), 'add');
  assert.strictEqual(A.changeAction({ file: { mimeType: A.FOLDER_MIME } }, true), 'rewalk');
});

// ------------------------------------------------------------ the path

test('the real path from the order parses into all five fields', () => {
  const p = A.parsePath(['Venues', 'TBT', 'Patio', 'Wedding Reception', 'Cocktail', '100-200']);
  assert.deepStrictEqual(
    { brand: p.brand, venue: p.venue, space: p.space, event_type: p.event_type, event_class: p.event_class, setup: p.setup, guest_band: p.guest_band },
    { brand: 'IH', venue: 'TBT', space: 'Patio', event_type: 'Wedding Reception', event_class: 'wedding', setup: 'Cocktail', guest_band: '100-200' });
  assert.deepStrictEqual(p.unparsed, []);
});

test('guest bands: Under 100, 100-200, 200+', () => {
  assert.strictEqual(A.guestBand('Under 100'), 'under 100');
  assert.strictEqual(A.guestBand('100-200'), '100-200');
  assert.strictEqual(A.guestBand('200+'), '200+');
  assert.strictEqual(A.guestBand('Patio'), null);
});

test('a non-uniform tree is parsed by VALUE: Corporate straight under the venue is an event type, not a space', () => {
  const p = A.parsePath(['Venues', 'TBT', 'Corporate', '200+']);
  assert.strictEqual(p.space, null);
  assert.strictEqual(p.event_type, 'Corporate');
  assert.strictEqual(p.event_class, 'corporate');
  assert.strictEqual(p.guest_band, '200+');
});

test('KNOWN-BAD: a segment that fits no field becomes a plain tag and is logged, never guessed into a field', () => {
  const p = A.parsePath(['Venues', 'TBT', 'Parlor + Main Entrance', 'Moody Edit', 'Cocktail']);
  assert.strictEqual(p.space, 'Parlor + Main Entrance');
  assert.strictEqual(p.setup, 'Cocktail');
  assert.deepStrictEqual(p.path_tags, ['moody edit']);
  assert.deepStrictEqual(p.unparsed.map((u) => u.segment), ['Moody Edit']);
  const twice = A.parsePath(['Venues', 'TBT', 'Patio', 'Under 100', '200+']);
  assert.strictEqual(twice.guest_band, 'under 100', 'the first band stands');
  assert.deepStrictEqual(twice.unparsed.map((u) => u.segment), ['200+']);
});

test('brand from the top folder; the Elle trio; Misc. is unknown; an unknown venue folder is refused', () => {
  assert.strictEqual(A.parsePath(['Venues', 'COR']).brand, 'Elle');
  assert.strictEqual(A.parsePath(['Venues', 'EST']).brand, 'Elle');
  assert.strictEqual(A.parsePath(['Venues', 'STE']).brand, 'Elle');
  assert.strictEqual(A.parsePath(['Venues', 'SWF']).brand, 'IH');
  assert.strictEqual(A.parsePath(['NLP', 'Corporate']).brand, 'NLP');
  assert.strictEqual(A.parsePath(['Culinary']).brand, 'culinary');
  assert.strictEqual(A.parsePath(['Misc.']).brand, null);
  assert.strictEqual(A.parsePath(['Venues', 'COD']).venue, 'COR', 'drift alias from Venue_Master_CANONICAL.md');
  assert.strictEqual(A.parsePath(['Venues', 'BBC']).venue, 'TBB', 'a TBB space used as a venue folder lands on TBB');
  const drury = A.parsePath(['Venues', 'DRURY']);
  assert.strictEqual(drury.venue, null);
  assert.strictEqual(drury.unparsed.length, 1);
  assert.strictEqual(A.parsePath(['Staff Photos', 'x']).excluded, true);
});

test('a DEALID comes from a labelled or all-digit folder, never from a name', () => {
  assert.strictEqual(A.dealIdFrom(['Venues', 'TBT', 'DEALID 41234567890']), '41234567890');
  assert.strictEqual(A.dealIdFrom(['41234567890']), '41234567890');
  assert.strictEqual(A.dealIdFrom(['Rodgers Carpenter Wedding 2025']), null);
});

// ------------------------------------------------------------ dates

test('EXIF first, else Drive created; meteorological seasons; no timezone shift', () => {
  const e = A.dateFacets('2025:12:31 23:30:00', '2026-01-15T10:00:00Z');
  assert.deepStrictEqual(e, { taken_date: '2025-12-31', taken_source: 'exif', month: 'December', season: 'winter', year: 2025 });
  const d = A.dateFacets(null, '2026-03-01T02:00:00Z');
  assert.strictEqual(d.taken_source, 'drive_created');
  assert.strictEqual(d.season, 'spring');
  assert.strictEqual(A.dateFacets('0000:00:00 00:00:00', '2024-09-10T00:00:00Z').season, 'fall', 'a zeroed EXIF date falls back');
  assert.strictEqual(A.dateFacets(null, '2024-02-29').season, 'winter');
  assert.strictEqual(A.dateFacets(null, '2024-08-31').season, 'summer');
  assert.strictEqual(A.orientation(3000, 2000), 'landscape');
  assert.strictEqual(A.orientation(2000, 3000), 'portrait');
});

// ------------------------------------------------------------ vocabulary

test('the seed vocabulary has no word claimed by two tags', () => {
  assert.deepStrictEqual(vocab.conflicts, []);
});

test('synonyms land on one tag: bistro and café lights, media wall, highboys, gobo, lectern, general session', () => {
  assert.strictEqual(A.canonicalTag(vocab, 'bistro lights'), 'string lights');
  assert.strictEqual(A.canonicalTag(vocab, 'Café Lights'), 'string lights');
  assert.strictEqual(A.canonicalTag(vocab, 'media wall'), 'step-and-repeat');
  assert.strictEqual(A.canonicalTag(vocab, 'photo backdrop'), 'step-and-repeat');
  assert.strictEqual(A.canonicalTag(vocab, 'high-top'), 'cocktail tables');
  assert.strictEqual(A.canonicalTag(vocab, 'gobo'), 'branded gobo');
  assert.strictEqual(A.canonicalTag(vocab, 'logo projection'), 'branded gobo');
  assert.strictEqual(A.canonicalTag(vocab, 'lectern'), 'podium');
  assert.strictEqual(A.canonicalTag(vocab, 'general session'), 'keynote');
});

test('KNOWN-BAD: a synonym claimed by two tags is refused for both and reported', () => {
  const v = A.buildVocabulary({ groups: { a: ['arch'], b: ['arbor'] }, synonyms: { 'wedding arch': 'arch' }, items: [{ house_name: 'Copper Arbor', synonyms: ['wedding arch'] }] });
  assert.strictEqual(A.canonicalTag(v, 'wedding arch'), null);
  assert.strictEqual(v.conflicts.length, 1);
});

test('Amendment D: item tags are the HOUSE name, and consumables never become tags', () => {
  assert.strictEqual(A.canonicalTag(vocab, 'chiavari'), 'Fruitwood Chiavari Chair');
  assert.strictEqual(A.canonicalTag(vocab, 'greenery wall'), 'Boxwood Wall');
  assert.strictEqual(A.canonicalTag(vocab, 'red wine'), null);
  const s = A.screenAiTags(vocab, [{ tag: 'chiavari chair', confidence: 0.9 }, { tag: 'wine', confidence: 0.8 }]);
  assert.deepStrictEqual(s.tags, [{ tag: 'Fruitwood Chiavari Chair', confidence: 0.9 }]);
  assert.strictEqual(s.dropped[0].why, 'consumable');
});

test('Amendment D: the seed file holds no item names; they are imported, never forked', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'photo-vocabulary.js'), 'utf8')
    .replace(/\/\/.*$/gm, '');                       // comments may NAME the rule; code may not break it
  for (const item of ['Chiavari', 'Crossback', 'Boxwood', 'Kings Table', 'Velvet Sofa']) {
    assert.ok(!src.includes(item), `${item} is an item name; it must come from #1009's list`);
  }
});

// ------------------------------------------------------------ AI tags

test('no people-identifying tags; free text is lowercase, short and capped at 3', () => {
  const s = A.screenAiTags(vocab, [
    { tag: 'uplighting', confidence: 0.9 },
    { tag: 'bride named sarah', confidence: 0.9 },
    { tag: 'Sarah', confidence: 0.9 },
    { tag: 'dancing', confidence: 0.7 },
    { tag: 'toast', confidence: 0.7 },
    { tag: 'confetti', confidence: 0.7 },
    { tag: 'sparklers', confidence: 0.7 },
  ]);
  assert.deepStrictEqual(s.tags.map((t) => t.tag), ['uplighting', 'dancing', 'toast', 'confetti']);
  assert.deepStrictEqual(s.dropped.map((d) => d.tag), ['bride named sarah', 'Sarah', 'sparklers']);
});

test('KNOWN-BAD: a human-removed tag never comes back on re-tagging; a human add always stands', () => {
  let edits = A.applyTagEdit({}, 'remove', 'candles');
  edits = A.applyTagEdit(edits, 'add', 'rain plan');
  const retag = [{ tag: 'candles', confidence: 0.99 }, { tag: 'string lights', confidence: 0.8 }];
  assert.deepStrictEqual(A.finalTags({ ai: retag, ...edits }), ['rain plan', 'string lights']);
  assert.deepStrictEqual(A.finalTags({ ai: retag, ...edits }), A.finalTags({ ai: [...retag, ...retag], ...edits }));
  edits = A.applyTagEdit(edits, 'add', 'candles');
  assert.ok(A.finalTags({ ai: retag, ...edits }).includes('candles'), 'adding it back un-removes it');
});

// ------------------------------------------------------------ rights

const rows = {
  111: { 'Cool with using photos on socials/sales materials?': 'NO', Notes: '' },
  222: { 'Cool with using photos on socials/sales materials?': 'Yes', Notes: 'Avoid using photos of the family table' },
  333: { 'Cool with using photos on socials/sales materials?': 'YES', Notes: 'no issues, photos turned out great' },
  444: { 'Cool with using photos on socials/sales materials?': 'N/A', Notes: '' },
};

test('rights from the sheet row by DEALID: a NO, or a Notes line saying not to use photos, is internal only', () => {
  assert.strictEqual(A.rightsFor({ topFolder: 'Venues', dealId: '111', rowsByDealId: rows }).state, 'internal_only');
  assert.strictEqual(A.rightsFor({ topFolder: 'Venues', dealId: '222', rowsByDealId: rows }).state, 'internal_only');
  assert.strictEqual(A.rightsFor({ topFolder: 'Venues', dealId: '333', rowsByDealId: rows }).state, 'cleared',
    '"no issues" is not a no');
  assert.strictEqual(A.rightsFor({ topFolder: 'Venues', dealId: '444', rowsByDealId: rows }).state, 'unknown');
  assert.strictEqual(A.rightsFor({ topFolder: 'Venues', dealId: '999', rowsByDealId: rows }).state, 'unknown');
});

test('Venues with no event link is cleared by default, and the default can flip to unknown', () => {
  assert.strictEqual(A.rightsFor({ topFolder: 'Venues' }).state, 'cleared');
  assert.strictEqual(A.rightsFor({ topFolder: 'Venues', venuesDefault: 'unknown' }).state, 'unknown');
  assert.strictEqual(A.rightsFor({ topFolder: 'NLP' }).state, 'unknown');
  assert.strictEqual(A.rightsFor({ topFolder: 'Venues', dealId: '333', rowsByDealId: rows, manualInternal: true }).state, 'internal_only',
    'a hand-set internal only beats a sheet YES');
});

test('KNOWN-BAD: an internal-only or unknown photo offers no download, and carries its badge', () => {
  assert.strictEqual(A.canDownload('internal_only'), false);
  assert.strictEqual(A.canDownload('unknown'), false);
  assert.strictEqual(A.canDownload('cleared'), true);
  assert.strictEqual(A.BADGES.internal_only, "Internal only, don't send to clients");
  assert.strictEqual(A.BADGES.unknown, 'Check with marketing');
});

test('KNOWN-BAD: rights never match by event name (the function has no name input)', () => {
  const r = A.rightsFor({ topFolder: 'Venues', dealId: null, rowsByDealId: rows, eventName: 'anything' });
  assert.strictEqual(r.reason.includes('Venues folder'), true, 'with no DEALID the sheet is not consulted at all');
});

// ------------------------------------------------------------ search

const photos = [
  { id: 1, name: 'a.jpg', tags: ['string lights', 'long tables'], venue: 'TBT', space: 'Patio', season: 'fall', event_class: 'wedding', rights_state: 'cleared' },
  { id: 2, name: 'b.jpg', tags: ['string lights'], venue: 'ECD', space: 'Sunset Terrace', season: 'summer', event_class: 'wedding', rights_state: 'cleared' },
  { id: 3, name: 'c.jpg', tags: ['string lights'], venue: 'TBT', space: 'Patio', season: 'summer', event_class: 'wedding', rights_state: 'internal_only' },
  { id: 4, name: 'd.jpg', tags: ['stage', 'led wall'], venue: 'TBB', event_type: 'Corporate', event_class: 'corporate', rights_state: 'cleared' },
  { id: 5, name: 'e.jpg', tags: ['stage and band'], venue: 'TBT', event_class: 'corporate', rights_state: 'cleared' },
  { id: 6, name: 'f.jpg', tags: ['step-and-repeat'], venue: 'TBB', event_class: 'corporate', rights_state: 'cleared' },
  { id: 7, name: 'media wall test.jpg', tags: [], venue: 'SWF', rights_state: 'cleared' },
  { id: 8, name: 'g.jpg', tags: ['Fruitwood Chiavari Chair'], venue: 'SWF', rights_state: 'cleared' },
];
const ids = (r) => r.results.map((p) => p.id);

test('ACCEPTANCE: "string lights" returns string-light photos from more than one venue, and "bistro lights" the same', () => {
  const r = A.search(vocab, photos, { q: 'string lights' });
  assert.deepStrictEqual(ids(r), [1, 2, 3]);
  assert.ok(new Set(r.results.map((p) => p.venue)).size > 1);
  assert.deepStrictEqual(ids(A.search(vocab, photos, { q: 'bistro lights' })), [1, 2, 3]);
});

test('ACCEPTANCE: TBT + Patio + fall narrows correctly, and each facet counts with the OTHER filters on', () => {
  const r = A.search(vocab, photos, { q: 'string lights', filters: { venue: 'TBT', space: 'Patio', season: 'fall' } });
  assert.deepStrictEqual(ids(r), [1]);
  assert.deepStrictEqual(r.facets.season, { fall: 1, summer: 1 }, 'season counts ignore the season filter itself');
  assert.deepStrictEqual(r.facets.venue, { TBT: 1 });
});

test('ACCEPTANCE (C): "stage" + corporate returns corporate stage photos from more than one venue', () => {
  const r = A.search(vocab, photos, { q: 'stage', filters: { event_class: 'corporate' } });
  assert.deepStrictEqual(ids(r), [4, 5]);
  assert.ok(new Set(r.results.map((p) => p.venue)).size > 1);
});

test('ACCEPTANCE (C): "step and repeat" and "media wall" return the SAME set', () => {
  const a = ids(A.search(vocab, photos, { q: 'step and repeat' }));
  const b = ids(A.search(vocab, photos, { q: 'media wall' }));
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, [6, 7], 'the file-name hit counts for both spellings, not only the one typed');
});

test('ACCEPTANCE (D): "chiavari" returns the house-named chair photos', () => {
  assert.deepStrictEqual(ids(A.search(vocab, photos, { q: 'chiavari' })), [8]);
});

test('search matches whole words, and a "+" query needs every part', () => {
  assert.deepStrictEqual(ids(A.search(vocab, photos, { q: 'led wall + corporate' })), [4]);
  assert.deepStrictEqual(ids(A.search(vocab, photos, { q: 'tab' })), [], '"tab" is not "tables"');
});
