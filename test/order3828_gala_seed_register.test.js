// ORDER #3828 (#3805 follow-on): the Gala Scout's seed also carries the
// Sophisticated Giving Charity Register Nashville 2027 leads. A second seed
// file beside the 10.08 report (which stays byte-identical); new events are
// added, dated updates win over the old row only on an exact written key, and
// anything that cannot be matched exactly is listed UNMATCHED, never merged.
// Reads files only: nothing here fetches, sends or writes HubSpot.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const seed = require('../lib/gala-seed');
const { galaSeedSource } = require('../lib/agent-sources');
const { loadAgent } = require('../lib/agent-runner');

const DIR = path.join(__dirname, '..', 'agents', 'gala-scout', 'seed');
const BASE = path.join(DIR, 'Nashville-Gala-Research-Report-11.05.2026.md');
const REG = path.join(DIR, 'Sophisticated-Giving-2027-Register-11.25.2026.md');
const ISSUU = 'https://issuu.com/sophisticatedliving/docs/sophisticated_giving_charity_regist_08fddbd0989b9a';

const NEW_EVENTS = [
  '38th Annual Steak & Burger Dinner', 'Black Tie Gala', 'Collegiate 100 Fundraiser', 'Annual Luncheon',
  'Heroes & Holidays Gala', 'Stars & 6 Strings Gala', 'Mission Minded Leadership Luncheon', 'Rock the Cradle',
  'Benefit for Bright Minds Annual Dinner & Auction', 'A Night to Dream', 'Sparkle for Smiles', 'Fall Southern Social',
  'Stand Up for Agape', 'Piazza Italia', 'Whiskey, Wine, Mocktails & More', 'Mardi Bras Fundraiser',
  'Songwriter\'s Night', 'Blue Ribbon Teacher Awards Ceremony', 'Patricia Hart Society "Books and Bubbly"',
  'Young Leaders Society "Unlabeled"', 'Nashville\'s Ultimate Wine & Food Weekend', 'Dinner with Your Dog',
  'Illumination', '5th Annual Night Circus',
];

test('the register file parses: 24 new events, each sourced to the register with its Issuu link and pages', () => {
  const r = seed.loadRegister(REG);
  assert.strictEqual(r.events.length, 24);
  assert.deepStrictEqual(r.events.map((e) => e.event).sort(), NEW_EVENTS.slice().sort());
  for (const e of r.events) {
    assert.ok(e.org, `${e.event} has a host org`);
    assert.ok(e.when && /2027/.test(e.when), `${e.event} carries its 2027 date or month as printed`);
    assert.strictEqual(e.source, ISSUU);
    assert.match(e.source_page, /136 to 138/);
    assert.match(e.caution, /publisher's snapshot, confirm on the host's site/);
    // The register prints no venue, price or contact: none is added.
    assert.strictEqual(e.venue, null);
    assert.strictEqual(e.how_much, null);
    assert.ok(!('email' in e) && !('contact' in e));
  }
  const by = (n) => r.events.find((e) => e.event === n);
  assert.strictEqual(by('Benefit for Bright Minds Annual Dinner & Auction').when, '04.03.2027');
  assert.strictEqual(by('Benefit for Bright Minds Annual Dinner & Auction').month, 4);
  assert.strictEqual(by('Rock the Cradle').month, null, 'spring is not a month');
  assert.strictEqual(by('Black Tie Gala').month, 6);
});

test('"likely booked; pitch 2028" rides on every February event and on 04.03, and on nothing else', () => {
  const r = seed.loadRegister(REG);
  const marked = r.events.filter((e) => e.pitch).map((e) => e.event).sort();
  assert.deepStrictEqual(marked, [
    '5th Annual Night Circus', 'Benefit for Bright Minds Annual Dinner & Auction', 'Dinner with Your Dog',
    'Mardi Bras Fundraiser', 'Nashville\'s Ultimate Wine & Food Weekend', 'Young Leaders Society "Unlabeled"',
  ]);
  for (const e of r.events) if (e.pitch) assert.strictEqual(e.pitch, 'likely booked; pitch 2028');
  for (const e of r.events) if (e.month === 2) assert.ok(e.pitch, `${e.event} is in February`);
});

test('no Executive Director or Board Chair name from the OCR is in the seed file', () => {
  const text = fs.readFileSync(REG, 'utf8');
  for (const n of ['Andre Lee', 'Turner Nashe', 'Jenner Kreifels', 'Robbie Goldsmith', 'April Posey', 'Lisa Bonick',
    'Eric Elmquist', 'Raquel Oluyemo', 'Neil Krugman', 'Jill Pratt', 'Greg Petree', 'John Stallworth', 'Baldasseroni',
    'Beth Uselton', 'Stacy Case', 'Harriet Schiftan', 'Drew Mallory', 'Shawn Bakker', 'Elizabeth Sherrard',
    'Patrick Theobald', 'Erica Mitchell', 'Emily Weiss', 'Chumley', 'Marc Goldstone', 'Laura Baker', 'Heather Derrick',
    'Elisabeth Willers', 'Elise Jenkins', 'Lauren Pennington']) {
    assert.ok(!text.includes(n), `${n} is not copied into the seed`);
  }
  assert.ok(!/@/.test(text), 'no email address');
  assert.ok(!/\$\d/.test(text), 'no price');
});

test('dated updates win over the old row on the exact written key; the rest are UNMATCHED, never merged', () => {
  const base = seed.load(BASE);
  const reg = seed.loadRegister(REG);
  const m = seed.mergeRegister(base, reg);
  assert.strictEqual(m.events.length, 164 + 24);
  assert.strictEqual(m.leads.length, 220);
  assert.strictEqual(m.applied.length, 10);
  const ev = (name, org) => m.events.filter((e) => e.event === name && e.org === org);
  const ballet = ev('Ballet Ball', 'Nashville Ballet');
  assert.strictEqual(ballet.length, 1, 'updated in place, not duplicated');
  assert.strictEqual(ballet[0].when, '03.06.2027');
  assert.strictEqual(ballet[0].prior_when, '03.07.2026');
  assert.strictEqual(ballet[0].month, 3);
  assert.strictEqual(ballet[0].dated, true);
  assert.strictEqual(ballet[0].source, ISSUU);
  assert.match(ballet[0].prior_source, /nashvilleballet\.com/);
  assert.match(ballet[0].caution, /publisher's snapshot/);
  assert.strictEqual(ballet[0].venue, 'Schermerhorn Symphony Center', 'the 2026 venue is kept as the 2026 venue');
  const gf = ev('Great Futures Gala', 'Boys & Girls Clubs of Middle Tennessee')[0];
  assert.strictEqual(gf.when, '04.09.2027');
  assert.strictEqual(gf.month, 4, 'moved from May to April');
  assert.strictEqual(ev('Stars for Second Harvest', 'Second Harvest Food Bank of Middle Tennessee')[0].when, 'June 2027, day TBA');
  // UNMATCHED: listed, not merged.
  assert.deepStrictEqual(m.unmatched.map((u) => u.event).sort(), ['CASA Red Shoe Gala', 'Impact Awards']);
  assert.ok(!m.events.some((e) => e.event === 'CASA Red Shoe Gala' || e.event === 'Impact Awards'));
  assert.strictEqual(ev('Goodwill Impact Luncheon', 'Goodwill Industries of Middle Tennessee')[0].when, 'Fall', 'the near-miss is left alone');
  // The old file's own rows are not mutated by the merge.
  assert.strictEqual(base.events.find((e) => e.event === 'Ballet Ball').when, '03.07.2026');
});

test('a written key that names no seed row is reported UNMATCHED, never matched by a near name', () => {
  const base = seed.load(BASE);
  const reg = seed.loadRegister(REG);
  const bad = { ...reg, updates: [{ ...reg.updates[0], seed_event: 'Ballet  Ball' }] };
  const m = seed.mergeRegister(base, bad);
  assert.strictEqual(m.applied.length, 0);
  assert.strictEqual(m.unmatched.length, reg.unmatched.length + 1);
  assert.match(m.unmatched[m.unmatched.length - 1].why, /no seed row has this exact key/);
});

test('gala_seed with the register: measured events rise by 24, the agent text carries the cautions', async () => {
  const before = await galaSeedSource({ seed: 'gala-scout/seed/Nashville-Gala-Research-Report-11.05.2026.md', top_leads: 50 }, {});
  assert.deepStrictEqual(before.measured, { events: 164, leads: 220 });
  const d = loadAgent('gala-scout');
  const src = d.sources.find((s) => s.type === 'gala_seed');
  assert.strictEqual(src.register, 'gala-scout/seed/Sophisticated-Giving-2027-Register-11.25.2026.md', 'agent.json names the second seed');
  const after = await galaSeedSource(src, {});
  assert.ok(after.ok, after.why);
  assert.deepStrictEqual(after.measured, { events: 188, leads: 220, register_new: 24, register_updated: 10, register_unmatched: 2 });
  assert.match(after.text, /Rock the Cradle/);
  assert.match(after.text, /likely booked; pitch 2028/);
  assert.match(after.text, /publisher's snapshot, confirm on the host's site/);
  assert.match(after.text, /was 03\.07\.2026/);
  assert.match(after.text, /UNMATCHED/);
  assert.ok(after.text.length < 60000, `inside the file cap (${after.text.length})`);
  const bad = await galaSeedSource({ ...src, register: '../../package.json' }, {});
  assert.strictEqual(bad.ok, false);
});
