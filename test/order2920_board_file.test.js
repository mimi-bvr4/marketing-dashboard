// ORDER #2920: the 06:00 run writes the Producer's board lines into the tree,
// secret-free, so the Box can read why SEO, Email and Pinterest Paul are stuck.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../lib/board-file');

const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';

function fakeStore() {
  const calls = [];
  const runs = [
    { agent: 'pinterest-paul', started_at: '2026-10-28T11:00:00Z', status: 'failed', cards: 0, unavailable: [],
      note: `Pinterest said 401 for https://api.pinterest.com/v5/boards?access_token=${SECRET} (ask katherine@example.com)` },
    { agent: 'seo', started_at: '2026-11-02T12:00:00Z', status: 'ok', cards: 0,
      unavailable: [{ label: 'Search Console', why: 'none of our sites are open to the Box' }] },
  ];
  const store = new Proxy({
    calendarRows: async () => [],
    allCurrentSettings: async () => [],
    runHistory: async () => runs,
    producerDay: async () => [],
  }, { get(t, k) { if (typeof k === 'string' && typeof t[k] === 'function') calls.push(k); return t[k]; } });
  return { store, calls };
}

const defs = [
  { slug: 'seo', name: 'SEO', sources: [{ type: 'search-console', label: 'Search Console', required: true }] },
  { slug: 'pinterest-paul', name: 'Pinterest Paul', sources: [] },
  { slug: 'email', name: 'Email', sources: [] },
];

test('board rows are the board the /agents page shows, with failure and waiting reasons', async () => {
  const { store } = fakeStore();
  const rows = await B.boardRows({ ymd: '2026-11-04', store, defs });
  const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
  assert.strictEqual(by.seo.state, 'waiting');
  assert.match(by.seo.line, /^waiting on Search Console since 11\.02 \(none of our sites are open to the Box\)$/);
  assert.strictEqual(by['pinterest-paul'].state, 'failed');
  assert.match(by['pinterest-paul'].line, /^last run failed 10\.28: Pinterest said 401 for api\.pinterest\.com/);
  assert.strictEqual(by.email.state, 'ready');
});

test('the file is written under box_driver_state, one line per member, and carries no secret', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o2920-'));
  const { store, calls } = fakeStore();
  const logs = [];
  const out = await B.writeBoardFile({ ymd: '2026-11-04', store, defs, root, stamp: '11.04.2026 06:00 CT', log: (l) => logs.push(l) });
  assert.strictEqual(out.written, true);
  assert.strictEqual(out.file, path.join(root, '05_AI_and_Brain', 'box_driver_state', 'marketing_board_lines.txt'));
  const text = fs.readFileSync(out.file, 'utf8');
  const lines = text.trim().split('\n');
  assert.strictEqual(lines.length, 1 + defs.length);
  assert.match(lines[0], /11\.04\.2026 06:00 CT/);
  assert.ok(lines.some((l) => l.startsWith('pinterest-paul | Pinterest Paul | failed | last run failed 10.28:')));
  assert.ok(!text.includes(SECRET), 'the token never reaches the file');
  assert.ok(!text.includes('katherine@example.com'), 'an email never reaches the file');
  assert.ok(!fs.existsSync(`${out.file}.tmp`));
  // read only: nothing but the four board reads was called on the store
  assert.deepStrictEqual([...new Set(calls)].sort(), ['allCurrentSettings', 'calendarRows', 'producerDay', 'runHistory']);
  assert.match(logs[0], /^board file: 3 line\(s\) written/);
});

test('no tree on this machine: nothing is written and the log says so', async () => {
  const { store } = fakeStore();
  const logs = [];
  const out = await B.writeBoardFile({ ymd: '2026-11-04', store, defs, root: null, stamp: 'x', log: (l) => logs.push(l) });
  assert.strictEqual(out.written, false);
  assert.match(logs[0], /not written/);
});

test('a pipe or line break in a line cannot break the one-line-per-member shape', () => {
  const text = B.render([{ slug: 'a', name: 'A|B', state: 'failed', line: 'x\ny | z' }], 'now');
  assert.strictEqual(text.trim().split('\n').length, 2);
  assert.strictEqual(text.trim().split('\n')[1].split(' | ').length, 4);
});

test('the 06:00 --due run calls the board file step after the team health step', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'agent_run.js'), 'utf8');
  const h = src.indexOf("require('../lib/team-health').dailyStep");
  const b = src.indexOf("require('../lib/board-file')");
  assert.ok(h > 0 && b > h, 'board file step follows the health step');
  // the same `if (args.due && !args.dry) {` block as the health step: no other `if (` opens between them
  const guard = src.lastIndexOf('if (args.due && !args.dry) {', h);
  assert.ok(guard > 0);
  assert.ok(!/\n {2}if \(/.test(src.slice(guard + 10, b)), 'no new top-level block between the guard and the board step');
});

test('the Chicago stamp is MM.DD.YYYY HH:MM CT', () => {
  assert.strictEqual(B.chicagoStamp(new Date('2026-11-04T12:00:00Z')), '11.04.2026 06:00 CT');
});
