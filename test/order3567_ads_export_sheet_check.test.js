// ORDER #3567: the Auditor's Waiting line names the real ask (K&M build the ads
// export Sheet per the spec and share it to the Brain), and it is a live #3243
// check: it clears when ADS_EXPORT_SHEET_ID is set and the Brain can open the Sheet.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/agent-checks');
const { characterOf } = require('../routes/agents');
const { loadAgent, listAgents } = require('../lib/agent-runner');

const NOW = new Date('2026-11-18T13:40:00-06:00');
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab';
const rows = (...r) => new Map(r.map((x) => [x.id, x]));
// #3794: the Auditor no longer waits on the Sheet (it reads Google Ads through
// the API); the Monthly Report (#3568) still does, so the check is proven on its line.
const need = () => loadAgent('monthly-report').character.needs.find((n) => /ads export Sheet/.test(n));

test('the Monthly Report names the real ask, with the spec, and no dollar figure; the Auditor no longer waits on it', () => {
  const n = need();
  assert.strictEqual(n, 'Katherine/K&M: create the ads export Sheet per the spec (https://docs.google.com/document/d/1N0KqATZq3EBNT_OO7rNZpVF0kym5qqIQbM17A98GCxM/edit) and share it to the Brain');
  assert.doesNotMatch(n, /\$|\d+\s*(dollars|usd)/i);
  assert.strictEqual(C.checkFor(n).id, 'sheet:ads-export');
  assert.ok(!loadAgent('paid-ads').character.needs.some((x) => /ads export Sheet/.test(x)), '#3794');
});

test('the check is in the fleet list the Box job runs', () => {
  const all = C.fleetChecks(listAgents().map((s) => [s, loadAgent(s)]));
  const c = all.find((x) => x.id === 'sheet:ads-export');
  assert.ok(c, 'sheet:ads-export is checked');
  assert.deepStrictEqual([...c.agents].sort(), ['monthly-report']); // #3794: the Auditor moved to the API read
});

test('no Sheet id set: fails, and never asks Google', async () => {
  let asked = 0;
  const ctx = { env: {}, sheetTabs: async () => { asked++; return []; } };
  const r = await C.runCheck(C.checkFor(need()), ctx);
  assert.deepStrictEqual(r, { ok: false, reason: 'no Sheet id set yet (ADS_EXPORT_SHEET_ID is empty in the env this job runs with)' });
  assert.strictEqual(asked, 0);
  const bad = await C.runCheck(C.checkFor(need()), { env: { ADS_EXPORT_SHEET_ID: 'not an id' }, sheetTabs: async () => { asked++; return []; } });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(asked, 0);
});

test('id set but not shared: fails naming the Brain account to share it to', async () => {
  const err = Object.assign(new Error('Drive 403'), { status: 403 });
  const r = await C.runCheck(C.checkFor(need()), { env: { ADS_EXPORT_SHEET_ID: ID }, sheetTabs: async () => { throw err; } });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /share it to infinity-brain@ihg-sales-brain\.iam\.gserviceaccount\.com as Viewer/);
  const other = await C.runCheck(C.checkFor(need()), { env: { ADS_EXPORT_SHEET_ID: ID }, sheetTabs: async () => { throw new Error('network down'); } });
  assert.match(other.reason, /^the check could not run: network down/);
});

test('id set and readable: passes, and the card line disappears', async () => {
  let got = null;
  const r = await C.runCheck(C.checkFor(need()), { env: { ADS_EXPORT_SHEET_ID: ` ${ID} ` }, sheetTabs: async (id) => { got = id; return ['Google Ads', 'Meta']; } });
  assert.deepStrictEqual(r, { ok: true, reason: 'the Brain reads the Sheet (2 tabs: Google Ads, Meta)' });
  assert.strictEqual(got, ID);
  const pa = loadAgent('monthly-report'); // #3794
  const pass = rows({ id: 'sheet:ads-export', ok: true, reason: r.reason, checked_at: NOW.toISOString() });
  assert.ok(!characterOf(pa, [], null, NOW, pass, {}).needs.some((n) => /ads export Sheet/.test(n)));
  const fail = rows({ id: 'sheet:ads-export', ok: false, reason: 'no Sheet id set yet', checked_at: NOW.toISOString() });
  assert.ok(characterOf(pa, [], null, NOW, fail, {}).needs.some((n) => /create the ads export Sheet per the spec .*\(failing: no Sheet id set yet; last checked 11\.18 13:40 CT\)/.test(n)));
});

test('the live reader asks for tab names only, read-only, and the config slot ships empty', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-checks.js'), 'utf8');
  const reader = src.slice(src.indexOf('async sheetTabs'), src.indexOf('};', src.indexOf('async sheetTabs')));
  assert.match(reader, /fields=sheets\.properties\.title/);
  assert.doesNotMatch(reader, /values|batchGet|method:\s*'(POST|PUT|PATCH|DELETE)'/);
  // The config slot: one env name, read from the job's env, empty until K&M build the Sheet.
  assert.strictEqual(C.ADS_SHEET_ENV, 'ADS_EXPORT_SHEET_ID');
  assert.strictEqual(C.checkFor(need()).env, 'ADS_EXPORT_SHEET_ID');
});
