// ORDER #3344 (Mimi, popup 11.13.2026, amends #2940 ruling Y): when Mary Topp
// ASSIGNS a Convention Charles lead on /handoff (#3165), the hand-off also
// creates or updates ONE HubSpot contact for the named person on the card,
// owned by Mary's pick, with Mary Topp's five Convention properties. Setting
// "Convention Prospect" true enrolls the contact in her Prospecting Agent Play
// (her HubSpot workflow). The salesperson approves, edits and sends there.
// Humans send. This file sends nothing; it writes one contact.
//
// RUNS ON THE BOX, from jobs/agent_handoff.js, only for a card Mary assigned,
// only after the #2940 task step succeeded (so the portal check, the owner
// check and the company are already done), and only with its own switch on:
//   CONVENTION_CONTACT_ON_ASSIGN=on   (default OFF)
// The portal is whatever the #2940 switches already chose; prod is reached only
// under CONVENTION_TO_HUBSPOT_PROD, which stays Mimi's switch.
//
// THE FENCES (code, not prompt):
//   1. A person is used only when the card itself names them: a first or last
//      name, a well-formed email, AND the https page that printed it
//      (contact_page). No name, no email or no page: no contact, and the card
//      says so in a loud line. An email is never guessed, built or pattern-filled.
//   2. The five internal names are read from HubSpot by EXACT label each run
//      (GET /crm/v3/properties/contacts). Any label not found is UNVERIFIED and
//      blocks every contact write. No internal name is written in this file.
//   3. "Convention Prospect" = true is written LAST, alone, after every other
//      field has written. A partial write never enrolls anyone. A contact whose
//      flag is already true is never re-flipped.
//   4. A contact is found by exact email first; only if none exists is one
//      created, with first name, last name, email, owner and the four other
//      Convention properties, associated to the #2940 company. An existing
//      contact keeps its existing owner.
//   5. The Research Summary is the approved card's own text, scrubbed (no em
//      dash, no dollar figure, no capacity number) and HTML-escaped. Nothing added.
'use strict';

const { scrub } = require('./hubspot-import');

const HS = 'https://api.hubapi.com';
const FLAG = 'CONVENTION_CONTACT_ON_ASSIGN';
// Mary Topp's labels, from her email of 11.13.2026. Matched exactly.
const LABELS = {
  prospect: 'Convention Prospect',
  name: 'Convention Name',
  start: 'Convention Start Date',
  end: 'Convention End Date',
  summary: 'Convention Research Summary',
};
// HubSpot-defined association type, contact to company (UNVERIFIED against the
// docs this build: the docs tool was refused; the sandbox proof confirms it).
const CONTACT_TO_COMPANY = 279;

const on = (env = process.env) => String(env[FLAG] || '').trim().toLowerCase() === 'on';
const clean = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
const EMAIL = /^[^\s@<>(),;:"']+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The named person on the card, or { skip, why }.
function personOf(sales) {
  const s = sales || {};
  const first = clean(s.first_name).slice(0, 100); const last = clean(s.last_name).slice(0, 100);
  const email = clean(s.contact_email).toLowerCase();
  const page = clean(s.contact_page);
  const no = (why) => ({ skip: true, why: `NO CONTACT MADE: ${why}. The card holds only a company, so Mary's Play cannot pick this lead up; nothing was guessed.` });
  if (!email || !EMAIL.test(email)) return no('the approved card has no named person with a work email');
  if (!first && !last) return no('the approved card gives an email but no person\'s name');
  if (!/^https:\/\/\S+$/.test(page)) return no('the approved card does not link the public page that printed this email');
  return { ok: true, first, last, email, page };
}

// The convention on the card. Name required; a date is written only as YYYY-MM-DD.
function conventionOf(sales) {
  const s = sales || {};
  const name = clean(s.convention_name).slice(0, 250);
  if (!name) return { skip: true, why: 'NO CONTACT MADE: the approved card does not name the convention' };
  const day = (v) => (DAY.test(clean(v)) && !Number.isNaN(Date.parse(`${clean(v)}T00:00:00Z`)) ? clean(v) : null);
  return { ok: true, name, start: day(s.convention_start), end: day(s.convention_end) };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The approved card's own words, before the runner's "###" sections (sources,
// checks), scrubbed and escaped, one <p> per paragraph.
function researchSummary(card) {
  const own = String((card && card.body) || '').split(/\n#{2,}\s/)[0];
  const paras = scrub(own).split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return paras.map((p) => `<p>${esc(p)}</p>`).join('').slice(0, 60000);
}

async function call(fetchImpl, token, method, path, body) {
  const r = await fetchImpl(HS + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

// Every label resolved to its internal name, or { blocked, missing }.
async function resolveProperties({ fetchImpl, token }) {
  const r = await call(fetchImpl, token, 'GET', '/crm/v3/properties/contacts');
  if (!r.ok) return { retry: true, why: `HubSpot contact properties answered ${r.status}` };
  const list = (r.body && r.body.results) || [];
  const names = {}; const missing = [];
  for (const [k, label] of Object.entries(LABELS)) {
    const hits = list.filter((p) => p && p.label === label && p.archived !== true);
    if (hits.length === 1) names[k] = hits[0].name; else missing.push(label);
  }
  return missing.length ? { blocked: true, missing } : { ok: true, names };
}

// One contact for one assigned card. owner_id and company_id come from the
// #2940 task step that just succeeded. Returns a record for the card:
//   { ok, contact_id, created, flag_set, line } | { ok: false, skip|alarm|retry, why, line }
async function contactOnAssign({ card, ownerId, ownerName, companyId, token, fetchImpl }) {
  const sales = (card.payload && card.payload.sales) || {};
  const fail = (kind, why) => ({ ok: false, [kind]: true, why, line: kind === 'alarm' ? `ALARM: ${why}` : why });
  const person = personOf(sales);
  if (!person.ok) return fail('skip', person.why);
  const conv = conventionOf(sales);
  if (!conv.ok) return fail('skip', conv.why);
  const res = await resolveProperties({ fetchImpl, token });
  if (res.retry) return fail('skip', `NO CONTACT MADE: ${res.why}`);
  if (res.blocked) return fail('skip', `NO CONTACT MADE: HubSpot has no contact property labelled exactly ${res.missing.map((m) => `"${m}"`).join(', ')} (UNVERIFIED: ${res.missing.join(', ')}), so nothing was written`);
  const n = res.names;

  const conventionProps = { [n.name]: conv.name, [n.summary]: researchSummary(card) };
  if (conv.start) conventionProps[n.start] = conv.start;
  if (conv.end) conventionProps[n.end] = conv.end;

  const found = await call(fetchImpl, token, 'POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: person.email }] }],
    properties: ['email', 'hubspot_owner_id', n.prospect], limit: 2 });
  if (!found.ok) return fail('skip', `NO CONTACT MADE: HubSpot contact search answered ${found.status}`);
  const hits = (found.body && found.body.results) || [];
  if (hits.length > 1) return fail('skip', `NO CONTACT MADE: HubSpot already holds ${hits.length} contacts with ${person.email}; a person picks which one`);

  let id; let created = false; let ownerKept = null; let alreadyFlagged = false;
  if (!hits.length) {
    const props = { email: person.email, hubspot_owner_id: String(ownerId), ...conventionProps };
    if (person.first) props.firstname = person.first;
    if (person.last) props.lastname = person.last;
    const r = await call(fetchImpl, token, 'POST', '/crm/v3/objects/contacts', {
      properties: props,
      associations: companyId ? [{ to: { id: String(companyId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: CONTACT_TO_COMPANY }] }] : [],
    });
    if (!r.ok || !r.body.id) return fail('alarm', `HubSpot contact create answered ${r.status}; Convention Prospect was not set`);
    id = String(r.body.id); created = true;
  } else {
    const h = hits[0]; id = String(h.id);
    const p = h.properties || {};
    alreadyFlagged = String(p[n.prospect]).toLowerCase() === 'true';
    const upd = { ...conventionProps };
    if (p.hubspot_owner_id) ownerKept = String(p.hubspot_owner_id); else upd.hubspot_owner_id = String(ownerId);
    const r = await call(fetchImpl, token, 'PATCH', `/crm/v3/objects/contacts/${id}`, { properties: upd });
    if (!r.ok) return fail('alarm', `HubSpot contact ${id} update answered ${r.status}; Convention Prospect was not set`);
    if (companyId) {
      const a = await call(fetchImpl, token, 'PUT', `/crm/v4/objects/contact/${id}/associations/default/company/${companyId}`);
      if (!a.ok) return fail('alarm', `HubSpot contact ${id} to company ${companyId} association answered ${a.status}; Convention Prospect was not set`);
    }
  }

  // LAST: the flag that enrolls, alone, after every other field has written.
  if (!alreadyFlagged) {
    const f = await call(fetchImpl, token, 'PATCH', `/crm/v3/objects/contacts/${id}`, { properties: { [n.prospect]: 'true' } });
    if (!f.ok) return { ...fail('alarm', `HubSpot contact ${id} was ${created ? 'made' : 'updated'} but Convention Prospect answered ${f.status}, so it is NOT enrolled; a person sets it`), contact_id: id, created };
  }
  const who = [person.first, person.last].filter(Boolean).join(' ');
  const owner = ownerKept ? `owner kept as HubSpot owner ${ownerKept} (already owned)` : `owner ${ownerName || `HubSpot owner ${ownerId}`}`;
  const line = `HubSpot contact ${id} ${created ? 'made' : 'updated'} for ${who}, ${owner}, Convention Prospect ${alreadyFlagged ? 'was already set' : 'set'}`;
  return { ok: true, contact_id: id, created, flag_set: !alreadyFlagged, owner_kept: ownerKept, properties: Object.keys(conventionProps).length + 1, line };
}

module.exports = { FLAG, LABELS, CONTACT_TO_COMPANY, on, personOf, conventionOf, researchSummary, resolveProperties, contactOnAssign };
