// ORDER #3498 (Mimi, 11.17.2026): THE BLOGGER, THE EMAIL WRITER and THE SEO LEAD
// read "Partly working" with no Waiting line. The pill counted EVERY reason in the
// last run's `unavailable`, while the Waiting box (#2958) shows only reasons still
// true. So a 14-day-old reason, or one for a source the agent no longer has, lit
// the pill and named nothing. Now the pill reads `gaps`, which is built from the
// same lines the Waiting box shows: no "Partly working" without its reason.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/agent-checks');
const { characterOf, gapsOf, liveMissing } = require('../routes/agents');
const { loadAgent } = require('../lib/agent-runner');

const NOW = new Date('2026-11-17T13:00:00-06:00');
const rows = (...r) => new Map(r.map((x) => [x.id, x]));
const UBER = 'Ubersuggest weekly: search volume, difficulty and top pages (the Box, read-only)';

test('Email Writer: its 11.03 run missed a source it no longer has, so nothing is missing now', () => {
  const email = loadAgent('email');
  // The 11.03 scheduled run read the HubSpot email statistics, which #2903 moved to the Monthly Report.
  const old = { label: 'HubSpot marketing email analytics (last month)', type: 'hubspot_email_stats', why: 'HubSpot answered 403: missing scope' };
  assert.deepStrictEqual(gapsOf(email, { started_at: '2026-11-03T12:00:00Z', unavailable: [old] }, NOW, null, {}), []);
  // Even a FRESH reason for a source the agent no longer declares is not a gap, and not a Waiting line.
  const fresh = { started_at: '2026-11-17T12:00:00Z', unavailable: [old] };
  assert.deepStrictEqual(liveMissing(email, fresh, NOW), []);
  assert.deepStrictEqual(gapsOf(email, fresh, NOW, null, {}), []);
});

test('SEO Lead: the stale Search Console reason is gone; the missing Ubersuggest file is named, live', () => {
  const seo = loadAgent('seo');
  const run = { started_at: '2026-11-09T12:00:00Z', status: 'blocked', unavailable: [
    { label: 'Google Search Console', type: 'search_console', why: 'Search Console has none of our sites open to the Box yet.' },
    { label: UBER, type: 'file', why: 'no 07_Marketing_and_Brand/SEO_Data/Ubersuggest_Weekly_*.md found' }] };
  const never = gapsOf(seo, run, NOW, null, {});
  assert.strictEqual(never.length, 1, never.join(' | '));
  assert.match(never[0], /Ubersuggest/);
  const failing = rows({ id: 'tree-file:ubersuggest-weekly', ok: false, reason: 'no 07_Marketing_and_Brand/SEO_Data/Ubersuggest_Weekly_*.md found', checked_at: NOW.toISOString() });
  const g = gapsOf(seo, run, NOW, failing, {});
  assert.strictEqual(g.length, 1);
  assert.match(g[0], /\(failing: no 07_Marketing_and_Brand\/SEO_Data\/Ubersuggest_Weekly_\*\.md found; last checked 11\.17 13:00 CT\)$/);
  // Every gap is also on the card's Waiting box.
  const needs = characterOf(seo, [], run, NOW, failing, {}).needs;
  for (const x of g) assert.ok(needs.includes(x), `${x} in ${needs.join(' | ')}`);
  // The file lands: no gap, no Waiting line.
  const ok = rows({ id: 'tree-file:ubersuggest-weekly', ok: true, reason: 'x', checked_at: NOW.toISOString() });
  assert.deepStrictEqual(gapsOf(seo, run, NOW, ok, {}), []);
  assert.ok(!characterOf(seo, [], run, NOW, ok, {}).needs.some((n) => /Ubersuggest/.test(n)));
});

test('Blogger: a fresh run reason and the static need show as ONE line', () => {
  const bob = loadAgent('bloggy-bob');
  const run = { started_at: '2026-11-17T12:00:00Z', unavailable: [{ label: UBER, type: 'file', why: 'no 07_Marketing_and_Brand/SEO_Data/Ubersuggest_Weekly_*.md found' }] };
  const failing = rows({ id: 'tree-file:ubersuggest-weekly', ok: false, reason: 'not there', checked_at: NOW.toISOString() });
  const g = gapsOf(bob, run, NOW, failing, {});
  assert.strictEqual(g.length, 1, g.join(' | '));
  assert.strictEqual(characterOf(bob, [], run, NOW, failing, {}).needs.filter((n) => /Ubersuggest/.test(n)).length, 1);
});

test('the tree-file check reads the newest file the source reads, never anything else', async () => {
  const c = C.checkFor(loadAgent('seo').character.needs.find((n) => /Ubersuggest/.test(n)));
  assert.strictEqual(c.id, 'tree-file:ubersuggest-weekly');
  assert.strictEqual(c.kind, 'tree_file');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ihg3498-'));
  const missing = await C.runCheck(c, { env: { IHG_TREE: root } });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.reason, /Ubersuggest_Weekly_/);
  fs.mkdirSync(path.join(root, '07_Marketing_and_Brand', 'SEO_Data'), { recursive: true });
  fs.writeFileSync(path.join(root, '07_Marketing_and_Brand', 'SEO_Data', 'Ubersuggest_Weekly_11.19.2026.md'), '# numbers');
  assert.deepStrictEqual(await C.runCheck(c, { env: { IHG_TREE: root } }), { ok: true, reason: 'Ubersuggest_Weekly_11.19.2026.md is on the Box' });
});

test('the page: "Partly working" comes from gaps, never from the raw last-run list', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
  const fn = html.slice(html.indexOf('function status(a)'), html.indexOf('// #2941 the eyebrow rule'));
  assert.doesNotMatch(fn, /last_run\.unavailable/);
  assert.match(fn, /\(a\.gaps \|\| \[\]\)\.length/);
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'agents.js'), 'utf8');
  assert.match(route, /gaps: gapsOf\(d, runs\.get\(slug\), clock\(\), checks\)/);
});
