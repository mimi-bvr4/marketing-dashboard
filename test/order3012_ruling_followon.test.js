// ORDER #3012: Mimi's four answers to #3000 (11.05.2026 23:36 CT), in code.
//   1. the Scout and Gala salesperson is a setting (HubSpot owner id), decided Mon 11.09.2026
//   2. the Planner Scout's first city is Atlanta
//   3. OUTREACH_MAILING_ADDRESS defaults to 345 Hill Ave, Nashville, TN 37210
//   4. Meta = read-only, ads_read, token by name; pending until it exists
// Fixtures and fakes only: nothing here reaches HubSpot, Meta or the web.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const outreach = require('../lib/outreach');
const meta = require('../lib/meta-read');
const { requestSource, metaAdsReadSource } = require('../lib/agent-sources');
const { loadAgent } = require('../lib/agent-runner');
const { handoff } = require('../jobs/agent_handoff');
const { createMemoryStore, checkSalesOwner } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const ADDR = '345 Hill Ave, Nashville, TN 37210';

function fakeHubSpot({ portalId = 51163869, owners = [] } = {}) {
  const writes = []; const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET'; const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, host: u.host, path: u.pathname, body });
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

// #3165: the per-agent owner path is the HANDOFF_VIA_MARY=off path now.
const SANDBOX = { CONVENTION_TO_HUBSPOT: 'on', HUBSPOT_SANDBOX_TOKEN: 'ZZ_TEST_TOKEN', HANDOFF_VIA_MARY: 'off' };

async function approvedScoutCards(store) {
  for (const agent of ['planner-scout', 'gala-scout']) {
    const row = await store.insert({ agent, agent_name: agent, job: 'x', title: `ZZ_TEST ${agent} card`, body: 'b',
      payload: { sales: { company: `ZZ_TEST ${agent} Co`, website: 'https://zz-test.example', subject: 'Hello', email: 'Hi.' } } });
    const out = await store.decide(row.id, { action: 'approve', who: 'khowe@infinityhospitality.net' });
    assert.ok(!out.error, out.error);
  }
}

test('mailing address: unset is the main office, exactly once in a draft footer', () => {
  assert.strictEqual(outreach.DEFAULT_ADDRESS, ADDR);
  assert.strictEqual(outreach.mailingAddress({}), ADDR);
  const d = outreach.draft({ company: 'ZZ_TEST Co', email: 'Hello there.' }, {});
  assert.strictEqual(d.email.split(ADDR).length - 1, 1, 'the address appears exactly once');
  assert.ok(!d.email.includes(outreach.NO_ADDRESS), 'the placeholder is unreachable by default');
  assert.strictEqual(outreach.withFooter(d.email, {}).split(ADDR).length - 1, 1, 'never added twice');
  // A set value wins; only an empty string reaches the placeholder.
  assert.strictEqual(outreach.mailingAddress({ OUTREACH_MAILING_ADDRESS: 'ZZ_TEST 1 Example St' }), 'ZZ_TEST 1 Example St');
  assert.ok(outreach.footer({ OUTREACH_MAILING_ADDRESS: '  ' }).includes(outreach.NO_ADDRESS));
});

test('first city: the Planner Scout defaults to Atlanta; a setting or a typed ask overrides it', async () => {
  const src = loadAgent('planner-scout').sources.find((s) => s.type === 'request');
  assert.strictEqual(src.default, 'Atlanta');
  const def = await requestSource(src, { env: {} });
  assert.ok(def.ok); assert.match(def.text, /^Target city: Atlanta$/); assert.strictEqual(def.defaulted, 'default');
  const set = await requestSource(src, { env: { [src.default_env]: 'Charlotte' } });
  assert.match(set.text, /Charlotte/); assert.strictEqual(set.defaulted, 'PLANNER_SCOUT_CITY');
  const asked = await requestSource(src, { env: { [src.default_env]: 'Charlotte' }, ask: 'Denver' });
  assert.strictEqual(asked.text, 'Denver');
  // A request source with no default still needs an ask, as before.
  assert.strictEqual((await requestSource({ type: 'request' }, { env: {} })).ok, false);
});

test('card owner: a Scout with no owner id says "No salesperson set yet" and makes zero HubSpot calls', async () => {
  const store = createMemoryStore({ lint });
  await approvedScoutCards(store);
  for (const a of ['planner-scout', 'gala-scout']) {
    assert.strictEqual(await outreach.salesOwner(a, { store }), null);
    assert.strictEqual(outreach.ownerLine(null), 'No salesperson set yet');
  }
  const hs = fakeHubSpot({ owners: [{ id: '4242', firstName: 'ZZ_TEST', lastName: 'Seller' }] });
  const logs = [];
  await handoff({ store, fetchImpl: hs.fetchImpl, secrets: () => null, env: SANDBOX, log: (l) => logs.push(l) });
  assert.strictEqual(hs.calls.length, 0, 'no HubSpot call at all');
  assert.strictEqual(logs.filter((l) => /No salesperson set yet/.test(l)).length, 2);
  for (const c of await store.list({ status: 'ready' })) assert.ok(!c.handoff, 'left unclaimed, so it goes out once the owner is set');
});

test('card owner: set by HubSpot owner id, each waiting card becomes exactly one task for that id; a second run adds none', async () => {
  const store = createMemoryStore({ lint });
  await approvedScoutCards(store);
  for (const a of ['planner-scout', 'gala-scout']) assert.ok(!(await store.setSalesOwner(a, '4242', 'mimi@infinityhospitality.net')).error);
  // A decoy with the same name and a different id: the join is by id, never by name.
  const owners = [{ id: '1111', firstName: 'ZZ_TEST', lastName: 'Seller' }, { id: '4242', firstName: 'ZZ_TEST', lastName: 'Seller' }];
  const hs = fakeHubSpot({ owners });
  await handoff({ store, fetchImpl: hs.fetchImpl, secrets: () => null, env: SANDBOX, log: () => {} });
  const tasks = hs.writes.filter((w) => w.kind === 'task');
  assert.strictEqual(tasks.length, 2);
  for (const t of tasks) assert.strictEqual(t.body.properties.hubspot_owner_id, '4242');
  assert.ok(tasks.some((t) => /^Planner lead: /.test(t.body.properties.hs_task_subject)));
  assert.ok(tasks.some((t) => /^Gala lead: /.test(t.body.properties.hs_task_subject)));
  await handoff({ store, fetchImpl: hs.fetchImpl, secrets: () => null, env: SANDBOX, log: () => {} });
  assert.strictEqual(hs.writes.filter((w) => w.kind === 'task').length, 2, 'still one task per card');
  assert.ok(hs.calls.every((c) => c.host === 'api.hubapi.com'));
});

test('card owner: an id that is not an active owner writes nothing; a name is refused as a setting', async () => {
  const store = createMemoryStore({ lint });
  await approvedScoutCards(store);
  await store.setSalesOwner('planner-scout', '4242', 'mimi@infinityhospitality.net');
  const hs = fakeHubSpot({ owners: [{ id: '4242', firstName: 'Gone', lastName: 'Person', archived: true }] });
  const logs = [];
  await handoff({ store, fetchImpl: hs.fetchImpl, secrets: () => null, env: SANDBOX, log: (l) => logs.push(l) });
  assert.strictEqual(hs.writes.length, 0);
  assert.ok(logs.some((l) => /owner 4242 is not an active owner/.test(l)));
  assert.match(checkSalesOwner('planner-scout', 'Cameron Creasy', 'mimi@x').error, /owner id/);
  assert.strictEqual(checkSalesOwner('scout', '4242', 'mimi@x').status, 404, 'only the two Scouts carry the setting');
  assert.strictEqual(checkSalesOwner('gala-scout', '', 'mimi@x').id, null, 'empty clears it');
  assert.match(checkSalesOwner('gala-scout', '4242', '').error, /no person/);
  // Convention Charles is unchanged: Cameron, by the #2940 rule.
  assert.deepStrictEqual(await outreach.salesOwner('convention-connector', { store }), { name: 'Cameron Creasy' });
  // Every change is logged with who made it.
  assert.ok(store.profileLogRows.some((r) => r.agent === 'planner-scout' && r.field === 'sales_owner' && r.new_value === '4242' && r.changed_by));
});

test('Meta read: no token means pending, audience UNVERIFIED, and nothing reaches the network', async () => {
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); throw new Error('no network expected'); };
  const r = await meta.readAdAccount({ env: { META_AD_ACCOUNT_ID: '123' }, fetchImpl, secrets: () => null });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.pending, true); assert.strictEqual(r.audience, 'UNVERIFIED');
  assert.match(r.why, /META_ADS_READ_TOKEN/);
  const s = await metaAdsReadSource({ type: 'meta_ads_read' }, { env: {}, fetch: fetchImpl, metaSecrets: () => null });
  assert.strictEqual(s.ok, false); assert.strictEqual(s.pending, true); assert.match(s.why, /pending/);
  assert.strictEqual(calls.length, 0);
  // With a token (fixture) the one call is a GET, the token rides in the header, never the URL.
  const seen = [];
  const ok = await meta.readAdAccount({ env: { META_ADS_READ_TOKEN: 'ZZ_TEST_META', META_AD_ACCOUNT_ID: '123' }, secrets: () => null,
    fetchImpl: async (u, o) => { seen.push({ u, o }); return { ok: true, status: 200, json: async () => ({ data: [] }) }; } });
  assert.ok(ok.ok);
  assert.strictEqual(seen.length, 1); assert.strictEqual(seen[0].o.method, 'GET');
  assert.ok(seen[0].u.startsWith('https://graph.facebook.com/') && seen[0].u.includes('/act_123/insights'));
  assert.ok(!seen[0].u.includes('ZZ_TEST_META'));
  assert.throws(() => meta.readUrl('123/adsets'), /not a Meta ad account read/);
});

test('Meta read: the source cannot write (no POST or DELETE anywhere near graph.facebook.com)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'meta-read.js'), 'utf8');
  assert.ok(!/['"](POST|DELETE|PUT|PATCH)['"]/i.test(src), 'meta-read.js names no write method');
  const methods = [...src.matchAll(/method\s*:\s*([^,}\s]+)/g)].map((m) => m[1]);
  assert.ok(methods.length >= 1 && methods.every((m) => m === "'GET'"), `every method is the literal GET: ${methods}`);
  for (const k of Object.keys(meta)) assert.ok(!/^(post|create|update|delete|write|send)/i.test(k), `no export named ${k}`);
  // The host lives in one file only.
  for (const f of ['agent-sources.js', 'agent-runner.js', 'outreach.js']) {
    assert.ok(!/graph\.facebook\.com/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8')), `${f} does not call Meta`);
  }
  const d = loadAgent('engagement-sleuth');
  assert.ok(d.sources.some((s) => s.type === 'meta_ads_read'));
  assert.ok(!d.sources.some((s) => s.required && s.type === 'meta_ads_read'), 'pending Meta never blocks the card');
});
