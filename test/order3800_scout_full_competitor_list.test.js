'use strict';
// ORDER #3800 (Mimi 11.24.2026): "See the list of competitors that we have
// established already. Needs to be the full list and not just the top."
// Every row on every tab of the IHG Competitors sheet is watched, deduped
// across tabs; the top ones every week, the rest in a stated rotation so each
// is read at least once every ROTATION_WEEKS weeks.
const { test } = require('node:test');
const assert = require('node:assert');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { scoutWatchList, rotationLine, REGISTRY } = require('../lib/agent-sources');
const { parseSheet } = require('../lib/competitor-sheet');
const R = require('../lib/competitor-rotation');

const H = ['Name', 'URL', 'Notes', 'Top'];
const small = Array.from({ length: 40 }, (_, i) => [`Barn ${i}`, `barn${i}.com`, '', '']);
const TABS = [
  { title: 'TBB - Competitors', rows: [H, ['Riverline Hall', 'riverlinehall.com', '', ''], ['Oak Chapel', 'oakchapel.com', '', 'Y'], ...small.slice(0, 25), ['The Bridge Building', 'thebridgebuilding.com', '', '']] },
  { title: 'TBT - Competitors', rows: [H, ['Riverline Hall', 'https://www.riverlinehall.com/', '', ''], ...small.slice(20)] },
  { title: 'ECD - Competitors', rows: [H, ['Riverline Hall', 'riverlinehall.com', '', '']] },
];
const MON = new Date('2026-11-23T18:00:00Z');
const weeks = (n) => new Date(MON.getTime() + n * 7 * 86400000);

async function seeded() {
  const store = createMemoryStore({ lint });
  await store.syncCompetitors(parseSheet(TABS).competitors);
  return store;
}

test('#3800 every sheet competitor is covered within one cycle, each exactly once', async () => {
  const store = await seeded();
  const all = (await store.competitors()).map((c) => c.site);
  assert.strictEqual(all.length, 42, '40 barns + riverline + oak chapel, deduped across tabs, our own venue skipped');
  const seen = new Map();
  for (let i = 0; i < R.ROTATION_WEEKS; i++) {
    const w = await scoutWatchList(store, 'scout', { now: weeks(i) });
    for (const x of w.list) seen.set(x.site, (seen.get(x.site) || 0) + 1);
    assert.strictEqual(w.sheetTotal, 42);
  }
  for (const s of all) assert.ok(seen.has(s), `${s} was never read in a ${R.ROTATION_WEEKS}-week cycle`);
  assert.strictEqual(seen.get('oakchapel.com'), R.ROTATION_WEEKS, 'marked Top: every week');
  assert.strictEqual(seen.get('riverlinehall.com'), R.ROTATION_WEEKS, 'on 3 tabs: every week');
  for (const s of all.filter((x) => /^barn/.test(x))) assert.strictEqual(seen.get(s), 1, `${s}: once per cycle, never twice`);
});

test('#3800 KNOWN-BAD: the old top-only list would have left the non-top rows out', async () => {
  const store = await seeded();
  const topOnly = (await store.competitors()).filter((c) => c.top).map((c) => c.site);
  assert.strictEqual(topOnly.length, 2, 'the #3047 rule watched 2 of 42');
  const w = await scoutWatchList(store, 'scout', { now: MON });
  assert.strictEqual(w.list.length + w.rotation.later.length, 42, 'this run plus later = the whole sheet');
  assert.ok(w.list.length > topOnly.length, 'this run reads more than the tops');
});

test('#3800 a site keeps its week when the sheet changes', async () => {
  const store = await seeded();
  const before = await scoutWatchList(store, 'scout', { now: MON });
  const tabs = JSON.parse(JSON.stringify(TABS));
  tabs[0].rows.push(['New Hall', 'newhall.com', '', ''], ['Another', 'another.com', '', '']);
  tabs[1].rows = tabs[1].rows.filter((r) => r[1] !== 'barn39.com');
  await store.syncCompetitors(parseSheet(tabs).competitors);
  const after = await scoutWatchList(store, 'scout', { now: MON });
  const was = new Set(before.list.map((x) => x.site));
  for (const x of after.list) if (!['newhall.com', 'another.com'].includes(x.site)) assert.ok(was.has(x.site), `${x.site} moved weeks`);
  assert.ok(!after.list.some((x) => x.site === 'barn39.com') && !after.rotation.later.some((x) => x.site === 'barn39.com'), 'a row taken off the sheet is no longer watched');
});

test('#3800 a top competitor over the weekly cap joins the rotation instead of being dropped', async () => {
  const W = require('../lib/agent-watch');
  const tops = Array.from({ length: W.MAX_WATCH + 25 }, (_, i) => [`Top ${i}`, `top${i}.com`, '', 'Y']);
  const store = createMemoryStore({ lint });
  await store.syncCompetitors(parseSheet([{ title: 'TBB - Competitors', rows: [H, ...tops] }]).competitors);
  const seen = new Set();
  for (let i = 0; i < R.ROTATION_WEEKS; i++) for (const x of (await scoutWatchList(store, 'scout', { now: weeks(i) })).list) seen.add(x.site);
  assert.strictEqual(seen.size, tops.length, 'every top read within the cycle');
  const w = await scoutWatchList(store, 'scout', { now: MON });
  assert.strictEqual(w.rotation.weekly, W.MAX_WATCH + 20);
});

test('#3800 the plan is stated on the card and the page', async () => {
  const store = await seeded();
  const w = await scoutWatchList(store, 'scout', { now: MON });
  const line = rotationLine(w);
  assert.match(line, /^Watch plan: 42 competitor\(s\) on the IHG Competitors sheet\./);
  assert.match(line, /2 read every week/);
  assert.match(line, /the other 40 take turns, one group a week, so each is read at least once every 4 weeks/);
  assert.match(line, new RegExp(`This run is group ${R.slotThisWeek(MON) + 1} of 4: ${w.rotation.thisRun} of those 40, so ${w.list.length} sites in all\\.`));
  assert.ok(!/—/.test(line), 'no em dash');
  // The source puts the plan above its table, so the model and the card both see it.
  const hosts = new Set();
  const r = await REGISTRY.competitor_watch({ pages_per_site: 1 }, { store, agent: 'scout', dryRun: true, now: MON,
    fetch: async (u) => { hosts.add(new URL(u).hostname); return { status: 200, headers: { get: () => 'text/html' }, text: async () => '<html><title>Hi</title><body><p>Hello there.</p></body></html>' }; } });
  assert.strictEqual(r.ok, true, r.why);
  assert.ok(r.table.startsWith(line), 'the plan heads the measured table');
  assert.match(r.text, /up to 4 weeks ago for the ones that take turns/);
  assert.deepStrictEqual([...hosts].sort(), w.list.map((x) => x.site).sort(), 'only this run\'s sites are fetched');
});

test('#3800 the week number is the Nashville week, starting Monday', () => {
  // Sunday 11.22.2026 23:30 CT is 05:30 UTC Monday: still the earlier week in Nashville.
  assert.strictEqual(R.weekNumber(new Date('2026-11-23T05:30:00Z')), R.weekNumber(new Date('2026-11-22T12:00:00Z')));
  assert.strictEqual(R.weekNumber(new Date('2026-11-23T12:00:00Z')), R.weekNumber(new Date('2026-11-22T12:00:00Z')) + 1);
  assert.strictEqual(R.weekNumber(new Date('2026-11-29T12:00:00Z')), R.weekNumber(new Date('2026-11-23T12:00:00Z')), 'Mon to Sun is one week');
});
