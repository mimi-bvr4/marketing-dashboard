// ORDER #3243: every "Waiting on" line is a live check. A passing check's line
// disappears; a failing one says why and when it was last checked; a check that
// fails twice asks for ONE text, never one per run; no secret value is read.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/agent-checks');
const { characterOf } = require('../routes/agents');
const { loadAgent, listAgents } = require('../lib/agent-runner');
const { createMemoryStore } = require('../lib/agent-store');
const { runChecks } = require('../jobs/agent_checks');

const NOW = new Date('2026-11-11T18:00:00-06:00');
const rows = (...r) => new Map(r.map((x) => [x.id, x]));

test('a switch-on env makes the "switch it on" line vanish', async () => {
  const c = C.checkFor('Mimi: switch it on (AGENT_GALA_SCOUT)');
  assert.strictEqual(c.id, 'switch:AGENT_GALA_SCOUT');
  assert.deepStrictEqual(await C.runCheck(c, { env: { AGENT_GALA_SCOUT: 'on' } }), { ok: true, reason: 'AGENT_GALA_SCOUT is on' });
  assert.strictEqual((await C.runCheck(c, { env: {} })).ok, false);
  const gala = loadAgent('gala-scout');
  const on = rows({ id: 'switch:AGENT_GALA_SCOUT', ok: true, reason: 'on', checked_at: NOW.toISOString() });
  assert.ok(!characterOf(gala, [], null, NOW, on, {}).needs.some((n) => /switch it on/.test(n)), 'checked on: gone');
  // Never checked yet, but the dashboard's own env has it on: gone too.
  assert.ok(!characterOf(gala, [], null, NOW, null, { AGENT_GALA_SCOUT: 'on' }).needs.some((n) => /switch it on/.test(n)));
  // Never checked and not on here: the line stays as written.
  assert.ok(characterOf(gala, [], null, NOW, null, {}).needs.includes('Mimi: switch it on (AGENT_GALA_SCOUT)'));
});

test('a failing check shows its reason and "last checked <time CT>"', () => {
  const off = rows({ id: 'switch:AI_TELL_DETECTIVE', ok: false, reason: 'AI_TELL_DETECTIVE is not on in the env this job runs with', checked_at: NOW.toISOString() });
  const needs = characterOf(loadAgent('ai-tell-detective'), [], null, NOW, off, {}).needs;
  assert.ok(needs.includes('Mimi: switch it on (AI_TELL_DETECTIVE) (failing: AI_TELL_DETECTIVE is not on in the env this job runs with; last checked 11.11 18:00 CT)'), needs.join(' | '));
});

test('a Keychain item present clears the key wait, and the check never reads the value', async () => {
  const c = C.checkFor(loadAgent('monthly-report').character.needs[0]);
  assert.strictEqual(c.id, 'keychain:marketing-fleet-key');
  let asked = null;
  const res = await C.runCheck(c, { env: {}, keychainHas: (svc) => { asked = svc; return true; } });
  assert.deepStrictEqual(res, { ok: true, reason: "Keychain item 'marketing-fleet-key' exists" });
  assert.strictEqual(asked, 'marketing-fleet-key');
  assert.strictEqual((await C.runCheck(c, { env: {}, keychainHas: () => false })).ok, false);
  // The real probe asks `security` for the item WITHOUT -w (exit code only).
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-checks.js'), 'utf8');
  const probe = src.slice(src.indexOf('function keychainHas'), src.indexOf('async function runCheck'));
  assert.match(probe, /\['find-generic-password', '-s', service\]/);
  assert.doesNotMatch(probe, /'-w'/);
  assert.match(probe, /stdio: 'ignore'/);
  const ok = rows({ id: 'keychain:marketing-fleet-key', ok: true, reason: 'x', checked_at: NOW.toISOString() });
  const needs = characterOf(loadAgent('monthly-report'), [], null, NOW, ok, {}).needs;
  assert.ok(!needs.some((n) => /marketing-fleet-key/.test(n)));
  assert.ok(needs.some((n) => /^Katherine: the Google \+ Meta ads export Sheet/.test(n)), 'an unchecked need stays');
});

test('a run reason whose check now passes is dropped; one line per failing check', () => {
  const d = { sources: [], character: { needs: ['Google: Search Console access for the Box (ORDER #2958)'] } };
  const run = { started_at: NOW.toISOString(), unavailable: [{ label: 'Search Console', type: 'search_console', why: 'Search Console has none of our sites open to the Box yet.' }] };
  const pass = rows({ id: 'search-console:sites', ok: true, reason: '3 of our sites listed', checked_at: NOW.toISOString() });
  assert.deepStrictEqual(characterOf(d, [], run, NOW, pass, {}).needs, []);
  const fail = rows({ id: 'search-console:sites', ok: false, reason: 'Search Console lists none of our sites for the Brain account', checked_at: NOW.toISOString() });
  const needs = characterOf(d, [], run, NOW, fail, {}).needs;
  assert.strictEqual(needs.length, 1);
  assert.match(needs[0], /^Google: Search Console access for the Box \(ORDER #2958\) \(failing: Search Console lists none/);
});

test('press alerts: each sender must have reached brain@ in 14 days', async () => {
  const c = C.checkFor(loadAgent('pr-patty').character.needs[0]);
  assert.strictEqual(c.id, 'mail:press-alerts');
  const seen = [];
  const two = await C.runCheck(c, { mailCount: async (q) => { seen.push(q); return /be inspired/i.test(q) ? 0 : 2; } });
  assert.deepStrictEqual(two, { ok: false, reason: 'no email in brain@infinityhospitality.net in the last 14 days from Be Inspired PR' });
  assert.ok(seen.every((q) => q.startsWith('newer_than:14d ')));
  assert.strictEqual((await C.runCheck(c, { mailCount: async () => 1 })).ok, true);
});

test('a check that fails twice texts once, and never again while it keeps failing', async () => {
  const store = createMemoryStore({ lint: () => ({}) });
  const alerts = [];
  let t = NOW.getTime();
  const opts = { ctx: { env: {}, keychainHas: () => false, searchConsoleSites: async () => 2, mailCount: async () => 1 },
    now: () => new Date(t += 900000), env: { AGENT_CHECK_ALERTS: 'on' }, log: () => {}, requestAlert: (l) => alerts.push(l) };
  for (let i = 0; i < 5; i++) await runChecks(store, opts);
  const keyAlerts = alerts.filter((l) => /marketing-fleet-key/.test(l));
  assert.strictEqual(keyAlerts.length, 1, alerts.join('\n'));
  // One per failing check (each switch and the key), none for the passing ones.
  assert.ok(!alerts.some((l) => /search-console|press-alerts/.test(l)));
  assert.strictEqual(new Set(alerts).size, alerts.length);
  // It passes, then fails twice more: one new alert.
  await runChecks(store, { ...opts, ctx: { ...opts.ctx, keychainHas: () => true } });
  for (let i = 0; i < 3; i++) await runChecks(store, opts);
  assert.strictEqual(alerts.filter((l) => /marketing-fleet-key/.test(l)).length, 2);
});

test('alerts ship OFF: with no AGENT_CHECK_ALERTS nothing is requested', async () => {
  const store = createMemoryStore({ lint: () => ({}) });
  const alerts = [];
  const opts = { ctx: { env: {}, keychainHas: () => false, searchConsoleSites: async () => 0, mailCount: async () => 0 }, env: {}, log: () => {}, requestAlert: (l) => alerts.push(l) };
  await runChecks(store, opts); await runChecks(store, opts);
  assert.deepStrictEqual(alerts, []);
  assert.ok((await store.checkRows()).every((r) => r.ok === false && r.alerted_at), 'the due alert is still recorded');
});

test('every check the fleet names is one this module can run', () => {
  const all = C.fleetChecks(listAgents().map((s) => [s, loadAgent(s)]));
  const ids = all.map((c) => c.id);
  for (const want of ['switch:AGENT_GALA_SCOUT', 'switch:AGENT_PLANNER_SCOUT', 'switch:AGENT_ENGAGEMENT_SLEUTH', 'switch:AI_TELL_DETECTIVE', 'keychain:marketing-fleet-key', 'mail:press-alerts']) {
    assert.ok(ids.includes(want), `${want} in ${ids.join(', ')}`);
  }
  assert.ok(all.every((c) => ['switch', 'keychain', 'search_console', 'mail_senders'].includes(c.kind)));
});

test('both Box jobs run the checks first', () => {
  for (const f of ['agents_daily.sh', 'agents_handoff.sh']) {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'jobs', f), 'utf8');
    assert.ok(sh.indexOf('node jobs/agent_checks.js') > 0 && sh.indexOf('node jobs/agent_checks.js') < sh.indexOf('node jobs/', sh.indexOf('node jobs/agent_checks.js') + 5), f);
  }
});
