'use strict';
// ORDER #3865 (follow-on to #3857): a competitor profile is internal reading for
// Katherine and sales, never published. The two capacity rules (RULINGS_LEDGER
// 10.09.2026 12:08 CT "any number we publish", and #3605's one-room rule) govern
// IHG's own published copy, so a competitor's own numbers in a profile must not
// make the profile writer ask for a second draft. Every other tell (AI tells,
// 10.09.2026 11:54 CT, "applies to every agent") still runs on profiles, and a
// marketing card with a hard capacity still blocks Approve (10.13.2026, #1748).
// Memory store and fake models only: no model call, nothing saved outside memory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const C = require('../lib/competitor-profiles');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

// The two lines #3857's lint flagged, in a competitor's own words.
const CAP_LINES = {
  'At a glance': 'Schermerhorn Symphony Center hosts events from a dinner for 20 to a gala reception for 1,200. The concert hall has 1,844 seats.',
  'Spaces and events they sell': 'Their site says the Laura Turner Hall holds 2027 for performances; the lobby takes receptions.',
};
const bodyFor = (h, extra = {}) => extra[h] || CAP_LINES[h] || 'Not published on the pages read this week.';
const profile = (extra) => C.HEADINGS.map((h) => `## ${h}\n${bodyFor(h, extra)}`).join('\n\n') + '\n\n```claims\n[]\n```';
const CAP_PROFILE = profile();

async function setup() {
  const store = createMemoryStore({ lint });
  await store.syncCompetitors([{ site: 'nashvillesymphony.org', name: 'Nashville Symphony', brands: ['TBB'], top: true }]);
  await store.saveSnapshots('scout', 'nashvillesymphony.org', [{ path: '/', title: 'Symphony', hash: 'a', text: 'Private events at Schermerhorn.' }], []);
  return store;
}
const noWeb = async () => ({ status: 404, text: async () => '' });
const model = (answers) => {
  const calls = [];
  return { calls, lastStop: 'end_turn', async complete(a) { calls.push(a); return answers[Math.min(calls.length - 1, answers.length - 1)]; } };
};

test('the fixture really trips both capacity rules in the shared lint (so the tests below prove the exemption)', () => {
  const rules = lint(C.splitClaims(CAP_PROFILE).text).flags.map((f) => f.rule);
  assert.ok(rules.includes('hard capacity'), rules.join(', '));
  assert.ok(rules.includes('TBB one-room capacity'), rules.join(', '));
});

test('(a) a profile quoting a competitor hard capacity and a one-room capacity is clean and gets no second draft', async () => {
  const out = C.cleanProfile(C.splitClaims(CAP_PROFILE).text);
  assert.equal(out.error, undefined);
  assert.equal(out.tells.clean, true, JSON.stringify(out.tells.flags));
  const store = await setup();
  const llm = model([CAP_PROFILE]);
  const r = await C.writeProfiles({ store, llm, fetchImpl: noWeb });
  assert.equal(r.written, 1, JSON.stringify(r.failed));
  assert.equal(llm.calls.length, 1, 'one draft, no second call');
});

test('(b) the same profile with a listed AI tell still flags and still gets a second draft', async () => {
  const tell = profile({ 'Watch for': 'They delve into seamless corporate packages.' });
  const out = C.cleanProfile(C.splitClaims(tell).text);
  assert.equal(out.tells.clean, false);
  assert.deepEqual(out.tells.flags.map((f) => f.phrase).sort(), ['delve', 'seamless']);
  const store = await setup();
  const llm = model([tell, CAP_PROFILE]);
  const r = await C.writeProfiles({ store, llm, fetchImpl: noWeb });
  assert.equal(llm.calls.length, 2, 'the AI tell still asks for a second draft');
  assert.match(llm.calls[1].user, /Your last draft was refused \(AI-tell phrases\)/);
  assert.equal(r.written, 1);
});

test('(b) an em dash in a profile is still replaced by the Box and counted, as before', () => {
  const out = C.cleanProfile(C.splitClaims(profile({ 'Watch for': 'New rooftop — opening spring.' })).text);
  assert.equal(out.dashes, 1);
  assert.doesNotMatch(out.md, /—/);
});

test('(c) a marketing card with a hard capacity still blocks Approve, exactly as before', async () => {
  const store = createMemoryStore({ lint });
  const row = await store.insert({ agent_name: 'x', job: 'x', agent: 'gbp', title: 'Reply', body: 'Our barn holds 300 guests.' });
  const out = await store.decide(row.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
  assert.match(out.error, /^Approve refused: /);
  assert.match(out.error, /hard capacity "holds 300"/);
  assert.equal(row.status, 'draft');
  // The shared lint is unchanged: still flags both rules for every other caller.
  assert.deepEqual(lint('The ballroom holds 300 guests.').flags.map((f) => f.rule), ['hard capacity']);
  assert.deepEqual(lint('A gala reception for 1,200 in the ballroom.').flags.map((f) => f.rule), ['TBB one-room capacity']);
});

test('(d) source guard: the exemption is chosen by the profile writer, not a global switch or an env var', () => {
  const tells = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai-tells.js'), 'utf8');
  const prof = fs.readFileSync(path.join(__dirname, '..', 'lib', 'competitor-profiles.js'), 'utf8');
  assert.doesNotMatch(tells, /process\.env/, 'the shared lint reads no env var');
  assert.doesNotMatch(tells, /3865/, 'the shared lint is not changed for this order');
  assert.match(prof, /PROFILE_SKIP_RULES\s*=\s*\['hard capacity', 'TBB one-room capacity'\]/);
  assert.doesNotMatch(prof.slice(prof.indexOf('PROFILE_SKIP_RULES')), /process\.env/, 'no env var decides it');
  assert.deepEqual(C.PROFILE_SKIP_RULES, ['hard capacity', 'TBB one-room capacity']);
});
