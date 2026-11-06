'use strict';
// ORDER #3047: the Scout watches the top competitors on Katherine's "IHG
// Competitors" sheet (#1668 rule: on 3+ tabs or marked Top; our own venues
// skipped) plus any site added on its page; the page wins on a duplicate. A
// Scout dry run reads the sheet too, so it previews the list Monday will use,
// and `scout --dry --watch-list` prints that list without fetching anything.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { scoutWatchList, sourceLabel, REGISTRY } = require('../lib/agent-sources');
const { parseSheet } = require('../lib/competitor-sheet');
const { main, parseArgs } = require('../jobs/agent_run');
const { watchNeed } = require('../routes/agents');

const H = ['Name', 'URL', 'Notes', 'Top'];
const TABS = [
  { title: 'TBB - Competitors', rows: [H, ['Riverline Hall', 'riverlinehall.com', '', ''], ['Oak Chapel', 'oakchapel.com', '', 'Y'], ['Small Barn', 'smallbarn.com', '', ''], ['The Bridge Building', 'thebridgebuilding.com', '', '']] },
  { title: 'TBT - Competitors', rows: [H, ['Riverline Hall', 'https://www.riverlinehall.com/', '', '']] },
  { title: 'ECD - Competitors', rows: [H, ['Riverline Hall', 'riverlinehall.com', '', '']] },
];
const fakeDrive = () => ({
  serviceAccount: 'sa@x.iam',
  async getJson(url) {
    if (!/values:batchGet/.test(url)) return { sheets: TABS.map((t) => ({ properties: { title: t.title } })) };
    return { valueRanges: TABS.map((t) => ({ values: t.rows })) };
  },
});

test('#3047 watch list: sheet tops only, our venues skipped, page entries first and win on duplicates', async () => {
  const store = createMemoryStore({ lint });
  await store.syncCompetitors(parseSheet(TABS).competitors);
  let w = await scoutWatchList(store, 'scout');
  assert.deepStrictEqual(w.list.map((x) => x.site).sort(), ['oakchapel.com', 'riverlinehall.com']);
  assert.strictEqual(w.fromSheet, 2);
  assert.strictEqual(w.fromPage, 0);
  assert.ok(!w.list.some((x) => x.site === 'smallbarn.com'), 'one tab, not marked Top: not watched');
  assert.ok(!w.list.some((x) => x.site === 'thebridgebuilding.com'), 'our own venue is never watched');

  assert.ok(!(await store.addWatch('scout', 'riverlinehall.com', 'Riverline (Katherine)', 'k@x')).error);
  assert.ok(!(await store.addWatch('scout', 'newplace.com', '', 'k@x')).error);
  w = await scoutWatchList(store, 'scout');
  assert.strictEqual(w.fromPage, 2);
  assert.strictEqual(w.fromSheet, 1, 'riverline came from the page, so the sheet adds only oak chapel');
  const river = w.list.filter((x) => x.site === 'riverlinehall.com');
  assert.strictEqual(river.length, 1);
  assert.strictEqual(river[0].label, 'Riverline (Katherine)');
  assert.strictEqual(river[0].from_sheet, false);
  assert.strictEqual(w.list[0].from_sheet, false, 'page entries come first');
});

test('#3047 the source reads the same list and names the sheet when empty', async () => {
  const empty = createMemoryStore({ lint });
  const r = await REGISTRY.competitor_watch({}, { store: empty, agent: 'scout' });
  assert.match(r.why, /no competitors listed yet/);
  assert.match(r.why, /IHG Competitors sheet/);
  assert.match(sourceLabel({ type: 'competitor_watch' }), /IHG Competitors sheet/);
});

test('#3047 scout --dry --watch-list reads the sheet read-only, prints the list, fetches nothing', async () => {
  assert.strictEqual(parseArgs(['scout', '--dry', '--watch-list']).watchList, true);
  const lines = [];
  let fetched = 0;
  const code = await main({ argv: ['scout', '--dry', '--watch-list'], log: (l) => lines.push(l), llm: null, env: {},
    fetchImpl: async () => { fetched++; throw new Error('no fetch in a watch-list run'); }, driveFactory: fakeDrive });
  assert.strictEqual(code, 0);
  assert.strictEqual(fetched, 0);
  const out = lines.join('\n');
  assert.match(out, /scout watch list: 2 competitor site\(s\), 2 from the IHG Competitors sheet, 0 added on the Scout's page/);
  assert.match(out, /sheet {2}Riverline Hall \(riverlinehall\.com\)/);
  assert.match(out, /sheet {2}Oak Chapel \(oakchapel\.com\)/);
});

test('#3047 --watch-list outside a scout dry run is refused; no service account says so', async () => {
  const lines = [];
  assert.strictEqual(await main({ argv: ['scout', '--watch-list'], log: (l) => lines.push(l), llm: null, env: {}, driveFactory: fakeDrive }), 2);
  const l2 = [];
  const code = await main({ argv: ['scout', '--dry', '--watch-list'], log: (l) => l2.push(l), llm: null, env: {},
    driveFactory: () => { throw new Error('ENOENT sa-key.json'); } });
  assert.strictEqual(code, 1, 'an empty list exits 1');
  assert.match(l2.join('\n'), /no service account key/);
  assert.match(l2.join('\n'), /sheet not read/);
});

test('#3047 the page no longer says the Scout is waiting on a list when the sheet supplies one', () => {
  const c = { needs: ['competitor websites (IHG Competitors sheet, plus any added on this page): not read'] };
  assert.strictEqual(watchNeed(c, [], 29), c);
  const empty = watchNeed(c, [], 0);
  assert.match(empty.needs[0], /IHG Competitors sheet/);
  assert.strictEqual(empty.needs.length, 1);
});

test('#3047 the card copy', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
  assert.ok(html.includes('Watches the competitors on your IHG Competitors sheet. Add others here.'));
  const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'scout', 'agent.json'), 'utf8'));
  assert.match(def.character.does[0], /^Watches the competitors on your IHG Competitors sheet\. Add others here\./);
});
