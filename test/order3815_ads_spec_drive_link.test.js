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

// Rebased onto #3794 (Mimi 11.24.2026: the Google Ads API read replaces the
// Sheet for the Paid Ads Auditor), so only the Monthly Report still asks for
// the export Sheet; the Auditor's lines must carry no Sheet ask and no tree path.
test('the Monthly Report asks with the Drive link, word for word, and no tree path', () => {
  const n = adsNeed('monthly-report');
  assert.strictEqual(n, ASK);
  assert.ok(!n.includes(TREE));
  // Same live check as before: the matcher keys on the words, not the path.
  assert.strictEqual(C.checkFor(n).id, 'sheet:ads-export');
});

test("the Auditor no longer asks for the export Sheet, and none of its lines carry the tree path", () => {
  const d = loadAgent('paid-ads');
  assert.strictEqual(adsNeed('paid-ads'), undefined);
  const whys = (d.sources || []).map((s) => s.why || '');
  assert.strictEqual(whys.filter((w) => /export Sheet has never existed/.test(w)).length, 0);
  for (const line of [...whys, ...(d.character.needs || [])]) assert.ok(!line.includes(TREE), line);
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
