'use strict';
// ORDER #2919 (#2918 step 2, re-queued): the 06:00 run's one team health line
// also lands in a file inside the project tree, so Mimi Today (brain-core
// box_jobs/mimi_today/mimi_today.py) can show it on her morning page:
//   05_AI_and_Brain/box_driver_state/marketing_team_health.txt
// One line: "<MM.DD.YYYY HH:MM> CT | <the summary line>". Overwritten each
// morning, written atomically, never outside the tree, and a write that fails
// is one log line, never a crash of the 06:00 run.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = require('../lib/team-health');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const YMD = '2026-11-04';
const NOW = new Date('2026-11-04T12:05:00Z'); // 06:05 CST
const DEFS = [{ slug: 'gbp', name: 'Google Business', sources: [] }];

test('the health file path is inside the project tree, under box_driver_state', () => {
  assert.strictEqual(H.healthFile('/x/Full_IH_Project'), path.join('/x/Full_IH_Project', '05_AI_and_Brain', 'box_driver_state', 'marketing_team_health.txt'));
  assert.strictEqual(H.healthFile(null), null, 'no tree, no file');
});

test('the stamped line: MM.DD.YYYY HH:MM CT | line', () => {
  assert.strictEqual(H.stampedLine('Marketing team 11.04: all clear.', NOW), '11.04.2026 06:05 CT | Marketing team 11.04: all clear.\n');
});

test('dailyStep writes the one line with a CT stamp, and overwrites it the next morning', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2919-'));
  const file = path.join(dir, 'box_driver_state', 'marketing_team_health.txt');
  const store = createMemoryStore({ lint, now: () => NOW });
  const lines = [];
  await H.dailyStep({ ymd: YMD, store, defs: DEFS, due: [], now: NOW, log: (l) => lines.push(l), inbox: null, env: {}, healthFile: file });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '11.04.2026 06:05 CT | Marketing team 11.04: all clear. 0 of 0 due runs ran, 0 drafts waiting.\n');
  const next = new Date('2026-11-05T12:06:00Z');
  await H.dailyStep({ ymd: '2026-11-05', store, defs: DEFS, due: [], now: next, log: (l) => lines.push(l), inbox: null, env: {}, healthFile: file });
  assert.match(fs.readFileSync(file, 'utf8'), /^11\.05\.2026 06:06 CT \| Marketing team 11\.05: /);
  assert.strictEqual(fs.readdirSync(path.dirname(file)).length, 1, 'no temp file left behind');
});

test('no health file: nothing written; a failed write is one log line, never a throw', async () => {
  const store = createMemoryStore({ lint, now: () => NOW });
  const lines = [];
  const out = await H.dailyStep({ ymd: YMD, store, defs: DEFS, due: [], now: NOW, log: (l) => lines.push(l), inbox: null, env: {} });
  assert.ok(out.health.line);
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h2919b-')), 'a-file');
  fs.writeFileSync(blocker, 'x');
  await H.dailyStep({ ymd: YMD, store, defs: DEFS, due: [], now: NOW, log: (l) => lines.push(l), inbox: null, env: {}, healthFile: path.join(blocker, 'sub', 'marketing_team_health.txt') });
  assert.ok(lines.some((l) => /^team health: line file not written: /.test(l)), lines.join('\n'));
});

test('the 06:00 run passes the tree\'s health file to dailyStep', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'agent_run.js'), 'utf8');
  assert.match(src, /healthFile: require\('\.\.\/lib\/team-health'\)\.healthFile\(root\)/);
});
