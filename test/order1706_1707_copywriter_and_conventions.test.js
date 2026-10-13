// ORDERS #1706 (the Copywriter) and #1707 (the Convention Connector).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { textCheckSource, gather } = require('../lib/agent-sources');
const { lint } = require('../lib/ai-tells');
const { matchAgent } = require('../jobs/kh_route');
const { loadAgent } = require('../lib/agent-runner');

test('Copywriter: the text is measured by code first (AI tells and internal codes), then handed over exactly', async () => {
  const text = 'Nestled in the heart of Nashville, TBB holds up to 300 guests — a seamless day.';
  const r = await textCheckSource({ type: 'text_check' }, { ask: text, lint });
  assert.ok(r.ok);
  assert.match(r.table, /1 fail\(s\)/);
  assert.match(r.table, /\| FAIL \| em dash \|/);
  assert.match(r.table, /\| flag \| banned phrase \| nestled \|/);
  assert.match(r.table, /\| flag \| hard capacity \| holds up to 300 \|/);
  assert.match(r.table, /internal code in public copy \| TBB \(write "The Bridge Building"\)/);
  assert.ok(r.text.endsWith(text));
  const clean = await textCheckSource({ type: 'text_check' }, { ask: 'Saddle Woods Farm hosts barn weddings in the fall.', lint });
  assert.match(clean.table, /0 fail\(s\), 0 flag\(s\)/);
  const none = await textCheckSource({ type: 'text_check' }, { lint });
  assert.strictEqual(none.ok, false);
  assert.match(none.why, /paste the text to check/);
});

test('Convention Connector: its web search looks ahead 9 months, with links, never a guessed contact', async () => {
  const a = loadAgent('convention-connector');
  const src = a.sources.find((s) => s.type === 'web_trends');
  const prompts = [];
  const fetch = async (u, o) => { prompts.push(JSON.parse(o.body).messages[0].content); return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) }; };
  const r = await gather([src], { env: { ANTHROPIC_API_KEY: 'k' }, fetch, now: () => new Date('2026-10-13T12:00:00Z') });
  assert.strictEqual(r.got.length, 1, JSON.stringify(r.unavailable));
  assert.strictEqual(prompts.length, src.queries.length);
  for (const p of prompts) {
    assert.match(p, /between today and 9 months from today/);
    assert.match(p, /Never list an item without a link you actually found/);
    assert.doesNotMatch(p, /last 14 days/);
  }
});

test('Scout keeps its 14-day rule (no instruction means the old prompt)', async () => {
  const prompts = [];
  const fetch = async (u, o) => { prompts.push(JSON.parse(o.body).messages[0].content); return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) }; };
  await gather([{ type: 'web_trends', queries: ['x'] }], { env: { ANTHROPIC_API_KEY: 'k' }, fetch });
  assert.match(prompts[0], /last 14 days/);
});

test("Katherine's Drive orders reach the Copywriter and the Convention Connector", () => {
  assert.deepStrictEqual(matchAgent('Copy check on the holiday party email'), ['copywriter']);
  assert.deepStrictEqual(matchAgent('Proofread this flyer before it goes out'), ['copywriter']);
  assert.deepStrictEqual(matchAgent('Which conventions are at Music City Center in March?'), ['convention-connector']);
});
