// ORDER #3562 (Mimi 11.18.2026, "the links are done"): the Archivist's Waiting
// line about Collateral Map links is a #3243 LIVE CHECK, never static text. It
// names only the titles still missing a link, and clears when none are missing.
// The Archivist opens a material by its link first; a Drive name match is only
// for a title with no link.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/agent-checks');
const M = require('../lib/collateral-map');
const S = require('../lib/cadet-search');
const { characterOf } = require('../routes/agents');
const { loadAgent, listAgents } = require('../lib/agent-runner');

const NOW = new Date('2026-11-18T12:30:00-06:00');
const rows = (...r) => new Map(r.map((x) => [x.id, x]));
const cadet = () => loadAgent('collateral-cadet');
const need = () => cadet().character.needs.find((n) => /Collateral Map/.test(n));
const mat = (company, title, uri) => ({ company, section: 'S', title, archived: false, link: M.linkKind(uri || null) });

test('the Archivist\'s link need is decided by a live check', () => {
  const c = C.checkFor(need());
  assert.ok(c, `no check for: ${need()}`);
  assert.strictEqual(c.id, 'collateral:links');
  assert.strictEqual(c.kind, 'collateral_links');
  const ids = C.fleetChecks(listAgents().map((s) => [s, loadAgent(s)])).map((x) => x.id);
  assert.ok(ids.includes('collateral:links'), ids.join(', '));
});

test('the check names only the titles with no link, and passes when none are missing', async () => {
  const c = C.checkFor(need());
  const two = await C.runCheck(c, { collateralMaterials: async () => [
    mat('IHG', 'TBB Venue Guide', 'https://canva.link/abc'),
    mat('NLP', 'Lighting + Production Guide'),
    mat('DEC + DD', 'Paramount Menu'),
  ] });
  assert.strictEqual(two.ok, false);
  assert.strictEqual(two.reason, '2 of 3 titles have no link: Lighting + Production Guide (NLP), Paramount Menu (DEC + DD)');
  const all = await C.runCheck(c, { collateralMaterials: async () => [mat('IHG', 'A', 'https://canva.link/a'), mat('NLP', 'B', 'https://drive.google.com/file/d/ABCDEFGHIJKL/view')] });
  assert.deepStrictEqual(all, { ok: true, reason: 'every one of the 2 titles on the Collateral Map carries a link' });
  // A map that reads empty is not "all linked".
  assert.strictEqual((await C.runCheck(c, { collateralMaterials: async () => [] })).ok, false);
  // A long list is cut, never lost: the count is always whole.
  const many = Array.from({ length: 30 }, (_, i) => mat('IHG', `Title ${i}`));
  const r = await C.runCheck(c, { collateralMaterials: async () => many });
  assert.match(r.reason, /^30 of 30 titles have no link: Title 0 \(IHG\), .* and 20 more$/);
  assert.ok(r.reason.length <= 500);
});

test('the card: a passing check clears the line; a failing one names the titles', () => {
  const pass = rows({ id: 'collateral:links', ok: true, reason: 'every one of the 114 titles on the Collateral Map carries a link', checked_at: NOW.toISOString() });
  assert.ok(!characterOf(cadet(), [], null, NOW, pass, {}).needs.some((n) => /Collateral Map/.test(n)));
  const fail = rows({ id: 'collateral:links', ok: false, reason: '1 of 114 titles have no link: Paramount Menu (DEC + DD)', checked_at: NOW.toISOString() });
  const needs = characterOf(cadet(), [], null, NOW, fail, {}).needs;
  assert.ok(needs.some((n) => /Paramount Menu \(DEC \+ DD\); last checked 11\.18 12:30 CT\)$/.test(n)), needs.join(' | '));
});

test('agent.json carries no stale count or "no link" date', () => {
  const s = JSON.stringify(cadet());
  assert.doesNotMatch(s, /107 materials|none of the 107/);
});

test('the Box job reads the map for the check (read-only Sheets read)', () => {
  const ctx = C.liveContext({});
  assert.strictEqual(typeof ctx.collateralMaterials, 'function');
});

test('open by link: a linked title never falls back to a name guess; an unlinked one does', async () => {
  const calls = [];
  const drive = {
    async getFile(id) { calls.push(['getFile', id]); return { id, name: 'Linked Guide', mimeType: 'application/vnd.google-apps.document', webViewLink: `https://docs.google.com/document/d/${id}/edit` }; },
    async listPage(p) { calls.push(['list', p.q]); return { files: [{ id: 'BYNAME000001', name: 'Unlinked Guide', mimeType: 'application/vnd.google-apps.document' }] }; },
  };
  const linked = await S.resolve(mat('IHG', 'Linked Guide', 'https://docs.google.com/document/d/LINKED000001/edit'), drive);
  assert.strictEqual(linked.via, 'link');
  assert.strictEqual(linked.files[0].id, 'LINKED000001');
  assert.ok(!calls.some(([k, q]) => k === 'list' && /name =/.test(q)), 'no name search for a linked title');
  const byName = await S.resolve(mat('IHG', 'Unlinked Guide'), drive);
  assert.strictEqual(byName.via, 'name');
  // A Canva link is opened as Canva (Not checked, with the reason), never swapped for a name guess.
  const canva = await S.resolve(mat('IHG', 'Unlinked Guide', 'https://canva.link/4llxpi45p56j21l'), drive);
  assert.match(canva.not_checked, /Canva/);
  assert.strictEqual(calls.filter(([k]) => k === 'list').length, 1);
});
