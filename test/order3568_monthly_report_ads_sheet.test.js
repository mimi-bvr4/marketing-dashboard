// ORDER #3568: the Monthly Report asks for the ads export Sheet the same way the
// Auditor does (#3567): the spec by name, owner Katherine/K&M, and the SAME live
// check `sheet:ads-export` on the SAME env slot ADS_EXPORT_SHEET_ID, so both cards'
// lines clear at the same moment. One Sheet, one slot, one check.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/agent-checks');
const { characterOf } = require('../routes/agents');
const { loadAgent, listAgents } = require('../lib/agent-runner');

const NOW = new Date('2026-11-18T15:30:00-06:00');
const SPEC = 'https://docs.google.com/document/d/1N0KqATZq3EBNT_OO7rNZpVF0kym5qqIQbM17A98GCxM/edit'; // #3815: the spec's Drive copy
const rows = (...r) => new Map(r.map((x) => [x.id, x]));
const adsNeed = (slug) => loadAgent(slug).character.needs.find((n) => /ads export Sheet/.test(n));

test('the Monthly Report need names the spec and uses the sheet:ads-export check', () => {
  const n = adsNeed('monthly-report');
  assert.ok(n, 'the Monthly Report still asks for the ads Sheet');
  assert.match(n, /^Katherine\/K&M: /);
  assert.ok(n.includes(SPEC), n);
  assert.doesNotMatch(n, /\$|\d+\s*(dollars|usd)/i);
  const c = C.checkFor(n);
  assert.ok(c, 'the need is decided by a live check');
  assert.strictEqual(c.id, 'sheet:ads-export');
  // The source and the runtime are untouched: there is no reader for the rows yet.
  const src = loadAgent('monthly-report').sources.find((s) => /ads export Sheet/.test(s.label));
  assert.strictEqual(src.type, 'pending');
});

// #3794: the Auditor left the Sheet for the Google Ads API read; the Monthly
// Report is now the one card waiting on sheet:ads-export.
test('one check in the fleet for the Sheet, on the one env slot; the Auditor no longer waits on it', () => {
  assert.strictEqual(adsNeed('paid-ads'), undefined);
  const m = C.checkFor(adsNeed('monthly-report'));
  assert.strictEqual(m.env, 'ADS_EXPORT_SHEET_ID');
  const all = C.fleetChecks(listAgents().map((s) => [s, loadAgent(s)]));
  const ads = all.filter((x) => x.kind === 'ads_export_sheet');
  assert.strictEqual(ads.length, 1);
  assert.deepStrictEqual([...ads[0].agents].sort(), ['monthly-report']);
  assert.strictEqual(C.RULES.filter((r) => r.make({}).kind === 'ads_export_sheet').length, 1);
});

test('a passing check clears the Monthly Report line; a failing one shows', () => {
  const pass = rows({ id: 'sheet:ads-export', ok: true, reason: 'the Brain reads the Sheet', checked_at: NOW.toISOString() });
  const fail = rows({ id: 'sheet:ads-export', ok: false, reason: 'no Sheet id set yet', checked_at: NOW.toISOString() });
  for (const slug of ['monthly-report']) {
    const d = loadAgent(slug);
    assert.ok(!characterOf(d, [], null, NOW, pass, {}).needs.some((n) => /ads export Sheet/.test(n)), `${slug} clears`);
    assert.ok(characterOf(d, [], null, NOW, fail, {}).needs.some((n) => /ads export Sheet per the spec .*\(failing: no Sheet id set yet; last checked 11\.18 15:30 CT\)/.test(n)), `${slug} fails`);
  }
});
