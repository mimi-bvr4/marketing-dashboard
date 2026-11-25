// ORDER #3811 (#3791 follow-on): the Keyword Queen reads the Search Console
// content gaps file the Box writes, instead of a `pending` Search Console source.
// A temp tree only: nothing here reaches Search Console, WordPress or a live queue.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadAgent } = require('../lib/agent-runner');
const S = require('../lib/agent-sources');

const STEM = '07_Marketing_and_Brand/SEO_Data/GSC_Content_Gaps_';

test('her Search Console source is the newest content-gaps file, not pending', () => {
  const d = loadAgent('keyword-queen');
  assert.ok(!d.sources.some((s) => s.type === 'pending'), 'no pending source left');
  const gsc = d.sources.find((s) => s.newest === STEM);
  assert.ok(gsc, 'a newest-file source on the GSC_Content_Gaps_ stem');
  assert.strictEqual(gsc.type, 'file');
  assert.strictEqual(gsc.label, 'Search Console content gaps, last 12 months (the Box, read-only)');
  assert.ok(!d.character.needs.some((n) => /Search Console access|#2958/.test(n)), 'the #2958 need is gone');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'agents', 'keyword-queen', 'agent.json'), 'utf8'), /—/);
});

test('the newest gaps file wins by the date in its name, across a year', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kq3811-'));
  const dir = path.join(d, '07_Marketing_and_Brand', 'SEO_Data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'GSC_Content_Gaps_2026-12-01.md'), 'december gaps');
  fs.writeFileSync(path.join(dir, 'GSC_Content_Gaps_2027-01-01.md'), 'january gaps');
  fs.writeFileSync(path.join(dir, 'GSC_Content_Gaps_2026-11-25.md'), 'first gaps');
  const gsc = loadAgent('keyword-queen').sources.find((s) => s.newest === STEM);
  const r = await S.fileSource(gsc, { env: { IHG_TREE: d } });
  assert.ok(r.ok, r.why);
  assert.match(r.text, /january gaps/);
});

test('no gaps file yet: the source says so, never breaks the run', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kq3811-'));
  const gsc = loadAgent('keyword-queen').sources.find((s) => s.newest === STEM);
  const r = await S.fileSource(gsc, { env: { IHG_TREE: d } });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /GSC_Content_Gaps_/);
});
