// ORDER #3163 (Mimi 11.09.2026, "Yes, file it"): the Keyword Queen. Ships OFF
// behind AGENT_KEYWORD_QUEEN. Memory store, a temp tree and a fake model only:
// nothing here reaches Ubersuggest, Search Console, WordPress or a live queue.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../lib/producer');
const KQ = require('../lib/keyword-queen');
const { loadAgent, runAgent } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const ON = { AGENT_KEYWORD_QUEEN: 'on' };

const MASTER = [
  '| Canonical venue | Code | Spaces |', '|---|---|---|',
  '| The Bridge Building | **TBB** | BBC |', '| The Bell Tower | **TBT** | Main |',
  '| Saddle Woods Farm | **SWF** | Barn |', '| Off Site | **OFFSITE** | (per-event) |',
  '| Catering Kitchen | KITCHEN | - |', '', '| Venue | Code | Color |', '|---|---|---|', '| Saint Elle | STE | black |',
].join('\n');
const UBER = [
  '# Ubersuggest weekly 11.05.2026', '| keyword | page | volume | SEO difficulty | CPC |', '|---|---|---|---|---|',
  ...Array.from({ length: 11 }, (_, i) => `| nashville wedding idea ${i + 1} | - | ${1000 + i * 10} | ${20 + i} | 1.10 |`),
  '| rooftop wedding nashville | - | 2,400 | 41 | 2.00 |',
  '| barn wedding murfreesboro | - | 880 | 33 | 1.50 |',
].join('\n');
const MAP = ['| Focus keyword | Page | Status |', '|---|---|---|', '| barn wedding murfreesboro | /barn | published |'].join('\n');

function tree() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kq3163-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
  w('05_AI_and_Brain/Venue_Master_CANONICAL.md', MASTER);
  w('07_Marketing_and_Brand/SEO_Data/Ubersuggest_Weekly_2026-11-05.md', UBER);
  w('07_Marketing_and_Brand/Blog_Agent/KEYWORD_MAP.md', MAP);
  w('07_Marketing_and_Brand/AI_TELLS_BAN_LIST.md', 'ban list');
  return d;
}

// The real agent minus the WordPress read (that one needs the web).
const defNoWeb = () => { const d = loadAgent('keyword-queen'); return { ...d, sources: d.sources.filter((s) => s.type !== 'wp_posts') }; };

function row(n, topic, kw, venue, vol, sd, src = 'Ubersuggest weekly 11.05.2026') {
  return `| ${n} | ${topic} | ${kw} | ${venue} | ${vol} | ${sd} |  | ${src} | Spring planning starts now. |`;
}
function cardJson(rows) {
  const body = ['This week leans on spring planning.', '',
    '| # | Topic | Target keyword | Venue or brand | Monthly volume | Difficulty | Our rank | Source | Why now |',
    '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
  return JSON.stringify({ cards: [{ title: 'Blog topics for the week of 11.10.2026', target: 'blogs', body }] });
}
const fakeLlm = (text) => ({ model: 'fake', calls: 0, async complete() { this.calls++; return text; } });

const TEN = Array.from({ length: 10 }, (_, i) => row(i + 1, `Idea ${i + 1} for couples`, `nashville wedding idea ${i + 1}`,
  i % 2 ? 'The Bell Tower' : 'Saddle Woods Farm', 1000 + i * 10, 20 + i));

test('the card: Keyword Queen, her tagline, Tuesday on the calendar, OFF behind her own switch', () => {
  const d = loadAgent('keyword-queen');
  assert.strictEqual(d.name, 'Keyword Queen');
  assert.strictEqual(d.character.role, 'The Keyword Queen');
  assert.strictEqual(d.job, 'picks the search terms worth winning');
  assert.strictEqual(d.switch, 'AGENT_KEYWORD_QUEEN');
  assert.strictEqual(d.max_cards, 1);
  assert.ok(d.character.traits.length >= 2 && d.character.traits.every((t) => t.cant && t.instead));
  assert.ok(P.calendar().some((e) => e.agent === 'keyword-queen' && e.days.includes('tue')));
  assert.match(P.switchOff(d, {}), /off until Mimi switches it on \(AGENT_KEYWORD_QUEEN\)/);
  assert.strictEqual(P.switchOff(d, ON), null);
  const b = P.board({ ymd: '2026-11-10', defs: [d], env: {} })[0];
  assert.strictEqual(b.state, 'off');
  for (const f of ['agent.json', 'SKILL.md']) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'agents', 'keyword-queen', f), 'utf8'), /—/);
});

test('switch OFF: never runs, scheduled or Run now; the model is never called; approve refuses', async () => {
  const store = createMemoryStore({ lint });
  const llm = { model: 'x', complete: async () => { throw new Error('the model must not be called'); } };
  const r = await runAgent({ slug: 'keyword-queen', store, llm, env: {}, scheduled: true });
  assert.ok(r.ok && /off until Mimi/.test(r.skipped));
  assert.strictEqual((await store.list({ status: 'draft' })).length, 0);
  const ran = [];
  await P.runDay({ ymd: '2026-11-10', store: { draftsWaiting: async () => 0, producerWeekCards: async () => 0, producerLog: async () => {} },
    env: {}, runOne: async (a) => { ran.push(a); return { ok: true, cards: [] }; }, maxCardsOf: () => 1, defOf: (s) => loadAgent(s) });
  assert.ok(!ran.includes('keyword-queen'), 'the Producer does not run her on Tuesday');
  const card = await store.insert({ agent: 'keyword-queen', agent_name: 'Keyword Queen', job: 'j', title: 't', body: 'b',
    payload: { topics: [{ n: 1, keyword: 'k', venue: 'The Bell Tower' }] } });
  const a = await KQ.approveTopic({ card, n: 1, who: 'katherine@infinityhospitality.net', store, env: {} });
  assert.strictEqual(a.status, 404);
  assert.strictEqual((await store.runRequests(50)).length, 0);
});

test('switch ON, dry run: one card, 10 topics, every figure sourced or blank, nothing saved or queued', async () => {
  const env = { ...ON, IHG_TREE: tree() };
  const store = createMemoryStore({ lint });
  const rows = [...TEN,
    row(11, 'Rooftop vows', 'rooftop wedding nashville', 'The Moon Hotel', 2400, 41),
    row(12, 'Barn weddings', 'barn wedding murfreesboro', 'Saddle Woods Farm', 880, 33)];
  // Topic 3's volume is invented (not in the source): it must be blanked, not kept.
  rows[2] = row(3, 'Idea 3 for couples', 'nashville wedding idea 3', 'Saddle Woods Farm', 9999, 22);
  const llm = fakeLlm(cardJson(rows));
  const r = await runAgent({ slug: 'keyword-queen', def: defNoWeb(), store, llm, env, dryRun: true, now: () => new Date('2026-11-10T12:00:00Z') });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.cards.length, 1);
  const t = r.cards[0].payload.topics;
  assert.strictEqual(t.length, 10);
  assert.deepStrictEqual(t.map((x) => x.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const x of t) {
    assert.ok(['The Bell Tower', 'Saddle Woods Farm'].includes(x.venue));
    for (const f of ['volume', 'difficulty']) if (x[f]) assert.match(UBER, new RegExp(`${x.keyword} \\| - \\| [^\\n]*\\b${x[f]}\\b`), `${x.keyword} ${f} ${x[f]} is in the source`);
    if (x.volume || x.difficulty) assert.ok(x.source);
  }
  const three = t.find((x) => x.keyword === 'nashville wedding idea 3');
  assert.strictEqual(three.volume, '', 'invented volume is blank');
  assert.strictEqual(three.difficulty, '22', 'the sourced difficulty stays');
  assert.match(r.cards[0].body, /Blanked \(not found in a source this run\): nashville wedding idea 3: volume/);
  assert.match(r.cards[0].body, /rooftop wedding nashville: "The Moon Hotel" is not a venue/);
  assert.match(r.cards[0].body, /barn wedding murfreesboro: the keyword map already gives it to a page/);
  assert.ok(!t.some((x) => x.keyword === 'nashville wedding idea 11'), 'the 11th never shows');
  assert.strictEqual((await store.list({ status: 'draft', includeReference: true })).length, 0, 'dry run saves no card');
  assert.strictEqual((await store.runRequests(50)).length, 0, 'dry run queues nothing');
});

test('no invented figures: a number not on the keyword\'s own source line, or with no source named, is blank', () => {
  const texts = [UBER];
  const ok = KQ.checkFigures({ keyword: 'rooftop wedding nashville', volume: '2,400', difficulty: '41', rank: '', source: 'Ubersuggest' }, texts);
  assert.deepStrictEqual([ok.topic.volume, ok.topic.difficulty, ok.blanked], ['2400', '41', []]);
  const other = KQ.checkFigures({ keyword: 'rooftop wedding nashville', volume: '880', difficulty: '41', source: 'Ubersuggest' }, texts);
  assert.strictEqual(other.topic.volume, '', '880 belongs to another keyword');
  const noSrc = KQ.checkFigures({ keyword: 'rooftop wedding nashville', volume: '2400', difficulty: '41', source: '' }, texts);
  assert.deepStrictEqual([noSrc.topic.volume, noSrc.topic.difficulty, noSrc.topic.source], ['', '', '']);
  const rounded = KQ.checkFigures({ keyword: 'rooftop wedding nashville', volume: '2.4k', difficulty: 'about 40', source: 'Ubersuggest' }, texts);
  assert.deepStrictEqual([rounded.topic.volume, rounded.topic.difficulty], ['', '']);
  const unknown = KQ.checkFigures({ keyword: 'not in any source', volume: '500', source: 'Ubersuggest' }, texts);
  assert.strictEqual(unknown.topic.volume, '');
});

test('the 90-day seen-before rule: same venue + keyword is skipped unless its rank dropped; past 90 days it is back', async () => {
  const at = { t: new Date('2026-10-01T12:00:00Z') };
  const store = createMemoryStore({ lint, now: () => at.t });
  const old = (keyword, venue, rank) => ({ n: 1, keyword, venue, rank: String(rank), key: KQ.topicKey(venue, keyword) });
  await store.insert({ agent: 'keyword-queen', agent_name: 'Keyword Queen', job: 'j', title: 'old', body: 'b', status: 'ready',
    payload: { topics: [old('nashville wedding idea 1', 'Saddle Woods Farm', 8), old('nashville wedding idea 2', 'The Bell Tower', 8)] } });
  at.t = new Date('2026-07-01T12:00:00Z');
  await store.insert({ agent: 'keyword-queen', agent_name: 'Keyword Queen', job: 'j', title: 'older', body: 'b', status: 'rejected',
    payload: { topics: [old('nashville wedding idea 4', 'The Bell Tower', 5)] } });
  const now = new Date('2026-11-10T12:00:00Z');
  const ranked = [...UBER.split('\n'), '| nashville wedding idea 2 | rank | 15 |'].join('\n');
  const rows = [
    row(1, 'One', 'nashville wedding idea 1', 'Saddle Woods Farm', 1000, 20),
    `| 2 | Two | nashville wedding idea 2 | The Bell Tower | 1010 | 21 | 15 | Ubersuggest + Search Console | Rank fell. |`,
    row(3, 'Four', 'nashville wedding idea 4', 'The Bell Tower', 1030, 23),
    row(4, 'One elsewhere', 'nashville wedding idea 1', 'The Bridge Building', 1000, 20),
  ];
  const card = JSON.parse(cardJson(rows)).cards[0];
  const got = [{ label: '05_AI_and_Brain/Venue_Master_CANONICAL.md', type: 'file', text: MASTER }, { label: 'u', type: 'file', text: ranked }];
  const out = await KQ.finishCard(card, { got, store, now });
  const kept = out.topics.map((x) => `${x.keyword} @ ${x.venue}`);
  assert.ok(!kept.includes('nashville wedding idea 1 @ Saddle Woods Farm'), 'suggested 40 days ago: skipped');
  assert.ok(kept.includes('nashville wedding idea 2 @ The Bell Tower'), 'rank dropped 8 -> 15: back');
  assert.ok(kept.includes('nashville wedding idea 4 @ The Bell Tower'), 'over 90 days ago: back');
  assert.ok(kept.includes('nashville wedding idea 1 @ The Bridge Building'), 'another venue is another key');
  assert.match(out.body, /suggested in the last 90 days/);
  assert.match(out.body, /its rank dropped from 8 to 15/);
  assert.deepStrictEqual(KQ.seenVerdict({ rank: null, card: 1 }, '30').keep, false, 'an unmeasured old rank is not a drop');
});

test('without the venue master the card keeps no topic (fails closed)', async () => {
  const card = JSON.parse(cardJson(TEN)).cards[0];
  const out = await KQ.finishCard(card, { got: [{ label: 'u', type: 'file', text: UBER }], store: null });
  assert.strictEqual(out.topics.length, 0);
  assert.match(out.body, /Venue_Master_CANONICAL.md was not read this run/);
});

test('venues come only from the master: names, "The" forms and codes; never Kitchen or Off Site', () => {
  const v = KQ.canonicalVenues(MASTER);
  assert.strictEqual(KQ.venueOf('Bridge Building', v), 'The Bridge Building');
  assert.strictEqual(KQ.venueOf('TBT', v), 'The Bell Tower');
  assert.strictEqual(KQ.venueOf('St. Elle', v), 'Saint Elle');
  assert.strictEqual(KQ.venueOf('Dream Events & Catering', v), 'Dream Events & Catering');
  assert.strictEqual(KQ.venueOf('Off Site', v), null);
  assert.strictEqual(KQ.venueOf('Catering Kitchen', v), null);
  assert.strictEqual(KQ.venueOf('The Moon Hotel', v), null);
});

test('a live post covering the keyword is not suggested', () => {
  assert.ok(KQ.coveredByPost('rooftop wedding nashville', '- thebelltower.com: Your Nashville rooftop wedding guide (2026-03-01)'));
  assert.strictEqual(KQ.coveredByPost('barn wedding murfreesboro', '- thebelltower.com: Rooftop wedding guide'), null);
});

test('approving one topic creates exactly one Bloggy Bob request, at the person\'s priority, under their name', async () => {
  const store = createMemoryStore({ lint });
  const card = await store.insert({ agent: 'keyword-queen', agent_name: 'Keyword Queen', job: 'j', title: 't', body: 'b',
    payload: { topics: [{ n: 1, topic: 'Rooftop vows', keyword: 'rooftop wedding nashville', venue: 'The Bell Tower', volume: '2400', difficulty: '41', source: 'Ubersuggest weekly 11.05.2026', why_now: 'Spring.' },
      { n: 2, topic: 'Two', keyword: 'k2', venue: 'Saddle Woods Farm', volume: '', difficulty: '', source: '', why_now: 'x' }] } });
  const who = 'katherine@infinityhospitality.net';
  const a = await KQ.approveTopic({ card, n: 1, who, store, env: ON });
  assert.ok(a.request);
  const again = await KQ.approveTopic({ card, n: 1, who, store, env: ON });
  assert.ok(again.already, 'a second press queues nothing');
  const reqs = await store.runRequests(50);
  assert.strictEqual(reqs.length, 1);
  assert.strictEqual(reqs[0].agent, 'bloggy-bob');
  assert.strictEqual(reqs[0].requested_by, who);
  assert.strictEqual(reqs[0].priority, P.PRIORITY.person);
  assert.match(reqs[0].ask, /keyword: rooftop wedding nashville · site: The Bell Tower · post type: blog post/);
  assert.match(reqs[0].ask, /monthly volume 2400, difficulty 41 \(source: Ubersuggest weekly 11.05.2026\)/);
  assert.deepStrictEqual(await KQ.queuedTopics(card, store), [1]);
  assert.strictEqual((await KQ.approveTopic({ card, n: 9, who, store, env: ON })).status, 404);
  assert.strictEqual((await KQ.approveTopic({ card, n: 2, who: null, store, env: ON })).status, 403);
  card.status = 'rejected';
  assert.strictEqual((await KQ.approveTopic({ card, n: 2, who, store, env: ON })).status, 409);
});

test('the route and the Review button exist; no em dash in her lines', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'agents.js'), 'utf8');
  assert.match(route, /r\.post\('\/api\/agents\/keyword-queen\/cards\/:id\/topics\/:n\/approve', need,/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
  assert.match(html, /\$\{topicsHtml\(c\)\}/);
  assert.match(html, /data-a="topic"/);
  const c = require('../lib/agent-voices').loadScript().find((x) => x.slug === 'keyword-queen');
  assert.strictEqual(c.lines.length, 10);
  for (const l of c.lines) assert.doesNotMatch(l, /—/);
});
