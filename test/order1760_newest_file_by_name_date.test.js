'use strict';
// ORDER #1760: a "newest" file source picks by the date in the name, not by the
// name sorted as text. Known-bad case: 12.20.2026 vs 01.05.2027 (red on main,
// where "12" sorts after "01" and the December file wins).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gather } = require('../lib/agent-sources');

const lint = () => ({ fails: [], flags: [] });

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree1760-'));
  fs.mkdirSync(path.join(root, 'M'));
  for (const [name, text, mtime] of files) {
    const p = path.join(root, 'M', name);
    fs.writeFileSync(p, text);
    if (mtime) fs.utimesSync(p, mtime, mtime);
  }
  return { IHG_TREE: root };
}

const pick = async (env, newest) => (await gather([{ type: 'file', newest }], { env, lint })).got[0].text;

test('MM.DD.YYYY across a year: January 2027 beats December 2026', async () => {
  const env = tree([['DIRECTORY_LISTINGS_DRAFT_12.20.2026.md', 'december'], ['DIRECTORY_LISTINGS_DRAFT_01.05.2027.md', 'january']]);
  assert.strictEqual(await pick(env, 'M/DIRECTORY_LISTINGS_DRAFT_'), 'january');
});

test('YYYY-MM-DD names pick the latest date', async () => {
  const env = tree([['W1_AUDIT_2026-12-20.md', 'december'], ['W1_AUDIT_2027-01-05.md', 'january'], ['W1_AUDIT_2026-06-30.md', 'june']]);
  assert.strictEqual(await pick(env, 'M/W1_AUDIT_'), 'january');
});

test('a _RECHECKED file on the same date wins over the plain one', async () => {
  const env = tree([['W2_AUDIENCES_DRAFT_10.09.2026_RECHECKED.md', 'rechecked'], ['W2_AUDIENCES_DRAFT_10.09.2026.md', 'plain'], ['W2_AUDIENCES_DRAFT_10.01.2026.md', 'older']]);
  assert.strictEqual(await pick(env, 'M/W2_AUDIENCES_DRAFT_'), 'rechecked');
});

test('names with no date fall back to the modified time', async () => {
  const env = tree([['Notes_b.md', 'older', new Date('2026-01-01T00:00:00Z')], ['Notes_a.md', 'newer', new Date('2026-10-01T00:00:00Z')]]);
  assert.strictEqual(await pick(env, 'M/Notes_'), 'newer');
});
