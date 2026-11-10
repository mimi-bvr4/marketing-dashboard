// ORDER #3000 (NB via Mimi, rulings 11.05.2026): the National Planner Scout,
// the Gala Scout, Convention Charles's new contact types, the Engagement Sleuth,
// and the shared outreach draft step. Memory store and fakes only: nothing in
// this file reaches HubSpot, Meta or the web.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const P = require('../lib/producer');
const outreach = require('../lib/outreach');
const seed = require('../lib/gala-seed');
const { loadAgent, runAgent } = require('../lib/agent-runner');
const { galaSeedSource } = require('../lib/agent-sources');
const { handoff } = require('../jobs/agent_handoff');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const NEW = { 'planner-scout': 'AGENT_PLANNER_SCOUT', 'gala-scout': 'AGENT_GALA_SCOUT', 'engagement-sleuth': 'AGENT_ENGAGEMENT_SLEUTH' };
const SEED = path.join(__dirname, '..', 'agents', 'gala-scout', 'seed', 'Nashville-Gala-Research-Report-11.05.2026.md');

test('four characters: three new ones and Convention Charles, each with traits', () => {
  for (const slug of [...Object.keys(NEW), 'convention-connector']) {
    const d = loadAgent(slug);
    assert.ok(d.character && d.character.does.length, `${slug} has a character`);
    assert.ok(d.character.traits.length >= 2, `${slug} says what it can and cannot do`);
    for (const t of d.character.traits) assert.ok(t.cant && t.instead, `${slug} trait has both halves`);
  }
  assert.strictEqual(loadAgent('convention-connector').name, 'Convention Charles');
});

test('each new agent ships OFF behind its own switch, on the calendar but never run', async () => {
  for (const [slug, flag] of Object.entries(NEW)) {
    const d = loadAgent(slug);
    assert.strictEqual(d.switch, flag);
    assert.match(P.switchOff(d, {}), new RegExp(`off until Mimi switches it on \\(${flag}\\)`));
    assert.strictEqual(P.switchOff(d, { [flag]: 'on' }), null);
    assert.ok(P.calendar().some((e) => e.agent === slug), `${slug} is on the Producer's calendar`);
    // Run now, OFF: no run row, no model call, no card.
    const store = createMemoryStore({ lint });
    const llm = { model: 'x', complete: async () => { throw new Error('the model must not be called'); } };
    const r = await runAgent({ slug, store, llm, env: {}, ask: 'Denver' });
    assert.ok(r.ok && /off until Mimi/.test(r.skipped));
    assert.strictEqual((await store.list({ status: 'draft' })).length, 0);
  }
  // An agent with no switch is unaffected.
  assert.strictEqual(P.switchOff(loadAgent('scout'), {}), null);
});

test('the board and the Producer day both say OFF and run nothing', async () => {
  const defs = Object.keys(NEW).map((s) => loadAgent(s));
  const b = P.board({ ymd: '2026-11-11', defs, env: {} });
  for (const row of b) { assert.strictEqual(row.state, 'off'); assert.match(row.line, /off until Mimi switches it on/); }
  const ran = [];
  const logs = [];
  const store = { draftsWaiting: async () => 0, producerWeekCards: async () => 0, producerLog: async (r) => logs.push(r) };
  await P.runDay({ ymd: '2026-11-11', store, env: {}, runOne: async (a) => { ran.push(a); return { ok: true, cards: [] }; },
    maxCardsOf: () => 2, defOf: (s) => loadAgent(s) });
  for (const slug of Object.keys(NEW)) assert.ok(!ran.includes(slug), `${slug} was not run`);
  assert.ok(logs.some((l) => l.agent === 'planner-scout' && l.decision === 'paused' && /AGENT_PLANNER_SCOUT/.test(l.why)));
});

test('OUTREACH_AUTO_SEND: off by default, and even on there is no send path', () => {
  assert.strictEqual(outreach.autoSendSwitch({}), false);
  assert.strictEqual(outreach.autoSend({}).send, false);
  assert.strictEqual(outreach.autoSend({ OUTREACH_AUTO_SEND: 'on' }).send, false);
  assert.match(outreach.autoSend({ OUTREACH_AUTO_SEND: 'on' }).why, /not ruled/);
  // The module exports nothing that sends, and requires no mailer.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'outreach.js'), 'utf8');
  assert.ok(!/require\([^)]*(mail|gmail|smtp|send)/i.test(src));
  for (const k of Object.keys(outreach)) assert.ok(!/^send/i.test(k), `no export named ${k}`);
});

test('every outreach draft carries an opt-out and the mailing address, once; auto pot is off', () => {
  const d = outreach.draft({ company: 'X', email: 'Hello.' }, {});
  assert.ok(d.email.includes(outreach.OPT_OUT));
  // #3012: unset = the main office (Mimi's ruling); only an empty string shows the placeholder.
  assert.ok(d.email.includes(outreach.DEFAULT_ADDRESS), 'no address set: the main office, as Mimi ruled');
  assert.ok(outreach.draft({ company: 'X', email: 'Hello.' }, { OUTREACH_MAILING_ADDRESS: '' }).email.includes(outreach.NO_ADDRESS));
  assert.strictEqual(d.auto_pot, false);
  const withAddr = outreach.draft({ company: 'X', email: 'Hello.' }, { OUTREACH_MAILING_ADDRESS: 'ZZ_TEST 1 Example St' });
  assert.ok(withAddr.email.endsWith('ZZ_TEST 1 Example St'));
  assert.strictEqual(outreach.withFooter(withAddr.email, {}), withAddr.email, 'never added twice');
});

test('approved Scout and Gala cards wait for a named salesperson; they never fall through to Cameron', async () => {
  const store = createMemoryStore({ lint });
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); throw new Error('no HubSpot call expected'); };
  for (const agent of ['planner-scout', 'gala-scout']) {
    const row = await store.insert({ agent, agent_name: agent, job: 'x', title: 'ZZ_TEST card', body: 'b', payload: { sales: { company: 'ZZ_TEST Co', email: 'Hi.' } } });
    const out = await store.decide(row.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
    assert.ok(!out.error, out.error);
  }
  const logs = [];
  await handoff({ store, fetchImpl, secrets: () => null, env: { CONVENTION_TO_HUBSPOT: 'on', HUBSPOT_SANDBOX_TOKEN: 't', HANDOFF_VIA_MARY: 'off' }, log: (l) => logs.push(l) });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(logs.filter((l) => /No salesperson set yet/.test(l)).length, 2);
  for (const c of await store.list({ status: 'ready' })) assert.ok(!c.handoff, 'left as is, so it hands off once a salesperson is named');
  assert.strictEqual(outreach.ownerFor('convention-connector'), 'Cameron Creasy');
});

test('Gala seed: the 164 events and 220 undated leads load with their sources', () => {
  const s = seed.load(SEED);
  assert.strictEqual(s.events.length, 164);
  assert.strictEqual(s.leads.length, 220);
  for (const e of s.events) assert.match(e.source, /^https?:\/\//);
  for (const l of s.leads) assert.match(l.source, /^https:\/\/projects\.propublica\.org\//);
});

test('Gala "how much": sourced or blank, IRS label with its tax year, "all events" never one gala', () => {
  const s = seed.load(SEED);
  for (const l of s.leads) {
    if (!l.how_much) continue;
    assert.match(l.how_much.label, /^IRS-reported event gross \(TY\d{4}\)/);
    assert.ok(l.how_much.source, 'a lead figure carries its link');
    assert.ok(!/ticket/i.test(l.how_much.label));
  }
  for (const e of s.events) {
    if (!e.how_much) continue;
    assert.ok(e.how_much.source || /tax year not in the seed/.test(e.how_much.label), 'an unsourced figure says why');
    if (e.how_much.all_events) assert.match(e.how_much.label, /all events/);
  }
  const multi = s.leads.find((l) => /Union Sportsmens/.test(l.org));
  assert.match(multi.how_much.label, /all events/);
  const top = seed.leadsLargestFirst(s.leads);
  assert.match(top[0].org, /Brett Boyer/);
  const months = seed.eventsByMonth(s.events).map((e) => e.month || 13);
  assert.deepStrictEqual(months, months.slice().sort((a, b) => a - b));
});

test('the gala_seed source gives the agent every event and the top 50 leads, inside the file cap', async () => {
  const r = await galaSeedSource({ seed: 'gala-scout/seed/Nashville-Gala-Research-Report-11.05.2026.md', top_leads: 50 }, {});
  assert.ok(r.ok, r.why);
  assert.deepStrictEqual(r.measured, { events: 164, leads: 220 });
  assert.match(r.text, /The 50 largest undated 990 leads/);
  assert.ok(r.text.length < 60000);
  const bad = await galaSeedSource({ seed: '../../package.json' }, {});
  assert.strictEqual(bad.ok, false);
});

test('Convention Charles asks for the CVB contact and the conference vendor and rep contacts', () => {
  const d = loadAgent('convention-connector');
  const web = d.sources.find((s) => s.type === 'web_trends');
  assert.match(web.instruction, /visitors bureau contact/);
  assert.match(web.instruction, /vendors and potential reps/);
  assert.ok(web.queries.some((q) => /Visit Music City/.test(q)));
  assert.match(d.skill, /visitors bureau contact/);
});

test('Engagement Sleuth: one plan card, Meta read access pending, no Meta write anywhere', () => {
  const d = loadAgent('engagement-sleuth');
  assert.strictEqual(d.max_cards, 1);
  assert.ok(!d.sales_fields);
  // #3012: the Meta source is the GET-only reader, pending until the token exists.
  assert.ok(d.sources.some((s) => s.type === 'meta_ads_read' && /Meta/.test(s.label)));
  assert.match(d.skill, /never find, name, describe or contact a person who got engaged/i);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-sources.js'), 'utf8');
  assert.ok(!/graph\.facebook\.com/.test(src), 'no Meta Graph API call in the sources');
});
