// ORDER #3245: the Sales Hand-off salesperson list must not depend on the
// HubSpot WRITE switch (CONVENTION_TO_HUBSPOT). Reading owners is a read.
// Fixtures and fakes only: nothing here reaches HubSpot, Dispatch or the web.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const desk = require('../lib/mary-desk');
const roster = require('../lib/sales-roster');
const ownerDirectory = require('../lib/owner-directory');
const { createMemoryStore } = require('../lib/agent-store');
const { createHandoffRouter } = require('../routes/handoff');
const { handoff } = require('../jobs/agent_handoff');
const { lint } = require('../lib/ai-tells');

const MARY = { email: 'mtopp@infinityhospitality.net', name: 'Mary Topp' };
const KATHERINE = { email: 'khowe@infinityhospitality.net', name: 'Katherine Howe' };
const MIMI = { email: 'mimi@infinityhospitality.net', name: 'Mimi' };
const IDENTITY = { lookup: async (e) => ({
  [MARY.email]: { active: true, rung: 1, person_id: desk.MARY_PERSON_ID },
  [MIMI.email]: { active: true, rung: 3, person_id: 'p_mimi' },
}[e] || { active: false }) };

const PEOPLE = [
  { person_id: 'p_cam', name: 'Cameron Creasy', job_subrole: 'Venue Sales Director', primary_email: 'ccreasy@infinityhospitality.net' },
  { person_id: 'p_cas', name: 'Cassidy Wind', job_subrole: 'Venue Sales Specialist', primary_email: 'cwind@infinityhospitality.net' },
  { person_id: 'p_dan', name: 'Danielle Makram', job_subrole: 'Catering Sales Director', primary_email: 'danielle@dreameventsandcatering.com' },
  { person_id: 'p_kat', name: 'Katie Bradley', job_subrole: 'Venue Sales Specialist', primary_email: 'kbradley@infinityhospitality.net' },
  { person_id: desk.MARY_PERSON_ID, name: 'Mary Topp', primary_email: MARY.email },
];
const PROD_OWNERS = [
  { id: '79905153', firstName: 'Cameron', lastName: 'Creasy', email: 'ccreasy@infinityhospitality.net' },
  { id: '87408659', firstName: 'Cassidy', lastName: 'Wind', email: 'cwind@infinityhospitality.net' },
  { id: '87853792', firstName: 'Danielle', lastName: 'Makram', email: 'danielle@dreameventsandcatering.com' },
  { id: '88308673', firstName: 'Katie', lastName: 'Bradley', email: 'kbradley@infinityhospitality.net' },
];

// One fake network: Dispatch's roster bridge plus HubSpot. Records every call.
function fakeNet({ ownersStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET';
    calls.push({ host: u.host, method, path: u.pathname, auth: (opts.headers || {}).Authorization });
    const res = (status, j) => ({ ok: status < 300, status, json: async () => j });
    if (u.pathname === '/api/brain/portal/roster') return res(200, { people: PEOPLE });
    if (u.host === 'api.hubapi.com' && u.pathname === '/crm/v3/owners' && method === 'GET') return ownersStatus === 200 ? res(200, { results: PROD_OWNERS }) : res(ownersStatus, {});
    throw new Error(`unexpected call ${method} ${u.host}${u.pathname}`);
  };
  return { fetchImpl, calls, hubspotNonGet: () => calls.filter((c) => c.host === 'api.hubapi.com' && c.method !== 'GET') };
}

// The write switch is UNSET in every env below: the shipped, #3166 state.
const ENV = { DISPATCH_BRIDGE_TOKEN: 'zz-bridge', DISPATCH_BRIDGE_URL: 'https://dispatch.zz-test', HUBSPOT_TOKEN: 'zz-read-token' };

async function approvedBatch(store) {
  const ids = [];
  for (const co of ['ZZ_TEST Peach Events', 'ZZ_TEST Magnolia Planning']) {
    const row = await store.insert({ agent: 'planner-scout', agent_name: 'National Planner Scout', job: 'planners', target: 'Atlanta', run_id: 9,
      title: `${co}, Atlanta`, body: 'Published in Atlanta society coverage for galas.',
      payload: { sales: { company: co, website: 'https://zz-test.example', subject: 'Galas in Nashville', email: 'Hello, we host galas in Nashville.' } } });
    const out = await store.decide(row.id, { action: 'approve', who: KATHERINE.email, reason: 'Gala fit' });
    assert.ok(!out.error, out.error);
    ids.push(row.id);
  }
  return ids;
}

async function withApp({ store, who, env, net }, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.mktUser = who; next(); });
  app.use(createHandoffRouter({ store, identity: IDENTITY, env, roster: roster.createRosterReader({ env, fetchImpl: net.fetchImpl, secrets: () => null }) }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn(base); } finally { srv.close(); }
}

test('switch unset: the dropdown lists the sales staff with prod owner ids, read with GET only', async () => {
  const net = fakeNet();
  const r = await roster.createRosterReader({ env: ENV, fetchImpl: net.fetchImpl, secrets: () => null })();
  const by = Object.fromEntries(r.people.map((p) => [p.name, p]));
  assert.strictEqual(by['Cameron Creasy'].owner_id, '79905153');
  assert.ok(by['Cameron Creasy'].pickable && by['Cassidy Wind'].pickable && by['Danielle Makram'].pickable);
  assert.strictEqual(by['Cameron Creasy'].title, 'Venue Sales Director');
  assert.strictEqual(by['Danielle Makram'].title, 'Catering Sales Director');
  // Inactive people are shown but not pickable.
  assert.ok(by['Katie Bradley'] && !by['Katie Bradley'].pickable && /not active/.test(by['Katie Bradley'].why));
  assert.ok(!by['Mary Topp'], 'Mary picks; she is never a pick');
  assert.strictEqual(r.where, 'prod (read only)');
  const hs = net.calls.filter((c) => c.host === 'api.hubapi.com');
  assert.ok(hs.length >= 1 && hs.every((c) => c.method === 'GET' && c.path === '/crm/v3/owners' && c.auth === 'Bearer zz-read-token'));
  assert.ok(!r.people.some((p) => /hand-off is off/i.test(p.why || '')));
});

test('switch unset and no HUBSPOT_TOKEN (or the read fails): the Owner_Directory snapshot still gives ids, zero HubSpot calls when no token', async () => {
  const net = fakeNet();
  const { HUBSPOT_TOKEN, ...noTok } = ENV;
  const r = await roster.createRosterReader({ env: noTok, fetchImpl: net.fetchImpl, secrets: () => null })();
  const cam = r.people.find((p) => p.name === 'Cameron Creasy');
  assert.ok(cam.pickable && cam.owner_id === '79905153');
  assert.strictEqual(r.where, 'owner directory');
  assert.match(r.why, /Owner_Directory snapshot/);
  assert.strictEqual(net.calls.filter((c) => c.host === 'api.hubapi.com').length, 0);

  const failing = fakeNet({ ownersStatus: 403 });
  const r2 = await roster.createRosterReader({ env: ENV, fetchImpl: failing.fetchImpl, secrets: () => null })();
  assert.ok(r2.people.find((p) => p.name === 'Cassidy Wind').pickable);
  assert.match(r2.why, /HubSpot owners answered 403/);
  // Every id in the snapshot is a prod owner id from Owner_Directory, numeric.
  assert.ok(ownerDirectory.owners().every((o) => /^\d+$/.test(o.id) && /@(infinityhospitality\.net|dreameventsandcatering\.com)$/.test(o.email)));
});

test('switch unset: Mary assigns a batch, the CSV carries the owner, and zero non-GET calls go to api.hubapi.com', async () => {
  const store = createMemoryStore({ lint });
  const ids = await approvedBatch(store);
  const net = fakeNet();
  await withApp({ store, who: MARY, env: ENV, net }, async (base) => {
    const page = await (await fetch(`${base}/api/handoff`)).json();
    assert.ok(page.roster.some((p) => p.name === 'Cameron Creasy' && p.pickable));
    assert.strictEqual(page.admin_note, null, 'Mary never sees the plumbing note');
    assert.ok(!JSON.stringify(page).includes('hand-off is off'));
    const a = await fetch(`${base}/api/handoff/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_ids: ids, owner_id: '79905153' }) });
    assert.strictEqual(a.status, 200);
    const aj = await a.json();
    assert.deepStrictEqual(aj.assigned_to, { name: 'Cameron Creasy', owner_id: '79905153' });
    assert.ok(aj.results.every((x) => x.ok));
    const csv = await fetch(`${base}/api/handoff/import.csv?batch=run-9`);
    assert.strictEqual(csv.status, 200);
    const text = await csv.text();
    const [head, ...rows] = text.trim().split(/\r?\n/);
    const col = head.split(',').indexOf('Contact owner');
    assert.ok(col >= 0);
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every((l) => l.includes('ccreasy@infinityhospitality.net')));
  });
  // The Box's hand-off job, with the switch unset, leaves the assigned cards alone.
  const logs = [];
  await handoff({ store, fetchImpl: net.fetchImpl, secrets: () => null, env: ENV, log: (l) => logs.push(l) });
  assert.ok(logs.some((l) => /Sales hand-off is off/.test(l)));
  assert.deepStrictEqual(net.hubspotNonGet(), [], 'no HubSpot write of any kind');
});

test('the admin note goes to an exec only', async () => {
  const store = createMemoryStore({ lint });
  await approvedBatch(store);
  const { HUBSPOT_TOKEN, ...noTok } = ENV;
  await withApp({ store, who: MIMI, env: noTok, net: fakeNet() }, async (base) => {
    const page = await (await fetch(`${base}/api/handoff`)).json();
    assert.match(page.admin_note, /Owner_Directory snapshot/);
  });
  await withApp({ store, who: MARY, env: noTok, net: fakeNet() }, async (base) => {
    const page = await (await fetch(`${base}/api/handoff`)).json();
    assert.strictEqual(page.admin_note, null);
    assert.strictEqual(page.roster_where, null);
  });
});

test('the page no longer shows the write-switch message to anyone', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'handoff.html'), 'utf8');
  assert.ok(!/roster_note/.test(src));
  assert.ok(!/CONVENTION_TO_HUBSPOT/.test(src));
  const lib = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'sales-roster.js'), 'utf8');
  assert.ok(!/hand-off is off/.test(lib));
});
