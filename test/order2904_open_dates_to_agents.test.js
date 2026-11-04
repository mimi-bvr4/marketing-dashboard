'use strict';
// ORDER #2904 (Mimi 11.03.2026, ruling 3): open dates at the 7 venues feed the
// Convention Connector's pitches and the Google Business post ideas. ANY open
// date, not only weekends. Never prices. At The Bridge Building a date is open
// only when nothing is booked in any space. OS is not a venue.
//
// The source of truth is HubSpot deals, read by lib/open-dates.js (#1677,
// #1681). HubSpot's deal property `venue` is an enumeration of TBB, TBT, ECD,
// SWF, OS, COR, STE, EST, MOBILE (read 11.03.2026 23:0x CT): a booking in any
// Bridge Building space (Cumberland, Dyer, Observatory) carries venue TBB, so
// it takes the whole date.
//
// The model never types an open date: it lists the dates it wants to offer,
// and the runner keeps only those open in the measured source. Every test runs
// on a fake model, a fake HubSpot search and a web that serves only the
// dashboard's own /api/open-dates. Nothing is sent and nothing is written.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OD = require('../lib/open-dates');
const { gather, openDatesSource } = require('../lib/agent-sources');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent, modelText } = require('../lib/agent-runner');

const NOW = new Date('2026-11-04T15:00:00Z'); // Wed 11.04.2026 in Nashville
const deal = (venue, day, extra = {}) => ({ properties: { venue, dealname: `${day} ${venue} Test`, contract_signed_date: '2026-09-01',
  actual_event_date: day, pipeline: '746391920', ...extra } });
const DEALS = [
  // One Bridge Building space (Cumberland) booked on Sat 11.07: the whole TBB date is taken.
  deal('TBB', '2026-11-07', { dealname: '11.07.2026 Cumberland only Test' }),
  deal('TBT', '2026-11-10'), // Tue 11.10 booked at The Bell Tower
  deal('OS', '2026-11-12'), // off site: not one of the 7, books nothing
];
const search = async () => ({ results: DEALS });

// The dashboard as the Box sees it: GET /api/open-dates answered from the fake
// HubSpot search; every other URL is refused and counted.
function web() {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.pathname !== '/api/open-dates') throw new Error('no network in this test');
    if (!/^Bearer mkt_/.test((opts.headers || {}).Authorization || '')) return { status: 401, json: async () => ({ error: 'no key' }) };
    const body = await OD.computeOpenDates({ search, months: Number(u.searchParams.get('months')), now: NOW, days: u.searchParams.get('days') === 'all' ? 'all' : 'prime' });
    return { status: 200, json: async () => body };
  };
  f.calls = calls;
  return f;
}

function model(cards) {
  const calls = [];
  return { model: 'fake', calls, async complete(req) { calls.push(req); return JSON.stringify({ cards: cards() }); } };
}

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt2904-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('05_AI_and_Brain/Venue_Master_CANONICAL.md', '# Venues\nThe Bridge Building (TBB), The Bell Tower (TBT).');
  put('07_Marketing_and_Brand/Conventions_test.md', '# Conventions\n- Music Expo, Music City Center, 11.09.2026 to 11.12.2026, https://example.org/expo');
  return root;
}

// The Convention Connector with its web search swapped for a file, so the test
// never searches the web. Everything else is the real agent.json.
function connector() {
  const def = loadAgent('convention-connector');
  def.sources = def.sources.map((s) => (s.type === 'web_trends' ? { type: 'file', path: '07_Marketing_and_Brand/Conventions_test.md', required: true, label: 'conventions (test file)' } : s));
  return def;
}

const PITCH = () => [{
  title: 'Acme DMC: offsite nights for the Music Expo', target: 'Acme DMC',
  body: 'Hello Acme team. While the Music Expo is in town, our venues are open for a reception or client dinner on these dates:\n\n{{OPEN_DATES}}\n\nWe would love to host your group.',
  open_dates: [
    { venue: 'TBB', date: '2026-11-07' }, // a Saturday with one Bridge Building space booked: must NOT be offered
    { venue: 'TBB', date: '2026-11-10' }, // a Tuesday, open: offered (a weekday)
    { venue: 'TBT', date: '2026-11-10' }, // booked at The Bell Tower
    { venue: 'TBT', date: '11.11.2026' }, // a Wednesday, open, written MM.DD.YYYY
    { venue: 'OS', date: '2026-11-12' }, // off site is not a venue
    { venue: 'ECD', date: '2027-12-01' }, // outside the 9 months measured
  ],
  seen: { company: 'Acme DMC', event: 'Music Expo', event_dates: '11.09.2026 to 11.12.2026' },
}];

test('every day of the week when asked; the default stays Fri/Sat/Sun for the home band', async () => {
  const all = await OD.computeOpenDates({ search, months: 1, now: NOW, days: 'all' });
  const prime = await OD.computeOpenDates({ search, months: 1, now: NOW });
  assert.strictEqual(all.days, 'all');
  assert.strictEqual(prime.days, 'prime');
  const tbb = all.venues.find((v) => v.code === 'TBB').open.map((d) => d.date);
  assert.ok(tbb.includes('2026-11-10'), 'a Tuesday is open at TBB');
  assert.ok(!tbb.includes('2026-11-07'), 'the Saturday with one TBB space booked is not open');
  assert.ok(prime.venues[0].open.every((d) => [5, 6, 0].includes(new Date(d.date + 'T00:00:00Z').getUTCDay())));
  assert.ok(!all.venues.some((v) => v.code === 'OS'), 'OS is not a venue');
  assert.doesNotMatch(JSON.stringify(all), /Test|Cumberland/, 'no deal names in the answer');
  assert.match(all.source, /HubSpot deals/);
});

test('KNOWN-BAD: a Bridge Building date with one space booked is NOT offered; a weekday that is open is', async () => {
  const measured = await OD.computeOpenDates({ search, months: 9, now: NOW, days: 'all' });
  const { kept, dropped } = OD.checkOffered(PITCH()[0].open_dates, measured);
  assert.deepStrictEqual(kept.map((k) => `${k.venue} ${k.date}`), ['TBB 2026-11-10', 'TBT 2026-11-11']);
  assert.deepStrictEqual(dropped.map((d) => d.why), ['booked in HubSpot', 'booked in HubSpot', 'not one of our 7 venues', 'outside the dates measured']);
  assert.strictEqual(kept[0].line, 'The Bridge Building: Tuesday 11.10.2026');
});

test('the source: off by default, read with the fleet key when OPEN_DATES_TO_AGENTS is on', async () => {
  const srcs = connector().sources;
  const off = await gather(srcs, { env: { MARKETING_FLEET_KEY: 'mkt_test', IHG_TREE: '/nonexistent' }, fetch: web(), now: () => NOW });
  assert.ok(!off.got.some((g) => g.type === 'open_dates') && !off.unavailable.some((u) => u.type === 'open_dates'), 'switch off: not read, not reported');
  const f = web();
  const on = await gather(srcs.filter((s) => s.type === 'open_dates'), { env: { MARKETING_FLEET_KEY: 'mkt_test', OPEN_DATES_TO_AGENTS: 'on' }, fetch: f, now: () => NOW });
  assert.strictEqual(on.got.length, 1);
  assert.match(f.calls[0], /\/api\/open-dates\?months=9&days=all$/);
  assert.match(on.got[0].text, /TBB \(The Bridge Building\): \d+ open of \d+\. Booked: 11\.07\.2026\./);
  assert.match(on.got[0].text, /Never type an open date yourself, never a price/);
  assert.doesNotMatch(on.got[0].text, /\$|price:|total/i, 'no money in the source');
  const nokey = await openDatesSource({ type: 'open_dates' }, { env: {}, keychain: () => null, fetch: f });
  assert.strictEqual(nokey.ok, false);
  assert.match(nokey.why, /marketing-fleet-key/);
});

test('a test pitch shows only dates truly open in the source, including a weekday, written by code', async (t) => {
  const root = tree(t);
  const store = createMemoryStore({ lint });
  const llm = model(PITCH);
  const r = await runAgent({ def: connector(), store, llm, env: { IHG_TREE: root, MARKETING_FLEET_KEY: 'mkt_test', OPEN_DATES_TO_AGENTS: 'on' },
    fetchImpl: web(), now: () => NOW, scheduled: true });
  assert.ok(r.ok, r.error);
  const body = r.cards[0].body;
  assert.match(body, /- The Bridge Building: Tuesday 11\.10\.2026\n- The Bell Tower: Wednesday 11\.11\.2026/);
  assert.doesNotMatch(modelText(body), /11\.07\.2026|\{\{OPEN_DATES\}\}/, 'the booked Saturday is not offered, the token is filled');
  assert.match(body, /### Open dates checked/);
  assert.match(body, /The Bridge Building 11\.07\.2026: booked in HubSpot/);
  assert.match(body, /sales confirms before anyone holds a date\. No prices\./);
  assert.ok(!('open_dates' in r.cards[0]), 'the raw list is not stored on the card');
  assert.match(llm.calls[0].user, /=== open dates at our 7 venues \(HubSpot bookings\) ===/);
});

test('switch off: the card offers no date, even if the model tried', async (t) => {
  const root = tree(t);
  const store = createMemoryStore({ lint });
  const r = await runAgent({ def: connector(), store, llm: model(PITCH), env: { IHG_TREE: root, MARKETING_FLEET_KEY: 'mkt_test' },
    fetchImpl: web(), now: () => NOW, scheduled: true });
  const body = modelText(r.cards[0].body);
  assert.doesNotMatch(body, /11\.10\.2026|11\.11\.2026|\{\{OPEN_DATES\}\}/);
  assert.match(body, /Open dates were not read this run: ask sales for current availability\./);
});

test('a card with no dates (a review reply) is unchanged; Google Business reads 3 months behind the same switch', async () => {
  const same = OD.fillOpenDates('Thank you, Ana.', [], { venues: [] }, 'now');
  assert.strictEqual(same.body, 'Thank you, Ana.');
  const gbp = loadAgent('gbp').sources.find((s) => s.type === 'open_dates');
  assert.deepStrictEqual(gbp, { type: 'open_dates', months: 3, when_flag: 'OPEN_DATES_TO_AGENTS' });
  assert.strictEqual(loadAgent('convention-connector').sources.find((s) => s.type === 'open_dates').when_flag, 'OPEN_DATES_TO_AGENTS');
});

test('the route answers days=all on its own cache line', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'open-dates.js'), 'utf8');
  assert.match(src, /req\.query\.days === 'all'/);
  assert.match(src, /const key = `\$\{months\}:\$\{days\}`/);
});
