'use strict';
// ORDER #2979 (Mimi popup 11.05.2026, "Hers go live, I'm notified."): Katherine's
// instruction changes go live on save; Mimi sees one line each and can undo.
// FEATURE FLAG: INSTRUCTION_CHANGES_LIVE default OFF. No sends anywhere.
// Builtins only, so it runs without node_modules; the routes are in
// order2979_agents_changes_routes.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IC = require('../lib/instruction-changes');
const W = require('../lib/reviewer-watch');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { loadAgent } = require('../lib/agent-runner');
const { sortAsks } = require('../jobs/agent_asks');

const K = 'katherine@infinityhospitality.net';
const MIMI = 'mimi@infinityhospitality.net';
const EM = '—';
const model = (answer) => ({ model: 'fake', async complete(q) { return typeof answer === 'function' ? answer(q) : JSON.stringify(answer); } });
const inbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-2979-'));

test('the switch ships OFF: unset, empty or "off" is off', () => {
  assert.strictEqual(IC.FLAG, 'INSTRUCTION_CHANGES_LIVE');
  for (const v of [undefined, '', 'off', '0', 'no']) assert.strictEqual(IC.liveOn({ INSTRUCTION_CHANGES_LIVE: v }), false, String(v));
  for (const v of ['1', 'on', 'true', 'YES']) assert.strictEqual(IC.liveOn({ INSTRUCTION_CHANGES_LIVE: v }), true, v);
  assert.strictEqual(IC.COPY, 'Instruction changes go live on save. Mimi is notified and can undo.');
  assert.ok(!IC.COPY.includes(EM));
});

test('switch OFF: an instruction ask still waits for an exec (no change from #1658)', async () => {
  const s = createMemoryStore({ lint });
  await s.createAsk('gbp', 'write shorter replies', K);
  await sortAsks({ store: s, llm: model({ kind: 'instructions', reason: 'wording', proposed_skill_md: '# GBP\nShort replies.' }),
    inbox: inbox(), log: () => {}, env: {} });
  assert.strictEqual(s.asks[0].status, 'awaiting_exec');
  assert.strictEqual(await s.currentSettings('gbp'), null, 'nothing saved');
});

test('ZZ_TEST switch ON: Katherine\'s instruction ask is live on the next run, Mimi sees the line, Undo restores, History shows all three', async () => {
  const s = createMemoryStore({ lint });
  const env = { INSTRUCTION_CHANGES_LIVE: 'on' };
  // v1: Katherine edits the instructions directly (Edit instructions: always a new version).
  await s.saveSettings('gbp', { skill_md: '# GBP\nWarm replies.', enabled: true, max_cards: 3, note: 'ZZ_TEST edit', who: K });
  // v2: an Ask the Box sorts as an instruction change goes live with no approval step.
  await s.createAsk('gbp', 'ZZ_TEST write shorter replies', K);
  await sortAsks({ store: s, llm: model({ kind: 'instructions', reason: 'wording', proposed_skill_md: '# GBP\nShort replies.' }),
    inbox: inbox(), log: () => {}, env });
  const a = s.asks[0];
  assert.strictEqual(a.status, 'applied');
  assert.match(a.decided_by, /live on save/);
  const live = await s.currentSettings('gbp');
  assert.strictEqual(live.version, 2);
  assert.strictEqual(live.skill_md, '# GBP\nShort replies.', 'the next run reads this version');
  assert.strictEqual(live.edited_by, K, 'recorded as hers');
  assert.match(live.note, /ask #\d+ from katherine@infinityhospitality\.net, live on save \(ORDER #2979\)/);

  // Mimi's list: one line per change, the newest can be undone.
  let list = IC.changeList(await s.recentSettings());
  assert.deepStrictEqual(list.map((c) => [c.agent, c.version, c.who, c.can_undo]), [['gbp', 2, K, true], ['gbp', 1, K, false]]);
  assert.strictEqual(list[0].link, '/agents#change-gbp-2');

  // Undo: v3 copies v1.
  const u = await IC.undoChange({ store: s, agent: 'gbp', version: 2, def: loadAgent('gbp'), who: MIMI });
  assert.strictEqual(u.settings.version, 3);
  assert.strictEqual(u.settings.skill_md, '# GBP\nWarm replies.');
  assert.strictEqual(u.settings.edited_by, MIMI);
  assert.strictEqual(IC.undoOf(u.settings.note), 2);

  // History shows the edit, the live change and the undo.
  const hist = await s.settingsHistory('gbp');
  assert.deepStrictEqual(hist.map((v) => v.version), [3, 2, 1]);
  list = IC.changeList(await s.recentSettings());
  const v2 = list.find((c) => c.version === 2);
  assert.strictEqual(v2.undone_by, MIMI);
  assert.strictEqual(v2.can_undo, false);
  const v3 = list.find((c) => c.version === 3);
  assert.strictEqual(v3.is_undo, true);
  assert.strictEqual(v3.can_undo, false, 'an undo is not itself undone; History puts back a version');
});

test('KNOWN-BAD: Undo never throws away a later change, and a version 1 undo goes back to the default', async () => {
  const s = createMemoryStore({ lint });
  const def = loadAgent('gbp');
  await s.saveSettings('gbp', { skill_md: '# GBP\nOne.', enabled: true, max_cards: 2, who: K });
  const only = await IC.undoChange({ store: s, agent: 'gbp', version: 1, def, who: MIMI });
  assert.strictEqual(only.settings.skill_md, def.skill);
  assert.strictEqual(only.settings.max_cards, def.max_cards || 3);
  await s.saveSettings('gbp', { skill_md: '# GBP\nThree.', enabled: true, max_cards: 2, who: K });
  await s.saveSettings('gbp', { skill_md: '# GBP\nFour.', enabled: true, max_cards: 2, who: K });
  const stale = await IC.undoChange({ store: s, agent: 'gbp', version: 3, def, who: MIMI });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual((await s.currentSettings('gbp')).skill_md, '# GBP\nFour.', 'untouched');
  assert.strictEqual((await IC.undoChange({ store: s, agent: 'gbp', version: 99, def, who: MIMI })).status, 404);
});

test('KNOWN-BAD switch ON: the fence still holds; a publish ask is "cant", a build is still an ORDER, an em dash is refused', async () => {
  const s = createMemoryStore({ lint });
  const d = inbox();
  for (const t of ['publish the post when approved', 'pull Instagram stats', 'be warmer']) await s.createAsk('bloggy-bob', t, K);
  const llm = model((q) => {
    // (Bob's own instructions mention publishing, so match the ask text, most specific first.)
    if (/pull Instagram stats/.test(q.user)) return JSON.stringify({ kind: 'build', reason: 'new data', build_summary: 'Instagram read-only.' });
    if (/be warmer/.test(q.user)) return JSON.stringify({ kind: 'instructions', reason: 'x', proposed_skill_md: `# Bob ${EM} warm` });
    return JSON.stringify({ kind: 'instructions', reason: 'x', proposed_skill_md: '# Bob\nPublish when approved.' });
  });
  await sortAsks({ store: s, llm, inbox: d, log: () => {}, env: { INSTRUCTION_CHANGES_LIVE: 'on' } });
  const by = Object.fromEntries(s.asks.map((a) => [a.ask, a.status]));
  assert.strictEqual(by['publish the post when approved'], 'cant');
  assert.strictEqual(by['pull Instagram stats'], 'building');
  assert.strictEqual(by['be warmer'], 'failed');
  assert.strictEqual(await s.currentSettings('bloggy-bob'), null, 'nothing went live');
});

test('KNOWN-BAD switch ON: a proposal made against older instructions is not applied; it is sorted again', async () => {
  const s = createMemoryStore({ lint });
  const { ask } = await s.createAsk('gbp', 'write shorter replies', K);
  const llm = model(async () => {
    // Katherine saves while the Box is sorting.
    await s.saveSettings('gbp', { skill_md: '# GBP\nMid-sort edit.', enabled: true, max_cards: 3, who: K });
    return JSON.stringify({ kind: 'instructions', reason: 'w', proposed_skill_md: '# GBP\nShort.' });
  });
  // triage reads base_version before the model call returns, so the save above makes it stale.
  await sortAsks({ store: s, llm: { model: 'fake', complete: (q) => llm.complete(q) }, inbox: inbox(), log: () => {}, env: { INSTRUCTION_CHANGES_LIVE: '1' } });
  assert.strictEqual(s.asks.find((a) => a.id === ask.id).status, 'new');
  assert.strictEqual((await s.currentSettings('gbp')).skill_md, '# GBP\nMid-sort edit.');
});

test('lineDiff marks removed and added lines and keeps the rest', () => {
  const d = IC.lineDiff('a\nb\nc', 'a\nB\nc\nd');
  assert.deepStrictEqual(d.map((x) => x.op + x.line), [' a', '-b', '+B', ' c', '+d']);
});

test('Machine-made versions (the Box, a merge) are not listed as a person\'s change', () => {
  const rows = [{ agent: 'citations', version: 4, edited_by: 'mimi@infinityhospitality.net (via the Box)', note: 'ORDER #1715', created_at: new Date() }];
  assert.deepStrictEqual(IC.changeList(rows), []);
});

test('the Monday reviewer-facts draft (#2962 channel B) carries one line per change with its link, and no judgment words', () => {
  const MKT = W.department('marketing');
  const NOW = new Date('2026-11-09T14:00:00Z');
  const rows = { cards: [], runs: [], asks: [], visits: [], settings: [
    { agent: 'gbp', version: 3, edited_by: K, note: null, created_at: new Date('2026-11-05T18:00:00Z') },
    { agent: 'gbp', version: 4, edited_by: MIMI, note: IC.undoNote(3, MIMI), created_at: new Date('2026-11-06T18:00:00Z') },
    { agent: 'citations', version: 5, edited_by: 'mimi@infinityhospitality.net (via the Box)', note: null, created_at: new Date('2026-11-05T18:00:00Z') },
  ] };
  const card = W.scorecard({ dept: MKT, rows, now: NOW });
  assert.deepStrictEqual(card.week.instruction_changes.map((c) => [c.agent, c.version, c.who, c.undo_of]), [['gbp', 3, K, null], ['gbp', 4, MIMI, 3]]);
  const md = W.renderMarkdown([card], { base: 'https://marketing.infinityhospitalitygroup.com' });
  assert.match(md, /- Instruction changes this week \(live on save; Undo is on the Agents page\):/);
  assert.match(md, /gbp version 3, katherine@infinityhospitality\.net, 11\.05\.2026 12:00 CT \(https:\/\/marketing\.infinityhospitalitygroup\.com\/agents#change-gbp-3\)/);
  assert.match(md, /gbp version 4 \(undo of version 3\), mimi@/);
  assert.ok(!/citations version 5/.test(md), 'a Box-made version is not listed');
  assert.deepStrictEqual(W.labelWords(md), []);
  assert.ok(!md.includes(EM));
  assert.match(W.READ_SQL.settings, /\bnote\b/);
});
