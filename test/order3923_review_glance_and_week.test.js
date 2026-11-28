'use strict';
// ORDER #3923 (Mimi 11.28.2026, for Katherine): Review cards readable at a
// glance (one row each, Approve and "No action (archive)" on the row, three
// groups with counts), a one-time archive tip, and the team's week open at the
// top of /agents with every scheduled agent once per run day. Layout only:
// nothing here approves, archives, moves or sends anything.
// No express here, so it runs in a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const G = require('../lib/review-groups');
const W = require('../lib/week-view');
const P = require('../lib/producer');
const V = require('../public/agents-view');
const AW = require('../lib/approve-will');
const CA = require('../lib/card-action');
const { dueAgents } = require('../jobs/agent_run');

const REVIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'review.html'), 'utf8');
const AGENTS = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
const ON = { PRODUCER_CALENDAR: 'on' };

function renderers() {
  const start = REVIEW.indexOf('  const esc = ');
  const end = REVIEW.indexOf('  let cache = [];');
  assert.ok(start > 0 && end > start);
  const ctx = vm.createContext({});
  vm.runInContext(`${REVIEW.slice(start, end)}; this.cardHtml = cardHtml; this.rowHtml = rowHtml; this.groupedHtml = groupedHtml;`, ctx);
  return ctx;
}
// A card shaped the way routes/review.js sends it.
function shaped(extra) {
  const c = { id: 1, status: 'draft', agent: 'scout', agent_name: 'Scout', job: 'ideas', title: 'A draft', body: 'Body.', sources: [], checks: {}, payload: null, handoff: null, created_at: '2026-11-27T15:00:00Z', ...extra };
  const w = AW.approveWill(c); if (w) c.approve_will = w;
  c.action = CA.actionLine(c, {});
  c.group = G.groupOfKind(c.action.kind);
  return c;
}
const gbpPost = (id) => shaped({ id, agent: 'gbp', agent_name: 'Google Business', title: 'Post idea', target: 'The Cordelle', payload: { gbp_post: { venue: 'The Cordelle', summary: 'Fall weddings at The Cordelle.' } } });
const report = (id) => shaped({ id, agent: 'site-health', agent_name: 'Site Health', title: 'Weekly site check' });
// Not a report agent (lib/approve-will.js REPORT_AGENTS), so a plain "Mark ready" card.
const plain = (id) => shaped({ id, agent: 'convention-connector', agent_name: 'Convention Connector', title: 'Ten planners' });

// ---------- groups ----------

test('three groups, in this order, with the order\'s words', () => {
  assert.deepStrictEqual(G.GROUPS.map((g) => g.label), ['Will go out when you approve', 'For you to read and decide', 'Reports, nothing to do']);
});

test('the group comes from the card\'s own action type, never the title', () => {
  for (const k of ['post', 'pin', 'gbp_post']) assert.strictEqual(G.groupOfKind(k), 'out', k);
  for (const k of ['sales', 'topics', 'tell', 'fix', 'plain']) assert.strictEqual(G.groupOfKind(k), 'decide', k);
  assert.strictEqual(G.groupOfKind('report'), 'reports');
  // A report whose title reads like a post is still a report.
  assert.strictEqual(G.groupOf({ agent: 'site-health', title: 'Post this to Google now' }), 'reports');
  assert.strictEqual(G.groupOf({ agent: 'scout', title: 'Weekly report', payload: { pin: { title: 'x' } } }), 'out');
});

test('group counts add up to the pile count', () => {
  const pile = [gbpPost(1), report(2), plain(3), plain(4), gbpPost(5), report(6), plain(7)];
  const groups = G.groupCards(pile);
  assert.strictEqual(groups.reduce((n, g) => n + g.count, 0), pile.length);
  assert.deepStrictEqual(groups.map((g) => g.count), [2, 3, 2]);
  const { groupedHtml } = renderers();
  const html = groupedHtml(pile);
  const counts = [...html.matchAll(/<span class="badge" data-count>(\d+)<\/span>/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(counts, [2, 3, 2], 'the page shows the same counts, in the same order');
  assert.strictEqual(counts.reduce((a, b) => a + b, 0), pile.length);
  assert.ok(html.indexOf('Will go out when you approve') < html.indexOf('For you to read and decide'));
  assert.ok(html.indexOf('For you to read and decide') < html.indexOf('Reports, nothing to do'));
});

test('the server tags every card with its group from the action kind', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'review.js'), 'utf8');
  assert.match(src, /groupOfKind\(action\.kind\)/);
});

// ---------- the collapsed row ----------

test('a collapsed draft row shows the action line, Approve and the archive button', () => {
  const { cardHtml } = renderers();
  const html = cardHtml(gbpPost(9));
  const row = html.slice(html.indexOf('<div class="row"'), html.indexOf('<div class="full"'));
  assert.match(row, /Post this to The Cordelle Google Business Profile\./);
  assert.match(row, /data-a="approve">Approve</);
  assert.match(row, /data-a="archive">No action \(archive\)</);
  assert.match(row, /The Cordelle/, 'venue or brand');
  assert.match(row, /11\.27\.2026/, 'the date');
  assert.doesNotMatch(row, /data-a="(edit|reject|redo|copy)"/, 'Edit, Reject, Redo and Copy text live inside the opened card');
  assert.match(html, /class="card collapsed"/, 'cards start collapsed');
  assert.match(html, /<div class="full" id="full-9" hidden>/);
  const full = html.slice(html.indexOf('<div class="full"'));
  for (const a of ['copy', 'edit', 'reject', 'redo']) assert.match(full, new RegExp(`data-a="${a}"`), a);
  assert.doesNotMatch(full, /data-a="approve"|data-a="archive"/, 'each button once');
});

test('a report row keeps its one button, Got it', () => {
  const { rowHtml } = renderers();
  const row = rowHtml(report(3));
  assert.match(row, /data-a="archive">Got it</);
  assert.doesNotMatch(row, /data-a="approve"/);
});

test('the copy check is one plain word on the row', () => {
  const { rowHtml } = renderers();
  assert.match(rowHtml(plain(1)), /^(?![\s\S]*class="word)/, 'no check ran, no word');
  assert.match(rowHtml({ ...plain(1), checks: { copy_check: { ran: true, ready: true } } }), /class="word good">Clean</);
  assert.match(rowHtml({ ...plain(1), checks: { copy_check: { ran: true, ready: false } } }), /class="word bad">Fix</);
  assert.match(rowHtml({ ...plain(1), tells_detail: [{ blocks_ready: true }] }), /class="word bad">Fix</);
});

test('rows are not buttons for done cards: ready, rejected and archived rows carry no actions', () => {
  const { rowHtml } = renderers();
  for (const status of ['ready', 'rejected', 'archived']) assert.doesNotMatch(rowHtml({ ...plain(1), status }), /data-a=/, status);
});

// ---------- the archive tip and the short opening ----------

test('the archive tip says what it does in her terms, once, until hidden', () => {
  const tip = REVIEW.slice(REVIEW.indexOf('id="archiveTip"'), REVIEW.indexOf('</p>', REVIEW.indexOf('id="archiveTip"')));
  assert.match(tip, /takes a card off your pile/);
  assert.match(tip, /Nothing is sent/);
  assert.match(tip, /not told it was a bad draft/);
  assert.match(REVIEW, /<p class="tip" id="archiveTip" hidden>/, 'hidden until the script decides');
  assert.match(REVIEW, /localStorage\.getItem\(TIP_KEY\)/);
  assert.match(REVIEW, /localStorage\.setItem\(TIP_KEY, '1'\)/);
});

test('the opening paragraph is two lines and no longer explains Archive', () => {
  const m = REVIEW.match(/<p class="empty intro"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(m, 'the opening paragraph');
  const text = m[1].replace(/<[^>]+>/g, '');
  assert.ok(text.length <= 240, `two lines at desktop width (was ${text.length} characters)`);
  assert.doesNotMatch(text, /Archive/);
  assert.doesNotMatch(REVIEW, /Archive \(no action\)<\/strong> takes a card/);
});

test('no em dashes and no order numbers on what Katherine sees', () => {
  for (const [name, html] of [['review', REVIEW], ['agents', AGENTS]]) {
    const shown = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(shown, /3923/, name);
    assert.doesNotMatch(shown, /\u2014/, name);
  }
});

// ---------- the week ----------

const YMD = '2026-11-18'; // a Wednesday; the week is Mon 11.16 to Sun 11.22, the 15th is the Sunday before

test('the week renders every scheduled agent exactly once per run day', () => {
  for (const ymd of ['2026-11-18', '2026-12-02', '2026-12-15', '2026-11-30']) {
    const cal = P.calendar();
    const w = W.weekView({ ymd, cal, env: ON });
    assert.strictEqual(w.days.length, 7);
    const daily = new Set(cal.filter((e) => e.days && e.days.includes('daily')).map((e) => e.agent));
    for (const d of w.days) {
      const want = P.dueOn(d.ymd, cal).filter((a) => !daily.has(a)).sort();
      const got = d.chips.map((c) => c.agent).sort();
      assert.deepStrictEqual(got, want, `${ymd}: ${d.ymd}`);
      assert.strictEqual(new Set(got).size, got.length, `${d.ymd}: no agent twice`);
    }
    assert.deepStrictEqual(w.daily.map((c) => c.agent).sort(), [...daily].sort(), 'every-day agents once, in the band');
    // And the page draws exactly those chips.
    const html = V.weekHtml(w, () => null);
    for (const d of w.days) for (const c of d.chips) assert.strictEqual(html.split(`data-chip="${c.agent}|${d.key}"`).length - 1, 1, `${c.agent} on ${d.key}`);
    for (const c of w.daily) assert.strictEqual(html.split(`data-chip="${c.agent}|daily"`).length - 1, 1, `${c.agent} every day`);
  }
});

test('today is marked; monthly agents show on their date with "15th" and "3rd"', () => {
  const w = W.weekView({ ymd: '2026-12-15', env: ON }); // Tuesday the 15th
  assert.deepStrictEqual(w.days.filter((d) => d.today).map((d) => d.key), ['tue']);
  const tue = w.days.find((d) => d.key === 'tue');
  const cit = tue.chips.find((c) => c.agent === 'citations');
  assert.ok(cit, 'Citations sits on the 15th');
  assert.strictEqual(cit.on, '15th');
  assert.deepStrictEqual(w.monthly.map((m) => m.on).sort(), ['15th', '3rd']);
  assert.strictEqual(W.ordinal(1), '1st'); assert.strictEqual(W.ordinal(2), '2nd'); assert.strictEqual(W.ordinal(11), '11th'); assert.strictEqual(W.ordinal(23), '23rd');
  const html = V.weekHtml(w, () => null);
  assert.match(html, /class="wday today" data-day="tue" aria-current="date"/);
  assert.match(html, /15th, 06:00/);
});

test('each chip has a run time and its state in words', () => {
  const cal = P.calendar();
  const board = [{ slug: 'seo', state: 'ready' }, { slug: 'paid-ads', state: 'paused' }, { slug: 'pr-patty', state: 'ran' }];
  const history = new Map([['seo', [{ started_at: '2026-11-16T12:00:00Z', status: 'ok' }]], ['site-health', [{ started_at: '2026-11-16T12:01:00Z', status: 'failed' }]]]);
  const logs = new Map([['2026-11-16', [{ agent: 'scout', decision: 'held', why: '20 drafts waiting' }]]]);
  const w = W.weekView({ ymd: YMD, cal, board, history, logs, env: ON });
  const on = (key, agent) => w.days.find((d) => d.key === key).chips.find((c) => c.agent === agent);
  assert.strictEqual(on('mon', 'seo').word, 'ran');
  assert.strictEqual(on('mon', 'site-health').word, 'failed');
  assert.strictEqual(on('mon', 'scout').word, 'held by the brake');
  assert.strictEqual(on('thu', 'paid-ads').word, 'paused');
  assert.strictEqual(on('fri', 'engagement-sleuth').word, 'due');
  for (const d of w.days) for (const c of d.chips) {
    assert.match(c.time, /^\d\d:\d\d/, `${c.agent} has a time`);
    assert.ok(Object.values(W.WORDS).includes(c.word), `${c.agent} has a state word`);
  }
  const html = V.weekHtml(w, () => null);
  assert.match(html, /class="wchip st-held"[\s\S]*?<span class="wstate">held by the brake<\/span>/);
});

test('run times come from the launchd jobs: 06:00, and PR Patty in the evening when her switch is on', () => {
  const plist = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'launchd', 'com.infinitybrain.marketing-agents.plist'), 'utf8');
  assert.match(plist, /<key>Hour<\/key>\s*<integer>6<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.strictEqual(W.runTime('seo', {}), '06:00');
  assert.strictEqual(W.runTime('pr-patty', {}), '06:00');
  assert.strictEqual(W.runTime('pr-patty', { PATTY_EVENING_RUN: 'on' }), '16:00 to 18:15');
});

test('with the Producer\'s calendar off, the week is the fixed schedule that runs (dueAgents)', () => {
  for (let i = 0; i < 35; i++) {
    const d = new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
    const fromLegacy = P.dueOn(d, W.LEGACY_WEEK).sort();
    const fromJob = dueAgents(d).sort();
    // dueAgents drops paused and card-only agents; the week shows them as "paused" instead.
    assert.ok(fromJob.every((a) => fromLegacy.includes(a)), `${d}: ${fromJob} within ${fromLegacy}`);
  }
  const w = W.weekView({ ymd: YMD, env: {} });
  assert.strictEqual(w.producer_on, false);
  assert.ok(w.days.every((d) => d.chips.every((c) => !c.movable)), 'no day picker while the calendar is off');
});

test('Katherine\'s day picker stays, opened from the chip, on weekly agents only', () => {
  const w = W.weekView({ ymd: YMD, env: ON });
  const html = V.weekHtml(w, () => null);
  assert.match(html, /<details class="pick"><summary>Move [^<]+<\/summary>\s*<select data-movesel="seo" data-from="mon"/);
  assert.doesNotMatch(html, /data-movesel="(gbp|pr-patty|citations|monthly-report)"/);
});

test('/agents: the week is open by default, at the top, before the Producer card', () => {
  assert.match(AGENTS, /return V\.weekHtml\(producer\.week, portraitOf\);/);
  const roster = AGENTS.slice(AGENTS.indexOf('function rosterHtml()'));
  assert.ok(roster.indexOf('${weekHtml()}') > 0 && roster.indexOf('${weekHtml()}') < roster.indexOf('${producerHtml()}'));
  assert.doesNotMatch(V.weekHtml(W.weekView({ ymd: YMD, env: ON }), () => null), /hidden/, 'nothing in it starts hidden');
  // A phone: one column, today first.
  assert.match(AGENTS, /@media \(max-width: 720px\) \{\s*\.wdays \{ grid-template-columns: 1fr; \}\s*\.wday\.today \{ order: -1; \}/);
});

test('the route sends the week, read only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'agents.js'), 'utf8');
  assert.match(src, /W\.weekView\(\{ ymd, cal, board, history, logs/);
  const at = src.indexOf("r.get('/api/producer'");
  const block = src.slice(at, src.indexOf('r.get(', at + 10));
  assert.doesNotMatch(block, /setCalendarDays|producerLog|decide\(/, 'GET /api/producer writes nothing');
});
