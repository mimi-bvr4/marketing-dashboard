// ORDER #3165: approved lead batches land on Mary Topp's Sales Hand-off desk;
// Mary picks the salesperson per batch (HANDOFF_VIA_MARY, shipped ON).
// Fixtures and fakes only: nothing here reaches HubSpot, Dispatch or the web.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const desk = require('../lib/mary-desk');
const roster = require('../lib/sales-roster');
const access = require('../lib/access');
const { pageGate } = require('../middleware/page-gate');
const { handoff } = require('../jobs/agent_handoff');
const { createMemoryStore } = require('../lib/agent-store');
const { createHandoffRouter } = require('../routes/handoff');
const { createReviewRouter } = require('../routes/review');
const { lint } = require('../lib/ai-tells');

// HANDOFF_VIA_MARY unset: the shipped default, ON.
const SANDBOX = { CONVENTION_TO_HUBSPOT: 'on', HUBSPOT_SANDBOX_TOKEN: 'ZZ_TEST_TOKEN' };
const MARY = { email: 'mtopp@infinityhospitality.net', name: 'Mary Topp' };
const KATHERINE = { email: 'khowe@infinityhospitality.net', name: 'Katherine Howe' };

function fakeHubSpot({ portalId = 51163869, owners = [] } = {}) {
  const writes = []; const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET'; const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path: u.pathname, body });
    const res = (status, j) => ({ ok: status < 300, status, json: async () => j });
    if (u.host !== 'api.hubapi.com') throw new Error(`unexpected host ${u.host}`);
    if (u.pathname === '/account-info/v3/details') return res(200, { portalId });
    if (u.pathname === '/crm/v3/owners') return res(200, { results: owners });
    if (u.pathname === '/crm/v3/objects/companies/search') return res(200, { results: [] });
    if (u.pathname === '/crm/v3/objects/companies' && method === 'POST') { writes.push({ kind: 'company', body }); return res(201, { id: '700' + writes.length }); }
    if (u.pathname === '/crm/v3/objects/tasks' && method === 'POST') { writes.push({ kind: 'task', body }); return res(201, { id: '800' + writes.length }); }
    throw new Error(`unexpected HubSpot call ${method} ${u.pathname}`);
  };
  return { fetchImpl, writes, calls };
}

// One Planner Scout run, two leads, approved by Katherine with a note.
async function approvedPlannerBatch(store, { run_id = 7 } = {}) {
  const ids = [];
  for (const co of ['ZZ_TEST Peach Events', 'ZZ_TEST Magnolia Planning']) {
    const row = await store.insert({ agent: 'planner-scout', agent_name: 'National Planner Scout', job: 'planners', target: 'Atlanta', run_id,
      title: `${co}, Atlanta`, body: 'Published in Atlanta society coverage for galas and luxury weddings.',
      sources: [{ label: 'ZZ_TEST magazine feature', url: 'https://zz-test.example/feature', ok: true }],
      payload: { sales: { company: co, website: 'https://zz-test.example', subject: 'Luxury weddings in Nashville', email: 'Hello, we host luxury weddings and galas in Nashville. Luxury weddings are our work.' } } });
    const out = await store.decide(row.id, { action: 'approve', who: KATHERINE.email, reason: 'Strong gala fit' });
    assert.ok(!out.error, out.error);
    ids.push(row.id);
  }
  return ids;
}

// The live roster, built from fixtures: dispatch people + HubSpot owners.
const PEOPLE = [
  { person_id: 'p_cam', name: 'Cameron Creasy', employment_title: 'Sales', job_subrole: 'Venue Sales Director', primary_email: 'ccreasy@infinityhospitality.net' },
  { person_id: 'p_meg', name: 'Megan Hogan', employment_title: 'Sales', primary_email: 'meganhogan5@gmail.com' },
  { person_id: 'p_mar', name: 'Marissa Moore', employment_title: 'Sales', job_subrole: 'Venue Sales Specialist (Elle)', primary_email: 'mmoore@infinityhospitality.net' },
  { person_id: 'p_kat', name: 'Katie Bradley', employment_title: 'Sales', primary_email: 'kbradley@infinityhospitality.net' },
  { person_id: desk.MARY_PERSON_ID, name: 'Mary Topp', employment_title: 'Sales', primary_email: MARY.email },
  { person_id: 'p_dan', name: 'Danielle Makram', employment_title: 'Sales', job_subrole: 'Catering Sales Director', primary_email: 'danielle@dreameventsandcatering.com' },
];
const OWNERS = [
  { id: '79905153', firstName: 'Cameron', lastName: 'Creasy', email: 'ccreasy@infinityhospitality.net' },
  // A same-name decoy with another email: the join is by email, never by name.
  { id: '5555', firstName: 'Marissa', lastName: 'Moore', email: 'someone-else@example.com' },
  { id: '88308673', firstName: 'Katie', lastName: 'Bradley', email: 'kbradley@infinityhospitality.net' },
  { id: '87853792', firstName: 'Danielle', lastName: 'Makram', email: 'danielle@dreameventsandcatering.com' },
  { id: '79618815', firstName: 'Mary', lastName: 'Topp', email: 'salesadmin@infinityhospitality.net' },
];
const ROSTER = roster.buildRoster({ people: PEOPLE, owners: OWNERS });

function identityFor(map) { return { lookup: async (email) => map[email] || { active: false } }; }
const IDENTITY = identityFor({
  [MARY.email]: { active: true, rung: 1, person_id: desk.MARY_PERSON_ID },
  [KATHERINE.email]: { active: true, rung: 2, person_id: access.KATHERINE_PERSON_ID },
  'mimi@infinityhospitality.net': { active: true, rung: 3, person_id: 'p_mimi' },
});

async function withApp(store, who, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.mktUser = who; next(); });
  app.use(createHandoffRouter({ store, identity: IDENTITY, roster: async () => ({ people: ROSTER, why: null, where: 'sandbox' }), env: {} }));
  app.use(createReviewRouter({ store }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try { return await fn({ base, post }); } finally { srv.close(); }
}

test('an approved Planner Scout batch lands on /handoff, with no salesperson, and the Box makes zero HubSpot calls', async () => {
  const store = createMemoryStore({ lint });
  await approvedPlannerBatch(store);
  const hs = fakeHubSpot({ owners: OWNERS });
  const r = await handoff({ store, fetchImpl: hs.fetchImpl, secrets: () => null, env: SANDBOX, log: () => {} });
  assert.strictEqual(hs.calls.length, 0, 'no card reaches a salesperson without Mary');
  assert.strictEqual(r.seen, 0, 'waiting cards do not even fill the hand-off batch');
  await withApp(store, MARY, async ({ base }) => {
    const j = await (await fetch(base + '/api/handoff')).json();
    assert.strictEqual(j.on, true);
    assert.strictEqual(j.batches.length, 1, 'one run is one batch');
    const b = j.batches[0];
    assert.strictEqual(b.state, 'waiting');
    assert.match(b.line, /^Waiting on Mary to pick a salesperson/);
    assert.strictEqual(b.agent_name, 'National Planner Scout');
    assert.strictEqual(b.target, 'Atlanta');
    assert.deepStrictEqual(b.approve_notes, ['Strong gala fit']);
    assert.ok(b.keywords.includes('luxury'), `keywords: ${b.keywords}`);
    assert.strictEqual(b.leads.length, 2);
    assert.ok(b.leads.every((l) => l.email && l.sources.length && !l.handoff));
    assert.strictEqual(j.can_pick, true);
    assert.match(j.waiting_line, /^1 batch waiting for a salesperson/);
  });
});

test('assign to a test owner id runs the existing hand-off exactly once; a second assign is refused', async () => {
  const store = createMemoryStore({ lint });
  const ids = await approvedPlannerBatch(store);
  await withApp(store, MARY, async ({ post }) => {
    const a = await post('/api/handoff/assign', { card_ids: ids, owner_id: '79905153' });
    assert.strictEqual(a.status, 200);
    const aj = await a.json();
    assert.ok(aj.results.every((x) => x.ok));
    const again = await post('/api/handoff/assign', { card_ids: ids, owner_id: '87853792' });
    assert.strictEqual(again.status, 409, 'no double hand-off');
    assert.ok((await again.json()).results.every((x) => !x.ok));
  });
  const c = await store.get(ids[0]);
  assert.strictEqual(c.assignment.owner_id, '79905153');
  assert.strictEqual(c.assignment.by_name, 'Mary Topp');
  assert.match(desk.leadState(c).line, /^Assigned to Cameron Creasy by Mary Topp, \d\d\/\d\d\/\d{4}$/);
  const hs = fakeHubSpot({ owners: OWNERS });
  await handoff({ store, fetchImpl: hs.fetchImpl, secrets: () => null, env: SANDBOX, log: () => {} });
  await handoff({ store, fetchImpl: hs.fetchImpl, secrets: () => null, env: SANDBOX, log: () => {} });
  const tasks = hs.writes.filter((w) => w.kind === 'task');
  assert.strictEqual(tasks.length, 2, 'one task per lead, once');
  assert.ok(tasks.every((t) => t.body.properties.hubspot_owner_id === '79905153'));
  const done = await store.get(ids[1]);
  assert.strictEqual(done.handoff.ok, true);
  assert.strictEqual(done.handoff.assigned_by, 'Mary Topp', 'the card records who picked');
  assert.ok(done.handoff.assigned_at);
});

test('split: one batch across two salespeople by lead', async () => {
  const store = createMemoryStore({ lint });
  const [a, b] = await approvedPlannerBatch(store);
  await withApp(store, MARY, async ({ post, base }) => {
    assert.strictEqual((await post('/api/handoff/assign', { card_ids: [a], owner_id: '79905153' })).status, 200);
    assert.strictEqual((await post('/api/handoff/assign', { card_ids: [b], owner_id: '87853792' })).status, 200);
    const j = await (await fetch(base + '/api/handoff')).json();
    assert.match(j.batches[0].line, /^Assigned to Cameron Creasy and Danielle Makram$/);
  });
  const hs = fakeHubSpot({ owners: OWNERS });
  await handoff({ store, fetchImpl: hs.fetchImpl, secrets: () => null, env: SANDBOX, log: () => {} });
  assert.deepStrictEqual(hs.writes.filter((w) => w.kind === 'task').map((t) => t.body.properties.hubspot_owner_id).sort(), ['79905153', '87853792']);
});

test('send-back returns the lead to Katherine with Mary\'s note; it can no longer be assigned until re-approved', async () => {
  const store = createMemoryStore({ lint });
  const ids = await approvedPlannerBatch(store);
  await withApp(store, MARY, async ({ post, base }) => {
    assert.strictEqual((await post('/api/handoff/send-back', { card_ids: [ids[0]], note: '' })).status, 400, 'a note is required');
    assert.strictEqual((await post('/api/handoff/send-back', { card_ids: [ids[0]], note: 'Wrong city for us' })).status, 200);
    assert.strictEqual((await post('/api/handoff/assign', { card_ids: [ids[0]], owner_id: '79905153' })).status, 409);
    // Katherine sees it on Review as a draft, with the status line.
    const cards = (await (await fetch(base + '/api/review/cards?status=draft')).json()).cards;
    const c = cards.find((x) => x.id === ids[0]);
    assert.strictEqual(c.mary.state, 'sent_back');
    assert.match(c.mary.line, /^Sent back to Katherine by Mary Topp, .*: Wrong city for us$/);
    const ready = (await (await fetch(base + '/api/review/cards?status=ready')).json()).cards;
    assert.strictEqual(ready.find((x) => x.id === ids[1]).mary.line, 'Waiting on Mary to pick a salesperson',
      'the #3012 "No salesperson set yet" line is now this');
  });
  // Re-approved: it waits on Mary again.
  await store.decide(ids[0], { action: 'approve', who: KATHERINE.email });
  assert.strictEqual(desk.leadState(await store.get(ids[0])).state, 'waiting');
  const hs = fakeHubSpot({ owners: OWNERS });
  await handoff({ store, fetchImpl: hs.fetchImpl, secrets: () => null, env: SANDBOX, log: () => {} });
  assert.strictEqual(hs.calls.length, 0);
});

test('the dropdown is the live roster with ids: no owner id = listed, not pickable, says why', () => {
  const by = Object.fromEntries(ROSTER.map((p) => [p.name, p]));
  assert.strictEqual(by['Cameron Creasy'].pickable, true);
  assert.strictEqual(by['Cameron Creasy'].owner_id, '79905153');
  assert.strictEqual(by['Cameron Creasy'].title, 'Venue Sales Director');
  assert.strictEqual(by['Danielle Makram'].owner_id, '87853792');
  assert.strictEqual(by['Marissa Moore'].pickable, false, 'a same-name owner with another email is not a match');
  assert.strictEqual(by['Marissa Moore'].owner_id, null);
  assert.strictEqual(by['Marissa Moore'].title, 'Venue Sales Specialist');
  assert.match(by['Marissa Moore'].why, /no active HubSpot owner has the email mmoore@/);
  assert.strictEqual(by['Megan Hogan'].pickable, false);
  assert.strictEqual(by['Katie Bradley'].pickable, false);
  assert.match(by['Katie Bradley'].why, /not active/);
  assert.ok(!by['Mary Topp'], 'Mary picks; she is never a pick');
  // Fails closed: with no owner list, nobody is pickable and each says why.
  const closed = roster.buildRoster({ people: PEOPLE, owners: null, ownersWhy: 'The HubSpot hand-off is off' });
  assert.ok(closed.length && closed.every((p) => !p.pickable && /hand-off is off|not active/.test(p.why)));
});

test('assign refuses free text, an id not on the list, an unpickable person, and anyone but Mary or an exec', async () => {
  const store = createMemoryStore({ lint });
  const ids = await approvedPlannerBatch(store);
  await withApp(store, MARY, async ({ post }) => {
    assert.strictEqual((await post('/api/handoff/assign', { card_ids: ids, owner_id: 'Cameron Creasy' })).status, 400);
    assert.strictEqual((await post('/api/handoff/assign', { card_ids: ids, owner_id: '123' })).status, 400);
    const kb = await post('/api/handoff/assign', { card_ids: ids, owner_id: '88308673' });
    assert.strictEqual(kb.status, 400);
    assert.match((await kb.json()).error, /^Katie Bradley cannot be picked: /);
  });
  await withApp(store, KATHERINE, async ({ post, base }) => {
    assert.strictEqual((await post('/api/handoff/assign', { card_ids: ids, owner_id: '79905153' })).status, 403);
    const j = await (await fetch(base + '/api/handoff')).json();
    assert.strictEqual(j.can_pick, false, 'Katherine sees the status, Mary picks');
    assert.strictEqual(j.batches[0].state, 'waiting');
  });
  await withApp(store, { email: 'mimi@infinityhospitality.net', name: 'Mimi Beaver' }, async ({ post }) => {
    assert.strictEqual((await post('/api/handoff/assign', { card_ids: [ids[0]], owner_id: '79905153' })).status, 200, 'an exec may pick too');
  });
  assert.ok(!(await store.get(ids[1])).assignment);
});

test('Mary\'s seat: a login to /handoff and a read-only Review, nothing else', async () => {
  assert.strictEqual(access.seatOf({ active: true, rung: 1, person_id: desk.MARY_PERSON_ID }), 'handoff');
  assert.strictEqual(access.seatOf({ active: false, rung: 1, person_id: desk.MARY_PERSON_ID }), null);
  assert.strictEqual(access.seatOf({ active: true, rung: 3, person_id: 'x' }), 'full');
  assert.strictEqual(access.seatOf({ active: true, rung: 1, person_id: 'someone' }), null);
  assert.ok(access.handoffSeatMay('GET', '/handoff'));
  assert.ok(access.handoffSeatMay('POST', '/api/handoff/assign'));
  assert.ok(access.handoffSeatMay('GET', '/api/review/cards'));
  assert.ok(!access.handoffSeatMay('POST', '/api/review/cards/1'), 'Review is read only for the seat');
  for (const p of ['/api/spend', '/', '/index.html', '/agents', '/api/agents', '/api/hubspot/search']) assert.ok(!access.handoffSeatMay('GET', p), p);

  // The real gate, with a real seat session.
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'zz-test-secret';
  try {
    const tok = jwt.sign({ role: 'sso', email: MARY.email, name: MARY.name, mkt_access: false, mkt_seat: 'handoff' }, 'zz-test-secret');
    const app = express();
    app.use(pageGate);
    app.get('*', (req, res) => res.json({ reached: req.path, who: req.mktUser && req.mktUser.email }));
    const srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = (p) => fetch(base + p, { headers: { Authorization: `Bearer ${tok}` }, redirect: 'manual' });
    try {
      const ok = await get('/api/handoff');
      assert.strictEqual(ok.status, 200);
      assert.strictEqual((await ok.json()).who, MARY.email);
      assert.strictEqual((await get('/api/spend')).status, 403);
      assert.strictEqual((await get('/')).status, 403);
      assert.strictEqual((await get('/agents')).status, 403);
    } finally { srv.close(); }
  } finally { if (prev === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prev; }
});

test('HANDOFF_VIA_MARY=off puts the #3012 path back exactly; the desk refuses to assign', async () => {
  assert.strictEqual(desk.on({}), true, 'shipped ON, as Mimi ruled');
  assert.strictEqual(desk.on({ HANDOFF_VIA_MARY: 'off' }), false);
  const store = createMemoryStore({ lint });
  const ids = await approvedPlannerBatch(store);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.mktUser = MARY; next(); });
  app.use(createHandoffRouter({ store, identity: IDENTITY, roster: async () => ({ people: ROSTER }), env: { HANDOFF_VIA_MARY: 'off' } }));
  const srv = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/handoff/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_ids: ids, owner_id: '79905153' }) });
    assert.strictEqual(r.status, 409);
  } finally { srv.close(); }
});

test('Mary\'s morning line counts the batches waiting, and is empty when none are', () => {
  assert.strictEqual(desk.waitingLine([{ state: 'waiting' }, { state: 'waiting' }, { state: 'assigned' }]), '2 batches waiting for a salesperson on the Sales Hand-off desk');
  assert.strictEqual(desk.waitingLine([{ state: 'assigned' }]), null);
});

test('no new HubSpot write: the desk files name no HubSpot host and no write method', () => {
  const fs = require('fs'); const path = require('path');
  for (const f of ['lib/mary-desk.js', 'routes/handoff.js', 'lib/sales-roster.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/api\.hubapi\.com/.test(src), `${f} calls HubSpot directly`);
    assert.ok(!/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(src), `${f} writes`);
  }
});
