// ORDER #3165: who Mary can pick on the Sales Hand-off desk.
//
// "Read the names live from the Company Directory or Owner_Directory with their
// HubSpot owner ids. Never free text. Mark inactive people (for example Katie
// Bradley) as unavailable."
//
// TWO LIVE READS, JOINED BY EMAIL, NEVER BY NAME:
//   1. Dispatch's People spine, the active people whose job category is Sales
//      (/api/brain/portal/roster?job_category=Sales, behind DISPATCH_BRIDGE_TOKEN,
//      the bridge lib/staff-identity.js already uses). Name and title come from here.
//   2. HubSpot's owner list for the portal the hand-off writes to (GET
//      /crm/v3/owners, lib/hubspot-sales-task.js listOwners). The id comes from here.
// A person with no matching ACTIVE owner is listed but cannot be picked, and the
// entry says why. So is anyone on the unavailable list. Mary herself is the one
// picking, so she is never on the list.
//
// Fails closed: with either read missing, nobody can be picked and the answer
// says which read failed. Nothing is written anywhere.
'use strict';

const { dispatchBase } = require('./sso');
const sales = require('./hubspot-sales-task');
const desk = require('./mary-desk');

const CATEGORY = 'Sales';
const TTL_MS = 5 * 60 * 1000;
// Katie Bradley: named in the order as not active. HubSpot owner 88308673
// (Owner_Directory). HANDOFF_UNAVAILABLE adds more (comma list of HubSpot
// owner ids or People person ids).
const UNAVAILABLE = { '88308673': 'Katie Bradley is not active (ORDER #3165)' };
const NOT_A_PICK_PERSON_IDS = new Set([desk.MARY_PERSON_ID]);
const NOT_A_PICK_OWNER_IDS = new Set([desk.MARY_OWNER_ID]);

const norm = (e) => String(e || '').trim().toLowerCase();

function unavailableFrom(env = process.env) {
  const out = { ...UNAVAILABLE };
  for (const id of String(env.HANDOFF_UNAVAILABLE || '').split(',').map((s) => s.trim()).filter(Boolean)) out[id] = out[id] || 'marked unavailable (HANDOFF_UNAVAILABLE)';
  return out;
}

// The title people know them by: the role on the record ("Venue Sales
// Specialist (Elle)" -> "Venue Sales Specialist"), else the employment title.
function titleOf(p) {
  const sub = String(p.job_subrole || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
  return sub || String(p.employment_title || '').trim() || null;
}

// Pure. people: dispatch rows; owners: HubSpot owner objects, or null when the
// owner list could not be read (ownersWhy says why).
function buildRoster({ people, owners, ownersWhy = null, unavailable = UNAVAILABLE }) {
  const byEmail = new Map();
  for (const o of owners || []) {
    if (o.archived === true) continue;
    const e = norm(o.email);
    if (e) byEmail.set(e, o);
  }
  const seen = new Set();
  const out = [];
  for (const p of people || []) {
    if (NOT_A_PICK_PERSON_IDS.has(p.person_id)) continue;
    if (seen.has(p.person_id)) continue;
    seen.add(p.person_id);
    const email = norm(p.primary_email);
    const o = email ? byEmail.get(email) : null;
    if (o && NOT_A_PICK_OWNER_IDS.has(String(o.id))) continue;
    const entry = { person_id: p.person_id, name: p.name || p.display_name || p.canonical_name, title: titleOf(p), email: email || null, owner_id: o ? String(o.id) : null, pickable: false, why: null };
    if (unavailable[p.person_id]) entry.why = unavailable[p.person_id];
    else if (o && unavailable[String(o.id)]) entry.why = unavailable[String(o.id)];
    else if (!owners) entry.why = ownersWhy || 'the HubSpot owner list could not be read';
    else if (!email) entry.why = 'no work email on the staff record, so no HubSpot owner can be matched';
    else if (!o) entry.why = `no active HubSpot owner has the email ${email}`;
    else entry.pickable = true;
    out.push(entry);
  }
  return out.sort((a, b) => (a.pickable === b.pickable ? String(a.name).localeCompare(String(b.name)) : a.pickable ? -1 : 1));
}

async function readPeople({ env, fetchImpl }) {
  if (!env.DISPATCH_BRIDGE_TOKEN) return { why: 'DISPATCH_BRIDGE_TOKEN is not set on this service, so the staff list was not read' };
  try {
    const r = await fetchImpl(`${(env.DISPATCH_BRIDGE_URL || dispatchBase()).replace(/\/+$/, '')}/api/brain/portal/roster?job_category=${encodeURIComponent(CATEGORY)}`,
      { headers: { Authorization: `Bearer ${env.DISPATCH_BRIDGE_TOKEN}` } });
    if (!r.ok) return { why: `the staff list answered ${r.status}` };
    const j = await r.json();
    return { people: Array.isArray(j.people) ? j.people : [] };
  } catch (e) { return { why: 'the staff list could not be reached' }; }
}

async function readOwners({ env, fetchImpl, secrets }) {
  const t = sales.target(env, secrets);
  if (!t) return { why: 'The HubSpot hand-off is off (CONVENTION_TO_HUBSPOT), so owner ids cannot be read yet' };
  if (!t.token) return { why: `${t.tokenName} is not set, so owner ids cannot be read` };
  const got = await sales.listOwners({ fetchImpl, token: t.token });
  if (!got.ok) return { why: got.why };
  return { owners: got.list, where: t.where };
}

// Live, cached for five minutes. A failed read is never cached.
function createRosterReader({ env = process.env, fetchImpl = globalThis.fetch, secrets, now = () => Date.now() } = {}) {
  let hit = null;
  return async function roster({ fresh = false } = {}) {
    if (!fresh && hit && now() - hit.at < TTL_MS) return hit.value;
    const ppl = await readPeople({ env, fetchImpl });
    if (!ppl.people) return { people: [], why: ppl.why, where: null };
    const own = await readOwners({ env, fetchImpl, ...(secrets !== undefined ? { secrets } : {}) });
    const value = { people: buildRoster({ people: ppl.people, owners: own.owners || null, ownersWhy: own.why, unavailable: unavailableFrom(env) }), why: own.why || null, where: own.where || null };
    if (own.owners) hit = { at: now(), value };
    return value;
  };
}

module.exports = { buildRoster, createRosterReader, titleOf, unavailableFrom, UNAVAILABLE, CATEGORY, TTL_MS };
