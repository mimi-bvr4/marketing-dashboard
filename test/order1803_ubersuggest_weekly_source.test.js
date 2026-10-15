// ORDER #1803: the SEO agent and Bloggy Bob read the Box's weekly Ubersuggest file.
// The Box (brain-core box_jobs/seo_weekly) writes
// 07_Marketing_and_Brand/SEO_Data/Ubersuggest_Weekly_<YYYY-MM-DD>.md; the agents
// take the newest one as an OPTIONAL source, so a week with no file never stops a run.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fileSource } = require('../lib/agent-sources');

const STEM = '07_Marketing_and_Brand/SEO_Data/Ubersuggest_Weekly_';
const agent = (slug) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', slug, 'agent.json'), 'utf8'));

for (const slug of ['seo', 'bloggy-bob']) {
  test(`${slug}: reads the newest Ubersuggest weekly file, and it is optional`, () => {
    const hits = agent(slug).sources.filter((s) => s.type === 'file' && s.newest === STEM);
    assert.strictEqual(hits.length, 1);
    assert.notStrictEqual(hits[0].required, true);
    assert.match(hits[0].label, /Ubersuggest/);
  });
}

test('seo: no longer says it cannot give volumes or difficulty', () => {
  const traits = JSON.stringify(agent('seo').character.traits);
  assert.doesNotMatch(traits, /volumes come once an SEO tool is connected/);
});

test('the newest weekly file wins by the date in its name, and a missing folder is reported, not guessed', async () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'ihg1803-'));
  const env = { IHG_TREE: tree };
  const none = await fileSource({ type: 'file', newest: STEM }, { env });
  assert.strictEqual(none.ok, false);
  const dir = path.join(tree, '07_Marketing_and_Brand', 'SEO_Data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Ubersuggest_Weekly_2026-12-31.md'), 'old');
  fs.writeFileSync(path.join(dir, 'Ubersuggest_Weekly_2027-01-07.md'), 'new');
  const got = await fileSource({ type: 'file', newest: STEM }, { env });
  assert.deepStrictEqual([got.ok, got.text], [true, 'new']);
});
