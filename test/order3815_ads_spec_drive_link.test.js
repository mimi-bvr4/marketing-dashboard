// ORDER #3815 (#3813 baton): Katherine cannot open a tree path, so every line she
// reads that points her at the Ads Export spec carries the spec's Google Doc
// link (published into "Marketing - for Katherine" by #3793/#3813), never the
// tree path 07_Marketing_and_Brand/Ads_Export_Spec_for_KM.md.
// The Doc id is the one in box_driver_state/katherine_drive_manifest.json.
// Text only: the need still matches the sheet:ads-export check, and the rest of
// each sentence is word for word.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/ads-export-sheet');
const C = require('../lib/agent-checks');
const { loadAgent } = require('../lib/agent-runner');

const TREE = '07_Marketing_and_Brand/Ads_Export_Spec_for_KM.md';
const DOC = 'https://docs.google.com/document/d/1N0KqATZq3EBNT_OO7rNZpVF0kym5qqIQbM17A98GCxM/edit';
const ASK = `Katherine/K&M: create the ads export Sheet per the spec (${DOC}) and share it to the Brain`;

const adsNeed = (slug) => loadAgent(slug).character.needs.find((n) => /ads export Sheet/.test(n));

test('both cards ask with the Drive link, word for word, and no tree path', () => {
  for (const slug of ['paid-ads', 'monthly-report']) {
    const n = adsNeed(slug);
    assert.strictEqual(n, ASK, slug);
    assert.ok(!n.includes(TREE), slug);
    // Same live check as before: the matcher keys on the words, not the path.
    assert.strictEqual(C.checkFor(n).id, 'sheet:ads-export', slug);
  }
});

test("the Auditor's waiting-on why carries the Drive link, not the tree path", () => {
  const d = loadAgent('paid-ads');
  const whys = (d.sources || []).map((s) => s.why || '').filter((w) => /export Sheet has never existed/.test(w));
  assert.strictEqual(whys.length, 1, 'one source why names the export Sheet');
  assert.ok(whys[0].includes(DOC), whys[0]);
  assert.ok(!whys[0].includes(TREE), whys[0]);
  assert.ok(whys[0].includes('(#3567), share it to the Brain, and its id goes in ADS_EXPORT_SHEET_ID; Katherine owns the ask'), whys[0]);
});

test('the Sheet header the agents read names the Drive link, not the tree path', () => {
  const G = [A.TABS['Google Ads'], ['2026-11-16', 'Fontanel', 'Weddings', 'Barn', 'k', 'Phrase', 's', 'https://x.example/', '10', '1', '5.00', '0']];
  const M = [A.TABS.Meta];
  for (const agent of ['paid-ads', 'monthly-report']) {
    const r = A.readFenced(agent, { 'Google Ads': G, Meta: M });
    assert.ok(r.ok, r.why);
    const head = A.sourceText(agent, r).text.split('\n\n')[0];
    assert.ok(head.startsWith(`Ads export Sheet (K&M, per ${DOC}), read-only. `), head);
    assert.ok(!head.includes(TREE), head);
  }
});
