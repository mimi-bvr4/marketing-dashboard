'use strict';
// ORDER #3814 (#3797 rule 3, Mimi 11.24.2026 after working with Katherine):
// "No info-only cards. If there is no action, there is no card. Fold the
// information into the agent's weekly summary instead."
//
// The weekly summary is the Monday digest (lib/agent-digest.js). A report-kind
// result with no payload makes NO Review card: the runner saves it as a dated
// entry (agent_report_notes) and the digest reads the week's entries.
// A report result that carries a payload is still an action card (#3797 rule 3
// KNOWN-BAD case). Exempt, because each one is an action or feeds one:
//   * digest            it IS the weekly summary;
//   * citations         carried by #3808 (fix cards + a summary of action lines,
//                       and the #1759 Patty chain reads it);
//   * a chain line      SEO's "For Bloggy Bob" lines and the Scout's blog moves
//                       queue runs from the card's id (#1759, #2901);
//   * SEO "Quick wins"  every row is a page and the words to paste (#3808).
//
// No database (in-memory store), no model call (a fake that answers JSON).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { runAgent, loadAgent } = require('../lib/agent-runner');
const { writeDigest } = require('../lib/agent-digest');
const RF = require('../lib/report-fold');
const CA = require('../lib/card-action');

const AT = new Date('2026-11-23T14:00:00Z'); // 11.23.2026 08:00 CT, a Monday
const now = () => AT;

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3814-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'week.md'), '# Measured this week\n- 3 pages slower than last week.\n');
  return { IHG_TREE: root };
}

const def = (slug, extra = {}) => ({ ...loadAgent(slug), copy_prepass: false, seen_before: null, ...extra,
  sources: [{ type: 'file', path: 'week.md', required: true, label: 'the week measured' }] });

function model(answer) {
  return { model: 'fake', lastStop: 'end_turn', async complete() { return JSON.stringify(answer); } };
}

async function run(t, slug, cards, { store = createMemoryStore({ lint, now }), extra = {}, dryRun = false } = {}) {
  const res = await runAgent({ def: def(slug, extra), store, llm: model({ cards }), env: tree(t), now, scheduled: true, dryRun,
    log: () => {}, fetchImpl: async () => { throw new Error('no network'); } });
  return { store, res };
}

const REPORT = { title: 'Site speed this week: 3 pages slower', target: null,
  body: 'The venue pages on TBB loaded slower this week than last. The home page is unchanged.' };

test('RED: a report result with no payload makes no Review card and lands as a dated weekly-summary entry', async (t) => {
  const { store, res } = await run(t, 'site-health', [REPORT]);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(store.cards.filter((c) => c.agent === 'site-health').length, 0, 'no Review card');
  assert.strictEqual(res.cards.length, 0, 'nothing counted as a draft');
  assert.strictEqual(res.folded.length, 1, 'the result is returned as folded');
  const notes = await store.weekReports();
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].agent, 'site-health');
  assert.strictEqual(notes[0].title, REPORT.title);
  assert.match(notes[0].body, /loaded slower this week/);
  assert.ok(notes[0].created_at instanceof Date, 'the entry is dated');
  const row = store.runList.find((r) => r.agent === 'site-health');
  assert.strictEqual(row.cards, 0);
  assert.match(row.note || '', /1 report folded into the Monday digest/);
});

test('every listed report agent folds through the one runner path (paid-ads, scout, seo)', async (t) => {
  for (const slug of ['paid-ads', 'scout', 'seo']) {
    const { store } = await run(t, slug, [{ ...REPORT, title: `${slug}: the week in numbers` }]);
    assert.strictEqual(store.cards.filter((c) => c.agent === slug).length, 0, `${slug} made a card`);
    assert.strictEqual((await store.weekReports()).length, 1, `${slug} folded nothing`);
  }
});

test('the Monday digest reads the folded entries: one dated line each, under its own heading', async (t) => {
  const { store } = await run(t, 'site-health', [REPORT]);
  const d = await writeDigest({ store, now });
  assert.match(d.body, /### Folded in from the report agents \(no card made\)/);
  assert.match(d.body, /- 11\.23\.2026, Site Health: \*\*Site speed this week: 3 pages slower\*\*\. The venue pages on TBB loaded slower/);
});

test('KNOWN-BAD stays green: a report result that carries a payload is still an action card', async (t) => {
  const post = { site: 'TBB', title: 'Faster venue pages', slug: 'faster', content_md: 'A post about our venue pages and how they load for couples.' };
  const { store, res } = await run(t, 'seo', [{ ...REPORT, post }], { extra: { post_fields: true } });
  assert.strictEqual(res.cards.length, 1);
  assert.strictEqual(store.cards[0].payload.post.title, 'Faster venue pages');
  assert.strictEqual((await store.weekReports()).length, 0);
  assert.strictEqual(RF.foldsAway({ agent: 'paid-ads', title: 't', body: 'b', payload: { post } }), false);
});

test('exempt: digest, citations (#3808), chain lines, SEO Quick wins, and non-report agents', () => {
  assert.strictEqual(RF.foldsAway({ agent: 'site-health', title: 't', body: 'b' }), true, 'control: a bare report folds');
  assert.strictEqual(RF.foldsAway({ agent: 'digest', title: 't', body: 'b' }), false);
  assert.strictEqual(RF.foldsAway({ agent: 'citations', title: 'Listings check, 11.23.2026: 0 to fix', body: 'b' }), false);
  assert.strictEqual(RF.foldsAway({ agent: 'seo', title: 'SEO: week', body: '### For Bloggy Bob\n`keyword: barn wedding nashville · site: TBB · post type: guide`' }), false);
  assert.strictEqual(RF.foldsAway({ agent: 'scout', title: 'Scout: week', body: '### Moves for us\n- A blog post: "Winter barn weddings near Nashville"' }), false);
  assert.strictEqual(RF.foldsAway({ agent: 'seo', title: 'Quick wins, week of 11.23.2026', body: '| Page | New title |' }), false);
  assert.strictEqual(RF.foldsAway({ agent: 'gbp', title: 'Reply draft', body: 'Thank you.' }), false);
});

test('a chain-carrying SEO card is still saved, so the #1759 chain can name its card id', async (t) => {
  const { store, res } = await run(t, 'seo', [{ ...REPORT, title: 'SEO: week', body: '### For Bloggy Bob\n`keyword: barn wedding nashville · site: TBB · post type: guide`' }]);
  assert.strictEqual(res.cards.length, 1);
  assert.ok(res.cards[0].id, 'saved with an id');
  assert.strictEqual(store.cards.length, 1);
});

test('notices are not folded: "could not run" still reaches the Review tab', async (t) => {
  const store = createMemoryStore({ lint, now });
  const res = await runAgent({ def: { ...def('site-health'), sources: [{ type: 'file', path: 'missing.md', required: true, label: 'x' }] },
    store, llm: model({ cards: [] }), env: tree(t), now, scheduled: true, log: () => {}, fetchImpl: async () => { throw new Error('no'); } });
  assert.strictEqual(res.notices.length, 1);
  assert.strictEqual(store.cards.length, 1);
  assert.strictEqual((await store.weekReports()).length, 0);
});

test('a Run now a person asked for still answers with a card (nothing folded)', async (t) => {
  const store = createMemoryStore({ lint, now });
  const res = await runAgent({ def: def('site-health'), store, llm: model({ cards: [REPORT] }), ask: 'How fast is TBB this week?', env: tree(t), now,
    log: () => {}, fetchImpl: async () => { throw new Error('no network'); } });
  assert.strictEqual(res.cards.length, 1);
  assert.strictEqual(store.cards.length, 1);
  assert.deepStrictEqual(res.folded, []);
});

test('a dry run folds nothing into the store', async (t) => {
  const { store, res } = await run(t, 'site-health', [REPORT], { dryRun: true });
  assert.strictEqual(res.folded.length, 1);
  assert.strictEqual((await store.weekReports()).length, 0);
  assert.strictEqual(store.cards.length, 0);
});

test('the digest card leads with an action line when drafts are waiting, else stays "No action"', () => {
  const waiting = { agent: 'digest', status: 'draft', title: "Katherine's team: the week to 11.23.2026", body: '**3 drafts waiting for review** across the team this week.' };
  const a = CA.actionLine(waiting);
  assert.strictEqual(a.has_action, true);
  assert.match(a.line, /^Review the 3 drafts waiting on the Review tab\./);
  assert.strictEqual(CA.agrees(waiting), true, 'Approve will: still Got it');
  const none = { ...waiting, body: '**0 drafts waiting for review** across the team this week.' };
  assert.strictEqual(CA.actionLine(none).has_action, false);
  assert.match(CA.actionLine(none).line, /^Nothing to approve/);
});

test('one week of fixture runs: report cards before vs after', async (t) => {
  // The scheduled report runs in one week (lib/producer.js calendar): seo, site-health
  // and scout on Monday, paid-ads on Thursday; one bare report card each, plus SEO's
  // Quick wins card and one Scout card with a blog move.
  const store = createMemoryStore({ lint, now });
  const r = [];
  r.push((await run(t, 'seo', [REPORT, { title: 'Quick wins, week of 11.23.2026', target: null,
    body: '| Page | New SEO title |\n|---|---|\n| /barn-weddings | Barn weddings near Nashville |' }], { store })).res);
  r.push((await run(t, 'site-health', [REPORT], { store })).res);
  r.push((await run(t, 'scout', [REPORT, { title: 'Scout: moves', target: null, body: '### Moves for us\n- A blog post: "Winter barn weddings near Nashville"' }],
    { store, extra: { max_cards: 2 } })).res);
  r.push((await run(t, 'paid-ads', [REPORT], { store })).res);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r.map((x) => x.error)));
  assert.strictEqual(store.cards.length, 2, 'after: Quick wins + the Scout move card');
  assert.strictEqual((await store.weekReports()).length, 4, 'four reports folded');
});
