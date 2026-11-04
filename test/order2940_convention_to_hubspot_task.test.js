// ORDER #2940 (#2904 step 2, Mimi 11.04.2026 "A + Y"): an approved Convention
// Connector card becomes ONE HubSpot task for Cameron Creasy, sandbox 51163869
// first, behind switches that ship OFF. Fake HubSpot and memory store only:
// nothing in this file reaches a real portal.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { handoff } = require('../jobs/agent_handoff');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const st = require('../lib/hubspot-sales-task');
const { parseCards, salesFieldsOn, SALES_CONTRACT } = require('../lib/agent-runner');

const KATHERINE = 'khowe@infinityhospitality.net';
const EMAIL = 'Hi Acme team,\n\nYour attendees arrive in Nashville on 03.10.2027. The Bell Tower is a short ride from Music City Center.\n\nWould a reception there help?';
const SALES = { company: 'ZZ_TEST Acme Meetings', website: 'https://www.zztest-acme.example/contact', subject: 'A reception near Music City Center', email: EMAIL };
const SANDBOX_ON = { CONVENTION_TO_HUBSPOT: 'on', HUBSPOT_SANDBOX_TOKEN: 'sandbox-test-token' };
const silentLog = () => {};
// Every hand-off below gets a fake Keychain, so no test reads the real one.
const silent = silentLog;
const run = (o) => handoff({ ...o, secrets: () => null });

// A fake HubSpot that records every write.
function fakeHubSpot({ portalId = 51163869, owners, companies = [], taskStatus = 201 } = {}) {
  const writes = []; const calls = [];
  const list = owners || [{ id: '900001', firstName: 'Cameron', lastName: 'Creasy', email: 'cameron@example.test' }];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET'; const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path: u.pathname, body });
    const res = (status, j) => ({ ok: status < 300, status, json: async () => j });
    if (u.pathname === '/account-info/v3/details') return res(200, { portalId });
    if (u.pathname === '/crm/v3/owners') return res(200, { results: list });
    if (u.pathname === '/crm/v3/objects/companies/search') {
      const f = body.filterGroups[0].filters[0];
      return res(200, { results: companies.filter((c) => c[f.propertyName] === f.value) });
    }
    if (u.pathname === '/crm/v3/objects/companies' && method === 'POST') { writes.push({ kind: 'company', body }); return res(201, { id: '700' + writes.length }); }
    if (u.pathname === '/crm/v3/objects/tasks' && method === 'POST') { writes.push({ kind: 'task', body }); return res(taskStatus, taskStatus < 300 ? { id: '800' + writes.length } : {}); }
    throw new Error(`unexpected HubSpot call ${method} ${u.pathname}`);
  };
  return { fetchImpl, writes, calls };
}

async function approvedCard(store, sales = SALES) {
  const row = await store.insert({ agent: 'convention-connector', agent_name: 'Convention Connector', job: 'x', title: 'ZZ_TEST: Acme Meetings, spring convention', body: 'Research and the draft.', payload: { sales } });
  const out = await store.decide(row.id, { action: 'approve', who: KATHERINE });
  assert.ok(!out.error, out.error);
  return row.id;
}

test('switches ship OFF: no switch, no target, no sales fields asked of the model', () => {
  assert.strictEqual(st.target({}, null), null);
  assert.strictEqual(salesFieldsOn({}), false);
  assert.strictEqual(st.target({ CONVENTION_TO_HUBSPOT: 'on' }, null).portal, 51163869);
  assert.strictEqual(st.target({ CONVENTION_TO_HUBSPOT_PROD: 'on' }, null).portal, 49701209);
  assert.match(st.target({ CONVENTION_TO_HUBSPOT: 'on' }, null).tokenName, /^HUBSPOT_SANDBOX_TOKEN \(or Keychain item hubspot-sandbox-token\)$/);
  // The sandbox token may come from the Box Keychain item, asked for by that name only.
  const asked = [];
  assert.strictEqual(st.target({ CONVENTION_TO_HUBSPOT: 'on' }, (n) => { asked.push(n); return 'from-keychain'; }).token, 'from-keychain');
  assert.deepStrictEqual(asked, ['hubspot-sandbox-token']);
  assert.match(SALES_CONTRACT, /"sales"/);
});

test('with the switch off an approved card is left alone and nothing reaches HubSpot', async () => {
  const store = createMemoryStore({ lint });
  const id = await approvedCard(store);
  const hs = fakeHubSpot();
  await run({ store, fetchImpl: hs.fetchImpl, env: {}, log: silent });
  assert.strictEqual(hs.calls.length, 0);
  assert.strictEqual((await store.get(id)).handoff, null);
});

test('SANDBOX: an approved ZZ_TEST card makes one task for Cameron and one company, the email word for word', async () => {
  const store = createMemoryStore({ lint });
  const id = await approvedCard(store);
  const hs = fakeHubSpot();
  const r = await run({ store, fetchImpl: hs.fetchImpl, env: SANDBOX_ON, log: silent });
  assert.strictEqual(r.done, 1);
  const tasks = hs.writes.filter((w) => w.kind === 'task'); const cos = hs.writes.filter((w) => w.kind === 'company');
  assert.strictEqual(tasks.length, 1); assert.strictEqual(cos.length, 1);
  const p = tasks[0].body.properties;
  assert.strictEqual(p.hubspot_owner_id, '900001');
  assert.ok(p.hs_task_body.includes(EMAIL.replace(/\n/g, '<br>')), 'the email rides verbatim');
  assert.match(p.hs_task_body, /Approved by khowe@infinityhospitality\.net on /);
  assert.deepStrictEqual(tasks[0].body.associations[0].to, { id: '7001' });
  assert.strictEqual(tasks[0].body.associations[0].types[0].associationTypeId, 192);
  // The company carries only the card's own fields.
  assert.deepStrictEqual(cos[0].body.properties, { name: 'ZZ_TEST Acme Meetings', domain: 'zztest-acme.example', website: SALES.website });
  const h = (await store.get(id)).handoff;
  assert.strictEqual(h.ok, true); assert.strictEqual(h.where, 'sandbox'); assert.strictEqual(h.portal, 51163869);
  assert.strictEqual(h.owner_name, 'Cameron Creasy'); assert.strictEqual(h.approved_by, KATHERINE); assert.strictEqual(h.company_created, true);
  assert.ok(!hs.calls.some((c) => /contacts/.test(c.path)), 'never a contact or person record');
});

test('a company already in HubSpot (same domain) is linked, not created again', async () => {
  const store = createMemoryStore({ lint });
  await approvedCard(store);
  const hs = fakeHubSpot({ companies: [{ id: '555', domain: 'zztest-acme.example', name: 'Acme' }] });
  await run({ store, fetchImpl: hs.fetchImpl, env: SANDBOX_ON, log: silent });
  assert.strictEqual(hs.writes.filter((w) => w.kind === 'company').length, 0);
  assert.deepStrictEqual(hs.writes.find((w) => w.kind === 'task').body.associations[0].to, { id: '555' });
});

test('a rejected card makes nothing', async () => {
  const store = createMemoryStore({ lint });
  const row = await store.insert({ agent: 'convention-connector', agent_name: 'Convention Connector', job: 'x', title: 'ZZ_TEST', body: 'x', payload: { sales: SALES } });
  await store.decide(row.id, { action: 'reject', who: KATHERINE, reason: 'not a fit' });
  const hs = fakeHubSpot();
  await run({ store, fetchImpl: hs.fetchImpl, env: SANDBOX_ON, log: silent });
  assert.strictEqual(hs.calls.length, 0);
});

test('a second approval of the same card (edit, approve again) and a second run make no duplicate', async () => {
  const store = createMemoryStore({ lint });
  const id = await approvedCard(store);
  const hs = fakeHubSpot();
  await run({ store, fetchImpl: hs.fetchImpl, env: SANDBOX_ON, log: silent });
  await store.decide(id, { action: 'edit', who: KATHERINE, body: EMAIL + '\n\nThanks!' });
  await store.decide(id, { action: 'approve', who: KATHERINE });
  await run({ store, fetchImpl: hs.fetchImpl, env: SANDBOX_ON, log: silent });
  await run({ store, fetchImpl: hs.fetchImpl, env: SANDBOX_ON, log: silent });
  assert.strictEqual(hs.writes.filter((w) => w.kind === 'task').length, 1);
  assert.strictEqual(hs.writes.filter((w) => w.kind === 'company').length, 1);
});

test('two hand-offs racing on one card: only one claim wins', async () => {
  const store = createMemoryStore({ lint });
  const id = await approvedCard(store);
  assert.strictEqual(await store.claimHandoff(id, { pending: true }), true);
  assert.strictEqual(await store.claimHandoff(id, { pending: true }), false);
});

test('KNOWN-BAD: a token for another portal writes nothing (sandbox switch, prod token)', async () => {
  const store = createMemoryStore({ lint });
  const id = await approvedCard(store);
  const hs = fakeHubSpot({ portalId: 49701209 });
  await run({ store, fetchImpl: hs.fetchImpl, env: SANDBOX_ON, log: silent });
  assert.strictEqual(hs.writes.length, 0);
  assert.match((await store.get(id)).handoff.why, /portal 49701209, not 51163869/);
});

test('no sandbox token: nothing is sent and the card waits to retry', async () => {
  const store = createMemoryStore({ lint });
  const id = await approvedCard(store);
  const hs = fakeHubSpot();
  await run({ store, fetchImpl: hs.fetchImpl, env: { CONVENTION_TO_HUBSPOT: 'on' }, log: silent });
  assert.strictEqual(hs.calls.length, 0);
  assert.strictEqual((await store.get(id)).handoff, null);
});

test('sandbox without Cameron: a named stand-in is used and marked; without one, nothing is written', async () => {
  const owners = [{ id: '42', firstName: 'Test', lastName: 'Owner', email: 't@example.test' }];
  let store = createMemoryStore({ lint }); let id = await approvedCard(store);
  let hs = fakeHubSpot({ owners });
  await run({ store, fetchImpl: hs.fetchImpl, env: SANDBOX_ON, log: silent });
  assert.strictEqual(hs.writes.length, 0);
  assert.match((await store.get(id)).handoff.why, /no stand-in/);
  store = createMemoryStore({ lint }); id = await approvedCard(store);
  hs = fakeHubSpot({ owners });
  await run({ store, fetchImpl: hs.fetchImpl, env: { ...SANDBOX_ON, CONVENTION_SANDBOX_OWNER_ID: '42' }, log: silent });
  const h = (await store.get(id)).handoff;
  assert.strictEqual(h.owner_id, '42'); assert.strictEqual(h.stand_in, true); assert.match(h.owner_name, /Test Owner \(sandbox stand-in for Cameron Creasy\)/);
});

test('PROD switch: Cameron must be owner 79905153, a stand-in is never used', async () => {
  const store = createMemoryStore({ lint });
  const id = await approvedCard(store);
  const hs = fakeHubSpot({ portalId: 49701209, owners: [{ id: '1', firstName: 'Cameron', lastName: 'Creasy' }] });
  await run({ store, fetchImpl: hs.fetchImpl, env: { CONVENTION_TO_HUBSPOT_PROD: 'on', HUBSPOT_TOKEN: 'x', CONVENTION_SANDBOX_OWNER_ID: '1' }, log: silent });
  assert.strictEqual(hs.writes.length, 0);
  assert.match((await store.get(id)).handoff.why, /not owner 79905153/);
});

test('editing a Sales card changes the email that goes to HubSpot; approve still runs the dash and code checks on it', async () => {
  const store = createMemoryStore({ lint });
  const row = await store.insert({ agent: 'convention-connector', agent_name: 'Convention Connector', job: 'x', title: 'ZZ_TEST', body: 'x', payload: { sales: SALES } });
  await store.decide(row.id, { action: 'edit', who: KATHERINE, body: 'New words for Acme.' });
  assert.strictEqual((await store.get(row.id)).payload.sales.email, 'New words for Acme.');
  await store.decide(row.id, { action: 'edit', who: KATHERINE, body: 'Tour TBB this fall — it is lovely.' });
  const out = await store.decide(row.id, { action: 'approve', who: KATHERINE });
  assert.match(out.error, /the email: em dash/);
});

test('the runner keeps a "sales" block from the model answer', () => {
  const [c] = parseCards(JSON.stringify({ cards: [{ title: 't', body: 'b', sales: { ...SALES, phone: '555' } }] }), 1);
  assert.deepStrictEqual(Object.keys(c.sales).sort(), ['company', 'email', 'subject', 'website']);
});
