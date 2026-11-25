// ORDER #3827 (#3826 baton): a Keyword Queen card built from the Search Console
// content gaps file carries payload.gsc_gap ({ query, page, impressions }), the
// field lib/today-top5.js ranks tier 3 by, so the Today box puts the biggest gap
// first. Fixtures only: nothing reaches Search Console, WordPress or a database.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KQ = require('../lib/keyword-queen');
const { today } = require('../lib/today-top5');
const { loadAgent, runAgent } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const MASTER = ['| Canonical venue | Code | Spaces |', '|---|---|---|',
  '| The Bell Tower | **TBT** | Main |', '| Saddle Woods Farm | **SWF** | Barn |'].join('\n');
// The header and row shape box_jobs/gsc_content_gap/content_gap.py write_tree() writes.
const gaps = (rows) => ['# Search Console content gaps, last 12 months (written 11.25.2026 09:02 CT, ORDER #3791)', '',
  '## GAPS (top 300 of 2 by impressions; the full list is in the Sheet and the CSV)', '',
  '| Site | Query | Impressions | Clicks | Avg position | Ranking page | Suggested cluster |',
  '|---|---|---|---|---|---|---|', ...rows].join('\n');
const GAPS_LABEL = 'Search Console content gaps, last 12 months (the Box, read-only)';

function card(rows) {
  const body = ['This week leans on spring planning.', '',
    '| # | Topic | Target keyword | Venue or brand | Monthly volume | Difficulty | Our rank | Source | Why now |',
    '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
  return { title: 'Blog topics for the week of 11.30.2026', target: 'blogs', body };
}
const topic = (n, kw, venue) => `| ${n} | About ${kw} | ${kw} | ${venue} |  |  |  |  | Couples search it. |`;

test('a card built from a gaps row carries payload.gsc_gap with its query, page and impressions', async () => {
  const g = gaps(['| thebelltower.com | rooftop wedding venues | 900 | 2 | 31.0 | https://thebelltower.com/ | suggested: rooftop and downtown |']);
  const got = [{ label: '05_AI_and_Brain/Venue_Master_CANONICAL.md', type: 'file', text: MASTER }, { label: GAPS_LABEL, type: 'file', text: g }];
  const c = card([topic(1, 'rooftop wedding venues', 'The Bell Tower')]);
  const out = await KQ.finishCard(c, { got, store: null });
  assert.deepStrictEqual(out.gsc_gap, { query: 'rooftop wedding venues', page: 'https://thebelltower.com/', impressions: 900, site: 'thebelltower.com' });
  // Nothing else on the card changes: the same card without the gaps file is deep-equal apart from the new key.
  const without = await KQ.finishCard(c, { got: got.slice(0, 1), store: null });
  assert.ok(!('gsc_gap' in without), 'no gaps file: no gsc_gap key');
  const { gsc_gap: _g, ...rest } = out;
  assert.deepStrictEqual(rest, without);
});

test('a card whose topics match no gaps row gets no gsc_gap key', async () => {
  const g = gaps(['| thebelltower.com | rooftop wedding venues | 900 | 2 | 31.0 | https://thebelltower.com/ | x |']);
  const got = [{ label: '05_AI_and_Brain/Venue_Master_CANONICAL.md', type: 'file', text: MASTER }, { label: GAPS_LABEL, type: 'file', text: g }];
  const out = await KQ.finishCard(card([topic(1, 'barn wedding ideas', 'Saddle Woods Farm')]), { got, store: null });
  assert.ok(!('gsc_gap' in out));
});

test('a card naming several gaps carries the biggest one', async () => {
  const g = gaps(['| thebelltower.com | rooftop wedding venues | 900 | 2 | 31.0 | https://thebelltower.com/ | x |',
    '| saddlewoods.com | barn wedding ideas | 40 | 0 | 22.0 | https://saddlewoods.com/barn/ | x |']);
  const got = [{ label: '05_AI_and_Brain/Venue_Master_CANONICAL.md', type: 'file', text: MASTER }, { label: GAPS_LABEL, type: 'file', text: g }];
  const out = await KQ.finishCard(card([topic(1, 'barn wedding ideas', 'Saddle Woods Farm'), topic(2, 'Rooftop Wedding Venues', 'The Bell Tower')]), { got, store: null });
  assert.strictEqual(out.gsc_gap.impressions, 900);
  assert.strictEqual(out.gsc_gap.query, 'rooftop wedding venues');
});

test('the runner saves the gap in the card payload beside the topics', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kq3827-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
  w('05_AI_and_Brain/Venue_Master_CANONICAL.md', MASTER);
  w('07_Marketing_and_Brand/SEO_Data/GSC_Content_Gaps_2026-11-25.md',
    gaps(['| thebelltower.com | rooftop wedding venues | 900 | 2 | 31.0 | https://thebelltower.com/ | x |']));
  w('07_Marketing_and_Brand/AI_TELLS_BAN_LIST.md', 'ban list');
  const def = loadAgent('keyword-queen');
  const noWeb = { ...def, sources: def.sources.filter((s) => s.type !== 'wp_posts') };
  const llm = { model: 'fake', async complete() { return JSON.stringify({ cards: [card([topic(1, 'rooftop wedding venues', 'The Bell Tower')])] }); } };
  const store = createMemoryStore({ lint });
  const r = await runAgent({ slug: 'keyword-queen', def: noWeb, store, llm, env: { AGENT_KEYWORD_QUEEN: 'on', IHG_TREE: d }, dryRun: true,
    now: () => new Date('2026-11-25T18:00:00Z') });
  assert.ok(r.ok, r.error);
  const p = r.cards[0].payload;
  assert.deepStrictEqual(p.gsc_gap, { query: 'rooftop wedding venues', page: 'https://thebelltower.com/', impressions: 900, site: 'thebelltower.com' });
  assert.strictEqual(p.topics.length, 1);
  assert.ok(!('gsc_gap' in r.cards[0]) || r.cards[0].gsc_gap === undefined, 'the gap rides in the payload, not as its own column');
});

test('Today ranks two gap cards 900 first, then 40', () => {
  const kq = (id, imp) => ({ id, status: 'draft', agent: 'keyword-queen', agent_name: 'Keyword Queen', title: `Blog topics ${id}`,
    body: 'b', created_at: `2026-11-2${id}T12:00:00Z`,
    payload: { topics: [{ n: 1, keyword: `k${id}`, venue: 'The Bell Tower' }], gsc_gap: { query: `k${id}`, page: 'https://x/', impressions: imp } } });
  const out = today([kq(1, 40), kq(2, 900)], { now: new Date('2026-11-25T18:00:00Z') });
  assert.deepStrictEqual(out.items.map((i) => i.id), [2, 1]);
});
