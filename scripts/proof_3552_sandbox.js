#!/usr/bin/env node
// ORDER #3552: the #3344 sandbox proof. ONE ZZ_TEST convention card through
// Mary's assign, in HubSpot SANDBOX 51163869 only, read back, then deleted.
//
// Fences in code:
//   - CONVENTION_TO_HUBSPOT_PROD is forced off and HUBSPOT_TOKEN removed from
//     this process before anything loads, so the prod branch of target() is dead.
//   - Every HubSpot call goes through `guarded`, which refuses ANY call until the
//     account-info GET has answered portalId 51163869, and any host but api.hubapi.com.
//   - The token is read from the Keychain inside this process by the app's own
//     target() and is never printed; the log carries method, path, status only.
//   - The card lives in an in-memory store (scratch row), never the live DB.
//   - Cleanup runs in `finally`: deletes only objects this run created (or a
//     company whose name starts ZZ_TEST), in the sandbox only.
'use strict';

process.env.CONVENTION_TO_HUBSPOT_PROD = 'off';
delete process.env.HUBSPOT_TOKEN;
process.env.CONVENTION_TO_HUBSPOT = 'on';
process.env.CONVENTION_CONTACT_ON_ASSIGN = 'on';
process.env.HANDOFF_VIA_MARY = 'on';

const SANDBOX = 51163869;
const PROD = 49701209;
const HOST = 'https://api.hubapi.com';
const NAMES = ['convention_prospect', 'convention_name', 'convention_start_date', 'convention_end_date', 'convention_research_summary'];
const EMAIL = 'zz.test+3344@infinityhospitality.net';

const { target } = require('../lib/hubspot-sales-task');
const { handoff, createMemoryStore } = require('../jobs/agent_handoff');
const conventionContact = require('../lib/hubspot-convention-contact');
const { lint } = require('../lib/ai-tells');

const out = (...a) => console.log(...a);
const calls = [];
let guardPassed = false;

async function guarded(url, opts = {}) {
  const u = String(url);
  if (!u.startsWith(HOST + '/')) throw new Error(`REFUSED: host not api.hubapi.com (${u.slice(0, 40)})`);
  const path = u.slice(HOST.length);
  if (!guardPassed && path !== '/account-info/v3/details') throw new Error(`REFUSED before the portal guard passed: ${opts.method || 'GET'} ${path}`);
  const method = opts.method || 'GET';
  let keys = null;
  if (opts.body) { try { const b = JSON.parse(opts.body); if (b.properties) keys = Object.keys(b.properties); } catch (e) { /* not json */ } }
  const r = await fetch(u, opts);
  calls.push({ n: calls.length + 1, method, path: path.split('?')[0], status: r.status, keys });
  return r;
}

async function hs(token, method, path, body) {
  const r = await guarded(HOST + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let j = {}; try { j = text ? JSON.parse(text) : {}; } catch (e) { j = { raw: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, body: j };
}

async function main() {
  const t = target(process.env);
  if (!t || t.where !== 'sandbox' || t.portal !== SANDBOX) { out('STOP: target() did not choose the sandbox'); process.exitCode = 2; return; }
  if (!t.token) { out('STOP: no sandbox token found (Keychain item hubspot-sandbox-token)'); process.exitCode = 2; return; }
  const token = t.token;

  // STEP 1: the guard.
  const acct = await hs(token, 'GET', '/account-info/v3/details');
  out(`STEP 1 GUARD: GET /account-info/v3/details -> ${acct.status}, portalId ${acct.body.portalId}, accountType ${acct.body.accountType || '?'}`);
  if (!acct.ok || Number(acct.body.portalId) !== SANDBOX || Number(acct.body.portalId) === PROD) { out('STOP: the token is not for sandbox 51163869. Nothing else was called.'); process.exitCode = 3; return; }
  guardPassed = true;

  // STEP 2: the five properties.
  out('STEP 2 PROPERTIES:');
  const fieldTypes = {};
  for (const n of NAMES) {
    const p = await hs(token, 'GET', `/crm/v3/properties/contacts/${n}`);
    fieldTypes[n] = p.body.fieldType;
    out(`  ${n}: ${p.status} label="${p.body.label}" type=${p.body.type} fieldType=${p.body.fieldType}${p.body.archived ? ' ARCHIVED' : ''}`);
  }

  // Owners (read) for Mary's pick.
  const ow = await hs(token, 'GET', '/crm/v3/owners?limit=100');
  const owners = (ow.body.results || []).filter((o) => o.archived !== true);
  out(`OWNERS: GET /crm/v3/owners -> ${ow.status}, ${owners.length} active: ${owners.map((o) => `${o.id} ${`${o.firstName || ''} ${o.lastName || ''}`.trim()}`).join('; ')}`);
  if (!ow.ok) out(`  owners answer: category=${ow.body.category} message=${String(ow.body.message || '').slice(0, 300)} errors=${JSON.stringify(ow.body.errors || ow.body.context || null).slice(0, 300)}`);
  if (!owners.length) {
    out('READ-SCOPE PROBE (GET only, nothing written):');
    for (const o of ['contacts', 'companies', 'tasks']) { const r = await hs(token, 'GET', `/crm/v3/objects/${o}?limit=1`); out(`  GET /crm/v3/objects/${o} -> ${r.status}${r.ok ? '' : ` ${r.body.category || ''}`}`); }
    out('STOP: no active owner could be read in the sandbox, so Mary\'s assign cannot run. Nothing was written.'); process.exitCode = 4; return;
  }
  const pick = owners[0];
  const pickName = `${pick.firstName || ''} ${pick.lastName || ''}`.trim() || pick.email;

  // STEP 3: one approved ZZ_TEST card in a scratch (in-memory) store, assigned by Mary.
  const store = createMemoryStore({ lint });
  const card = await store.insert({
    agent: 'convention-connector', status: 'ready', decided_by: 'zz.test (ORDER #3552 proof)', decided_at: new Date(),
    title: 'ZZ_TEST Convention Co at ZZ_TEST Expo',
    body: 'ZZ_TEST proof card for ORDER #3552. ZZ_TEST Convention Co is exhibiting at ZZ_TEST Expo.\n\nThis paragraph is test text only and names no real company.\n\n### Sources\n- https://example.com/zz-test',
    payload: { sales: {
      company: 'ZZ_TEST Convention Co', website: 'https://zz-test-convention-3344.example.com', subject: 'ZZ_TEST subject',
      email: 'ZZ_TEST email body. Not sent; this is a sandbox proof.',
      first_name: 'ZZ', last_name: 'Test', contact_email: EMAIL, contact_page: 'https://zz-test-convention-3344.example.com/team',
      convention_name: 'ZZ_TEST Expo', convention_start: '2027-03-10', convention_end: '2027-03-12',
    } },
  });
  card.assignment = { state: 'assigned', owner_id: String(pick.id), owner_name: pickName, by: 'zz.test', by_name: 'ZZ Test (as Mary)', at: new Date().toISOString() };
  out(`STEP 3 CARD: scratch card #${card.id}, assigned to sandbox owner ${pick.id} (${pickName})`);

  const logs = [];
  const created = { contact: null, company: null, companyCreated: false, task: null };
  try {
    const firstCall = calls.length;
    const run1 = await handoff({ store, fetchImpl: guarded, env: process.env, log: (l) => logs.push(l) });
    out(`ASSIGN RUN 1: seen ${run1.seen}, done ${run1.done}`);
    logs.forEach((l) => out(`  log: ${l}`));
    const h = card.handoff || {};
    created.task = h.task_id || null; created.company = h.company_id || null; created.companyCreated = !!h.company_created;
    created.contact = (h.contact && h.contact.contact_id) || null;
    out(`  handoff record: ok=${h.ok} where=${h.where} portal=${h.portal} task=${h.task_id} company=${h.company_id} (created ${h.company_created}) owner=${h.owner_id}`);
    out(`  contact record: ${JSON.stringify(h.contact || null)}`);
    out('  CALL ORDER (run 1):');
    calls.slice(firstCall).forEach((c) => out(`    #${c.n} ${c.method} ${c.path} -> ${c.status}${c.keys ? ` props[${c.keys.join(',')}]` : ''}`));

    // STEP 4: read back.
    if (created.contact) {
      const props = ['email', 'firstname', 'lastname', 'hubspot_owner_id', ...NAMES].join(',');
      const rb = await hs(token, 'GET', `/crm/v3/objects/contacts/${created.contact}?properties=${props}&propertiesWithHistory=${NAMES.join(',')},hubspot_owner_id&associations=companies`);
      const p = rb.body.properties || {};
      out(`STEP 4 READBACK: GET contact ${created.contact} -> ${rb.status}`);
      ['email', 'firstname', 'lastname', 'hubspot_owner_id', ...NAMES].forEach((k) => out(`  ${k} = ${JSON.stringify(p[k])}`));
      const assoc = ((rb.body.associations || {}).companies || {}).results || [];
      out(`  associated companies: ${assoc.map((a) => `${a.id} (${a.type})`).join('; ') || 'none'}`);
      const hist = rb.body.propertiesWithHistory || {};
      out('  property history (newest first, timestamps from HubSpot):');
      [...NAMES, 'hubspot_owner_id'].forEach((k) => (hist[k] || []).forEach((v) => out(`    ${k}: ${JSON.stringify(String(v.value).slice(0, 60))} at ${v.timestamp} via ${v.sourceType}`)));
      const v4 = await hs(token, 'GET', `/crm/v4/objects/contact/${created.contact}/associations/company`);
      out(`  v4 associations -> ${v4.status}: ${JSON.stringify((v4.body.results || []).map((r) => ({ to: r.toObjectId, types: r.associationTypes })))}`);
    }

    // STEP 4c: a second assign makes no second contact.
    const before2 = calls.length;
    const logs2 = [];
    const run2 = await handoff({ store, fetchImpl: guarded, env: process.env, log: (l) => logs2.push(l) });
    out(`ASSIGN RUN 2 (same card, re-run): seen ${run2.seen}, done ${run2.done}, HubSpot calls ${calls.length - before2}`);
    logs2.forEach((l) => out(`  log: ${l}`));
    if (created.contact) {
      const before3 = calls.length;
      const again = await conventionContact.contactOnAssign({ card, ownerId: String(pick.id), ownerName: pickName, companyId: created.company, token, fetchImpl: guarded });
      out(`ASSIGN 2 AT THE CONTACT STEP (contactOnAssign called again directly): ${JSON.stringify(again)}`);
      calls.slice(before3).forEach((c) => out(`    #${c.n} ${c.method} ${c.path} -> ${c.status}${c.keys ? ` props[${c.keys.join(',')}]` : ''}`));
      const s = await hs(token, 'POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: EMAIL }] }], properties: ['email'], limit: 10 });
      out(`  contacts with ${EMAIL} in the sandbox: ${s.status} total=${s.body.total} ids=${(s.body.results || []).map((r) => r.id).join(',')}`);
    }

    // Workflow check (read): does any flow exist that could have fired?
    const fl = await hs(token, 'GET', '/automation/v4/flows?limit=100');
    out(`WORKFLOWS: GET /automation/v4/flows -> ${fl.status}${fl.ok ? `, ${(fl.body.results || []).length} flow(s): ${(fl.body.results || []).map((f) => `${f.id} "${f.name}" enabled=${f.isEnabled}`).join('; ') || 'none'}` : ` (${(fl.body.category || fl.body.message || '').toString().slice(0, 120)})`}`);
  } finally {
    // STEP 5: cleanup, sandbox only (guardPassed is true here; the token is the sandbox token).
    out('STEP 5 CLEANUP:');
    if (created.contact) { const d = await hs(token, 'DELETE', `/crm/v3/objects/contacts/${created.contact}`); out(`  DELETE contact ${created.contact} -> ${d.status}`); }
    if (created.task) { const d = await hs(token, 'DELETE', `/crm/v3/objects/tasks/${created.task}`); out(`  DELETE task ${created.task} -> ${d.status}`); }
    if (created.company) {
      const c = await hs(token, 'GET', `/crm/v3/objects/companies/${created.company}?properties=name`);
      const nm = String((c.body.properties || {}).name || '');
      if (created.companyCreated || nm.startsWith('ZZ_TEST')) { const d = await hs(token, 'DELETE', `/crm/v3/objects/companies/${created.company}`); out(`  DELETE company ${created.company} ("${nm}") -> ${d.status}`); }
      else out(`  company ${created.company} ("${nm}") was not made by this run and is not ZZ_TEST: left alone`);
    }
    const s = await hs(token, 'POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: EMAIL }] }], properties: ['email'], limit: 10 });
    out(`  after cleanup, contacts with ${EMAIL}: ${s.status} total=${s.body.total}`);
    const cs = await hs(token, 'POST', '/crm/v3/objects/companies/search', { filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: 'ZZ_TEST Convention Co' }] }], properties: ['name'], limit: 10 });
    out(`  after cleanup, companies named "ZZ_TEST Convention Co": ${cs.status} total=${cs.body.total}`);
    out(`TOTAL HubSpot calls: ${calls.length}; every one after #1 made only after portalId ${SANDBOX} was confirmed. Research Summary fieldType: ${fieldTypes.convention_research_summary}`);
  }
}

main().catch((e) => { out(`ERROR: ${e.message}`); process.exitCode = 1; });
