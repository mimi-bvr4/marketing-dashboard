// ORDER #3344: when Mary Topp assigns a Convention Charles lead on /handoff,
// the hand-off also creates (or finds) ONE HubSpot contact for the named person
// on the card, owned by Mary's pick, with Mary's five Convention properties,
// and sets "Convention Prospect" = true LAST.
// Fakes only: nothing here reaches HubSpot or the web.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const cc = require('../lib/hubspot-convention-contact');
const desk = require('../lib/mary-desk');
const { handoff } = require('../jobs/agent_handoff');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const SANDBOX = { CONVENTION_TO_HUBSPOT: 'on', HUBSPOT_SANDBOX_TOKEN: 'ZZ_TEST_SANDBOX', CONVENTION_CONTACT_ON_ASSIGN: 'on' };
const KATHERINE = { email: 'khowe@infinityhospitality.net', name: 'Katherine Howe' };
const MARY = { email: 'mtopp@infinityhospitality.net', name: 'Mary Topp' };
const PICK = { owner_id: '79905153', name: 'Cameron Creasy', email: 'ccreasy@infinityhospitality.net' };
const OWNERS = [{ id: '79905153', firstName: 'Cameron', lastName: 'Creasy', email: PICK.email }];

// Mary's five labels, as she is creating them. Internal names are deliberately
// NOT the obvious snake_case, to prove nothing is guessed from the label.
const PROPS = [
  { name: 'zz_conv_prospect_x1', label: 'Convention Prospect', type: 'bool' },
  { name: 'zz_conv_name_x2', label: 'Convention Name', type: 'string' },
  { name: 'zz_conv_start_x3', label: 'Convention Start Date', type: 'date' },
  { name: 'zz_conv_end_x4', label: 'Convention End Date', type: 'date' },
  { name: 'zz_conv_summary_x5', label: 'Convention Research Summary', type: 'string' },
  { name: 'firstname', label: 'First Name', type: 'string' },
];

function fakeHubSpot({ portalId = 51163869, props = PROPS, existing = null, failFlag = false } = {}) {
  const calls = []; const contacts = existing ? [existing] : [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET'; const body = opts.body ? JSON.parse(opts.body) : null;
    const auth = (opts.headers || {}).Authorization;
    calls.push({ method, path: u.pathname, body, auth });
    const res = (status, j) => ({ ok: status < 300, status, json: async () => j });
    if (u.host !== 'api.hubapi.com') throw new Error(`unexpected host ${u.host}`);
    if (u.pathname === '/account-info/v3/details') return res(200, { portalId });
    if (u.pathname === '/crm/v3/owners') return res(200, { results: OWNERS });
    if (u.pathname === '/crm/v3/objects/companies/search') return res(200, { results: [] });
    if (u.pathname === '/crm/v3/objects/companies' && method === 'POST') return res(201, { id: '7001' });
    if (u.pathname === '/crm/v3/objects/tasks' && method === 'POST') return res(201, { id: '8001' });
    if (u.pathname === '/crm/v3/properties/contacts' && method === 'GET') return res(200, { results: props });
    if (u.pathname === '/crm/v3/objects/contacts/search' && method === 'POST') {
      const want = body.filterGroups[0].filters[0].value;
      return res(200, { results: contacts.filter((c) => c.properties.email === want) });
    }
    if (u.pathname === '/crm/v3/objects/contacts' && method === 'POST') {
      const c = { id: String(9000 + contacts.length + 1), properties: { ...body.properties } };
      contacts.push(c); return res(201, c);
    }
    const m = u.pathname.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/);
    if (m && method === 'PATCH') {
      if (failFlag && Object.prototype.hasOwnProperty.call(body.properties, 'zz_conv_prospect_x1')) return res(500, {});
      const c = contacts.find((x) => x.id === m[1]); Object.assign(c.properties, body.properties); return res(200, c);
    }
    if (/^\/crm\/v4\/objects\/contact\/\d+\/associations\/default\/company\/\d+$/.test(u.pathname) && method === 'PUT') return res(200, {});
    throw new Error(`unexpected HubSpot call ${method} ${u.pathname}`);
  };
  return { fetchImpl, calls, contacts };
}

const PERSON = { first_name: 'Ann', last_name: 'Lee', contact_email: 'ann.lee@zz-test.example', contact_page: 'https://zz-test.example/team',
  convention_name: 'ZZ_TEST Nashville Expo', convention_start: '2027-04-12', convention_end: '2027-04-15' };

async function approvedCard(store, sales = {}) {
  const row = await store.insert({ agent: 'convention-connector', agent_name: 'Convention Charles', job: 'conventions', target: 'Nashville', run_id: 11,
    title: 'ZZ_TEST Expo Services, ZZ_TEST Nashville Expo',
    body: 'ZZ_TEST Expo Services is the official general contractor for the ZZ_TEST Nashville Expo at Music City Center.\n\nThey book offsite receptions for exhibitors.\n\n### Sources\n- zz-test.example',
    sources: [{ label: 'ZZ_TEST page', url: 'https://zz-test.example/team', ok: true }],
    payload: { sales: { company: 'ZZ_TEST Expo Services', website: 'https://zz-test.example', subject: 'Receptions in Nashville', email: 'Hello, we host receptions in Nashville.', ...sales } } });
  const out = await store.decide(row.id, { action: 'approve', who: KATHERINE.email, reason: 'good fit' });
  assert.ok(!out.error, out.error);
  return row.id;
}
const assign = (store, id) => store.assignCard(id, desk.assignRecord(PICK, MARY, '2026-11-13T20:00:00Z'));
const run = (store, hs, env = SANDBOX) => handoff({ store, fetchImpl: hs.fetchImpl, env, log: () => {}, secrets: () => null });
const contactWrites = (hs) => hs.calls.filter((c) => /\/objects\/contacts|\/objects\/contact\//.test(c.path) && c.method !== 'GET' && !c.path.endsWith('/search'));
const leadOf = async (store, id) => desk.batches(await store.handoffDesk())[0].leads.find((l) => l.card_id === id);

test('the switch ships OFF', () => {
  assert.strictEqual(cc.on({}), false);
  assert.strictEqual(cc.on({ CONVENTION_CONTACT_ON_ASSIGN: 'on' }), true);
  assert.strictEqual(cc.FLAG, 'CONVENTION_CONTACT_ON_ASSIGN');
});

test('no assign means no write: an approved card Mary has not assigned makes no contact', async () => {
  const store = createMemoryStore({ lint }); const hs = fakeHubSpot();
  await approvedCard(store, PERSON);
  await run(store, hs);
  assert.strictEqual(hs.calls.length, 0);
});

test('on assign: one contact, owner = Mary\'s pick, five properties by resolved internal name, company associated', async () => {
  const store = createMemoryStore({ lint }); const hs = fakeHubSpot();
  const id = await approvedCard(store, PERSON); assert.ok(await assign(store, id));
  await run(store, hs);
  assert.strictEqual(hs.contacts.length, 1);
  const p = hs.contacts[0].properties;
  assert.strictEqual(p.email, 'ann.lee@zz-test.example');
  assert.strictEqual(p.firstname, 'Ann'); assert.strictEqual(p.lastname, 'Lee');
  assert.strictEqual(p.hubspot_owner_id, '79905153');
  assert.strictEqual(p.zz_conv_name_x2, 'ZZ_TEST Nashville Expo');
  assert.strictEqual(p.zz_conv_start_x3, '2027-04-12');
  assert.strictEqual(p.zz_conv_end_x4, '2027-04-15');
  assert.match(p.zz_conv_summary_x5, /official general contractor/);
  assert.strictEqual(p.zz_conv_prospect_x1, 'true');
  const create = hs.calls.find((c) => c.method === 'POST' && c.path === '/crm/v3/objects/contacts');
  assert.deepStrictEqual(create.body.associations[0].to, { id: '7001' });
  // Nothing beyond name, email, owner and the five properties.
  assert.deepStrictEqual(Object.keys(create.body.properties).sort(),
    ['email', 'firstname', 'hubspot_owner_id', 'lastname', 'zz_conv_end_x4', 'zz_conv_name_x2', 'zz_conv_start_x3', 'zz_conv_summary_x5'].sort());
  const lead = await leadOf(store, id);
  assert.match(lead.handoff.contact_line, /^HubSpot contact 9001 made for Ann Lee, owner Cameron Creasy, Convention Prospect set/);
});

test('Convention Prospect is written LAST, in its own write, after every other field', async () => {
  const store = createMemoryStore({ lint }); const hs = fakeHubSpot();
  const id = await approvedCard(store, PERSON); await assign(store, id);
  await run(store, hs);
  const w = contactWrites(hs);
  const last = w[w.length - 1];
  assert.strictEqual(last.method, 'PATCH');
  assert.deepStrictEqual(Object.keys(last.body.properties), ['zz_conv_prospect_x1']);
  for (const x of w.slice(0, -1)) assert.ok(!x.body || !x.body.properties || !('zz_conv_prospect_x1' in x.body.properties));
});

test('a missing email means no contact, and a loud line on the card', async () => {
  const store = createMemoryStore({ lint }); const hs = fakeHubSpot();
  const id = await approvedCard(store, { convention_name: 'ZZ_TEST Nashville Expo' }); await assign(store, id);
  await run(store, hs);
  assert.strictEqual(contactWrites(hs).length, 0);
  assert.strictEqual(hs.calls.filter((c) => c.path.startsWith('/crm/v3/objects/contacts')).length, 0);
  const lead = await leadOf(store, id);
  assert.match(lead.handoff.contact_line, /NO CONTACT MADE/);
  assert.match(lead.handoff.contact_line, /no named person with a work email/);
});

test('a malformed or pattern-like email is never used', () => {
  assert.ok(cc.personOf({ first_name: 'Ann', contact_email: 'not an email' }).skip);
  assert.ok(cc.personOf({ first_name: 'Ann', last_name: 'Lee', contact_email: 'ann@zz-test.example' }).skip, 'no contact_page link: not used');
  assert.ok(cc.personOf({ contact_email: 'ann@zz-test.example', contact_page: 'https://zz-test.example/team' }).skip, 'no name: not used');
  assert.ok(cc.personOf(PERSON).ok);
});

test('an unresolved property label blocks every contact write', async () => {
  const store = createMemoryStore({ lint }); const hs = fakeHubSpot({ props: PROPS.filter((p) => p.label !== 'Convention End Date') });
  const id = await approvedCard(store, PERSON); await assign(store, id);
  await run(store, hs);
  assert.strictEqual(contactWrites(hs).length, 0);
  const lead = await leadOf(store, id);
  assert.match(lead.handoff.contact_line, /UNVERIFIED.*Convention End Date/);
});

test('a label that matches only loosely (case, spacing) is not a match', async () => {
  const hs = fakeHubSpot({ props: PROPS.map((p) => (p.label === 'Convention Name' ? { ...p, label: 'convention name ' } : p)) });
  const r = await cc.resolveProperties({ fetchImpl: hs.fetchImpl, token: 'T' });
  assert.ok(r.blocked); assert.deepStrictEqual(r.missing, ['Convention Name']);
});

test('a double assign and a re-run make one contact and never re-flip the flag', async () => {
  const store = createMemoryStore({ lint }); const hs = fakeHubSpot();
  const id = await approvedCard(store, PERSON);
  assert.ok(await assign(store, id));
  assert.ok(!(await assign(store, id)), 'the second assign is refused');
  await run(store, hs); await run(store, hs);
  assert.strictEqual(hs.contacts.length, 1);
  const flips = hs.calls.filter((c) => c.method === 'PATCH' && c.body && 'zz_conv_prospect_x1' in c.body.properties);
  assert.strictEqual(flips.length, 1);
});

test('a contact that already exists by exact email is updated, not duplicated; an existing owner is kept; a set flag is not re-flipped', async () => {
  const existing = { id: '4242', properties: { email: 'ann.lee@zz-test.example', hubspot_owner_id: '111', zz_conv_prospect_x1: 'true' } };
  const store = createMemoryStore({ lint }); const hs = fakeHubSpot({ existing });
  const id = await approvedCard(store, PERSON); await assign(store, id);
  await run(store, hs);
  assert.strictEqual(hs.contacts.length, 1);
  assert.strictEqual(hs.calls.filter((c) => c.method === 'POST' && c.path === '/crm/v3/objects/contacts').length, 0);
  assert.strictEqual(hs.contacts[0].properties.hubspot_owner_id, '111');
  assert.strictEqual(hs.contacts[0].properties.zz_conv_name_x2, 'ZZ_TEST Nashville Expo');
  assert.strictEqual(hs.calls.filter((c) => c.method === 'PATCH' && 'zz_conv_prospect_x1' in c.body.properties).length, 0);
});

test('a failed flag write leaves the contact un-enrolled and raises an ALARM line, not a retry', async () => {
  const store = createMemoryStore({ lint }); const hs = fakeHubSpot({ failFlag: true });
  const id = await approvedCard(store, PERSON); await assign(store, id);
  await run(store, hs);
  assert.notStrictEqual(hs.contacts[0].properties.zz_conv_prospect_x1, 'true');
  const lead = await leadOf(store, id);
  assert.match(lead.handoff.contact_line, /ALARM/);
});

test('contact switch OFF: the #2940 task still goes, and no contact call is made', async () => {
  const store = createMemoryStore({ lint }); const hs = fakeHubSpot();
  const id = await approvedCard(store, PERSON); await assign(store, id);
  await run(store, hs, { CONVENTION_TO_HUBSPOT: 'on', HUBSPOT_SANDBOX_TOKEN: 'ZZ_TEST_SANDBOX' });
  assert.strictEqual(hs.calls.filter((c) => c.method === 'POST' && c.path === '/crm/v3/objects/tasks').length, 1);
  assert.strictEqual(hs.calls.filter((c) => /contact/.test(c.path)).length, 0);
});

test('PROD switch OFF: zero prod writes (network mocked), whatever else is on', async () => {
  for (const env of [
    { CONVENTION_CONTACT_ON_ASSIGN: 'on', HUBSPOT_TOKEN: 'ZZ_PROD' },
    { ...SANDBOX, HUBSPOT_TOKEN: 'ZZ_PROD' },
  ]) {
    const store = createMemoryStore({ lint }); const hs = fakeHubSpot();
    const id = await approvedCard(store, PERSON); await assign(store, id);
    await run(store, hs, env);
    assert.strictEqual(hs.calls.filter((c) => c.auth === 'Bearer ZZ_PROD').length, 0);
    for (const c of hs.calls) assert.notStrictEqual(c.auth, 'Bearer ZZ_PROD');
  }
});

test('the Research Summary is the approved card text only: no em dash, no dollar figure, no capacity number, HTML escaped', () => {
  const html = cc.researchSummary({ body: 'ZZ_TEST <Co> runs the expo — a big one.\n\nBudget $25,000 and holds 3,000 guests.\n\n### Sources\n- x', payload: { sales: {} } });
  assert.ok(!/—/.test(html));
  assert.ok(!/\$\s?\d/.test(html));
  assert.ok(!/3,000 guests/.test(html));
  assert.ok(!/Sources/.test(html), 'the runner\'s source section is not part of the summary');
  assert.match(html, /&lt;Co&gt;/);
  assert.match(html, /^<p>/);
});
