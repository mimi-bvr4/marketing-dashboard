'use strict';
// ORDER #3847: competitor profiles, 0 of 20 written on 11.16 and 11.23.2026,
// every one "missing section(s): At a glance, ... Watch for" (19 of them all 7,
// nashvillesymphony.org the last 6, so it got as far as "## At a glance").
//
// Measured, from ~/Library/Logs/ihg_marketing_agents.out:
//   - 10.19, 10.26, 11.02, 11.09: 19 written, model claude-sonnet-4-6.
//   - 11.12 on: model claude-sonnet-5-5 (#3249, lib/agent-llm.js DEFAULT_MODEL).
//   - 11.16, 11.23: 0 written, the strings above.
//   - 11.23 seo (agent max_tokens 9000): "first answer unreadable (stop
//     max_tokens) ... characters 693 to 773 of 773". A 9000-token budget gave
//     773 characters of text, so about 8,740 of those tokens were spent before
//     any text the client keeps (agent-llm.js joins text blocks only).
//   - writeProfiles asked for maxTokens 1500. Under that model the budget runs
//     out before the first heading (all 7 missing), or just after it (6 missing).
//
// The fixture model below reproduces that: it spends OVERHEAD tokens of the
// max_tokens budget first, then writes the full answer at ~3 characters per
// token (the Sonnet 4.6 gala-scout measurement, 12000 tokens = 35,672 chars),
// cut where the budget ends, with stop_reason max_tokens.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../lib/competitor-profiles');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const ALL_7 = `missing section(s): ${C.HEADINGS.join(', ')}`;
const LAST_6 = `missing section(s): ${C.HEADINGS.slice(1).join(', ')}`;
const MEASURED_OVERHEAD = 9000 - Math.ceil(773 / 3); // the 11.23 seo answer

const body = (h) => (h === 'At a glance' ? 'A historic mansion venue on the Cumberland River, sold for weddings and private parties.'
  : 'Not published on the pages read this week. The Scout reads the site again next Monday and this section is refreshed then.');
const PROFILE = C.HEADINGS.map((h) => `## ${h}\n${body(h)}`).join('\n\n');
const FULL = `${PROFILE}\n\n\`\`\`claims\n[]\n\`\`\``;

function fixtureModel(overhead) {
  const calls = [];
  return {
    calls,
    lastStop: null,
    async complete({ maxTokens }) {
      calls.push(maxTokens);
      const room = Math.max(0, (maxTokens || 8000) - overhead) * 3;
      if (FULL.length > room) { this.lastStop = 'max_tokens'; return FULL.slice(0, room); }
      this.lastStop = 'end_turn';
      return FULL;
    },
  };
}

async function setup() {
  const store = createMemoryStore({ lint });
  await store.syncCompetitors([{ site: 'riverwoodmansion.com', name: 'Riverwood Mansion', brands: ['ECD'], top: true }]);
  await store.saveSnapshots('scout', 'riverwoodmansion.com', [{ path: '/', title: 'Riverwood', hash: 'a', text: 'Weddings and private parties on the Cumberland.' }], []);
  return store;
}
const noWeb = async () => ({ status: 404, text: async () => '' });

test('the measured shape: a 1500-token budget spent before the text gives the exact 11.23 string for all 7', () => {
  const room = Math.max(0, 1500 - MEASURED_OVERHEAD) * 3;
  assert.equal(C.cleanProfile(FULL.slice(0, room)).error, ALL_7);
});

test('the measured shape: cut just after "## At a glance" gives the exact nashvillesymphony.org string', () => {
  const cut = FULL.slice(0, FULL.indexOf('## Spaces'));
  assert.equal(C.cleanProfile(cut).error, LAST_6);
});

test('RED on main: with the measured overhead, a full answer is written, not refused as missing sections', async () => {
  const store = await setup();
  const llm = fixtureModel(MEASURED_OVERHEAD);
  const r = await C.writeProfiles({ store, llm, fetchImpl: noWeb });
  assert.deepEqual(r.failed, [], `refused: ${JSON.stringify(r.failed)}`);
  assert.equal(r.written, 1);
  const saved = (await store.competitor('riverwoodmansion.com')).profile_md;
  for (const h of C.HEADINGS) assert.match(saved, new RegExp(`^## ${h}$`, 'm'));
  assert.equal(llm.calls.length, 1, 'one call, no retry needed');
});

test('a cut-off answer is still refused, and the why says it was cut off, so the log names the cause', async () => {
  const store = await setup();
  const llm = fixtureModel(C.PROFILE_MAX_TOKENS + 1000); // the budget is spent before any text, every time
  const r = await C.writeProfiles({ store, llm, fetchImpl: noWeb });
  assert.equal(r.written, 0);
  assert.equal(llm.calls.length, 2, 'the one retry is kept');
  assert.equal(r.failed[0].why, `${ALL_7} (answer cut off at the length limit)`);
  assert.equal((await store.competitor('riverwoodmansion.com')).profile_md || null, null, 'nothing saved');
});

test('a really missing section is still refused when the answer was NOT cut off, with the plain why', async () => {
  const store = await setup();
  const short = C.HEADINGS.slice(0, 6).map((h) => `## ${h}\n${body(h)}`).join('\n\n') + '\n\n```claims\n[]\n```';
  const llm = { lastStop: null, async complete() { this.lastStop = 'end_turn'; return short; } };
  const r = await C.writeProfiles({ store, llm, fetchImpl: noWeb });
  assert.equal(r.written, 0);
  assert.equal(r.failed[0].why, 'missing section(s): Watch for');
});

test('the budget leaves room for the measured overhead plus a full profile and its claims list', () => {
  assert.ok(C.PROFILE_MAX_TOKENS >= MEASURED_OVERHEAD + 3000, `PROFILE_MAX_TOKENS ${C.PROFILE_MAX_TOKENS}`);
});
