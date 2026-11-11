'use strict';
// ORDER #3224: gala-scout FAILED at 11.11.2026 06:00 CT. Both answers stopped
// at max_tokens (12000 tokens, about 35,500 characters) inside the FIRST card,
// so the #2910 salvage had no whole card to keep, and the #2910 re-ask ("write
// fewer cards and keep each body short") came back just as long. The first
// card is "Galas by month": one row per event, and the starting set has 164
// events plus 50 leads, so a long answer is normal for this agent.
// This test proves:
//   - a re-ask after a length stop names a real cap: a card count and a
//     character budget per card (RED on main: main's re-ask names neither);
//   - a twice-cut answer with no whole card is never saved half-written;
//   - a cut answer that does hold whole cards keeps them and says so in the log.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAgent, loadAgent, draftCards } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const CHARS_PER_TOKEN = 3; // 11.11: 12000 tokens stopped at 35,672 and 35,486 characters

// A fake gala-scout model. It writes the "Galas by month" table one row per
// event until the length limit stops it, unless the ask names a character
// budget per card, in which case it keeps the table under that budget.
function galaModel() {
  const calls = [];
  const row = (i) => `| Host org ${i} | Spring Gala ${i} | a downtown ballroom | 04.${String((i % 28) + 1).padStart(2, '0')}.2027 | 400 guests | IRS-reported event gross (TY2024) | https://example.org/gala-${i} |\n`;
  return { model: 'fake', calls, lastStop: null,
    async complete(req) {
      calls.push(req);
      const limit = req.maxTokens * CHARS_PER_TOKEN;
      const m = /each card body under (\d+) characters/.exec(req.user);
      const budget = m ? Number(m[1]) : Infinity;
      const head = '{"cards":[{"title":"Galas by month, 11.11.2026","target":"sales","body":"| Host | Event | Venue | Date | Size | How much | Source |\\n|---|---|---|---|---|---|---|\\n';
      let body = '';
      for (let i = 1; i <= 400 && body.length + 200 < budget; i++) body += row(i).replace(/\n/g, '\\n');
      const whole = head + body + '"}';
      const second = ',{"title":"Draft emails, 11.11.2026","target":"sales","body":"' + 'Dear events team, '.repeat(40) + '"}';
      const text = whole + (m ? '' : second) + ']}';
      if (text.length > limit) { this.lastStop = 'max_tokens'; return text.slice(0, limit); }
      this.lastStop = 'end_turn';
      return text;
    } };
}

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt3224-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'seed.md'), '# Gala seed\n164 events, 220 undated 990 filers.\n');
  return { IHG_TREE: root, AGENT_GALA_SCOUT: 'on' }; // the switch is on in production since its first run
}
function galaDef() {
  return { ...loadAgent('gala-scout'), copy_prepass: false, seen_before: null, sales_fields: false,
    sources: [{ type: 'file', path: 'seed.md', required: true, label: 'the gala seed' }] };
}

test('gala-scout really is cut off inside its first card at its own limit (the 11.11 shape)', async () => {
  const def = loadAgent('gala-scout');
  const llm = galaModel();
  const text = await llm.complete({ system: 's', user: 'u', maxTokens: def.max_tokens });
  assert.strictEqual(llm.lastStop, 'max_tokens');
  assert.strictEqual(text.indexOf('}'), -1, 'no card closed before the break, so there is nothing whole to keep');
});

test('the re-ask after a length stop names a card count and a character budget per card', async () => {
  const llm = galaModel();
  const lines = [];
  const cards = await draftCards(llm, { system: 's', user: 'u', maxTokens: 12000, max: 2, log: (l) => lines.push(l), slug: 'gala-scout' });
  assert.strictEqual(llm.calls.length, 2);
  assert.match(llm.calls[1].user, /cut off at the length limit/);
  assert.match(llm.calls[1].user, /fewer cards/, '#2910 words kept');
  assert.match(llm.calls[1].user, /at most 1 card/);
  const budget = Number(/each card body under (\d+) characters/.exec(llm.calls[1].user)[1]);
  assert.ok(budget > 1000 && budget < 12000 * CHARS_PER_TOKEN, `budget ${budget} fits under the limit`);
  assert.strictEqual(cards.length, 1);
  assert.match(cards[0].title, /^Galas by month/);
  assert.ok(cards[0].body.length <= budget);
});

test('gala-scout twice at its own limit: the run saves readable cards, not a length-limit FAILED', async (t) => {
  const store = createMemoryStore({ lint });
  const lines = [];
  const r = await runAgent({ def: galaDef(), store, llm: galaModel(), env: tree(t), log: (l) => lines.push(l),
    fetchImpl: async () => { throw new Error('no network'); } });
  assert.strictEqual(r.ok, true, lines.join('\n'));
  assert.ok(!lines.some((l) => /FAILED/.test(l)), lines.join('\n'));
  assert.ok(r.cards.some((c) => /^Galas by month/.test(c.title)));
  assert.ok(!r.cards.some((c) => /run failed/.test(c.title)));
});

test('a model that ignores the cap: one FAILED line, and no half-written card is ever saved', async (t) => {
  const store = createMemoryStore({ lint });
  const cut = '{"cards":[{"title":"Galas by month, 11.11.2026","body":"| Host | Event |\\n' + '| a | b |\\n'.repeat(50);
  const llm = { model: 'fake', calls: [], lastStop: null,
    async complete(req) { this.calls.push(req); this.lastStop = 'max_tokens'; return cut; } };
  const lines = [];
  const r = await runAgent({ def: galaDef(), store, llm, env: tree(t), log: (l) => lines.push(l),
    fetchImpl: async () => { throw new Error('no network'); } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(lines.filter((l) => /FAILED/.test(l)).length, 1);
  assert.strictEqual(r.cards.length, 1);
  assert.match(r.cards[0].title, /run failed/);
  assert.match(r.cards[0].body, /cut off before it finished/);
});

test('a cut answer that holds whole cards keeps them, drops the unfinished one, and logs it', async () => {
  const t = '{"cards":[{"title":"Galas by month, 11.11.2026","body":"| a | b |"},{"title":"Draft emails","body":"Dear events team, we would lo';
  const llm = { model: 'fake', calls: [], lastStop: null,
    async complete(req) { this.calls.push(req); this.lastStop = 'max_tokens'; return t; } };
  const lines = [];
  const cards = await draftCards(llm, { system: 's', user: 'u', maxTokens: 12000, max: 2, log: (l) => lines.push(l), slug: 'gala-scout' });
  assert.deepStrictEqual(cards.map((c) => c.title), ['Galas by month, 11.11.2026']);
  assert.strictEqual(llm.calls.length, 1, 'whole cards in hand: no second ask');
  assert.ok(lines.some((l) => /^gala-scout: answer cut off at the length limit; kept 1 whole card, anything unfinished dropped$/.test(l)), lines.join('\n'));
});
