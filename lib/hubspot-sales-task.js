// ORDER #2940 (#2904 step 2): an APPROVED Convention Connector card becomes ONE
// HubSpot task for Cameron Creasy, Venue Sales Director (Mimi, popup
// 11.04.2026: "A + Y"). RUNS ON THE BOX, from jobs/agent_handoff.js.
//
// THE FENCES (code, not prompt):
//   1. Two switches, both default OFF:
//        CONVENTION_TO_HUBSPOT=on       sandbox 51163869, token HUBSPOT_SANDBOX_TOKEN
//        CONVENTION_TO_HUBSPOT_PROD=on  prod 49701209, token HUBSPOT_TOKEN (Mimi's go only)
//      Before any write, the token's portal is read from HubSpot itself and must
//      be the portal that switch names. A mismatch writes nothing.
//   2. The task body is the approved email WORD FOR WORD, plus who approved it
//      and when. The approving person is the cause of the write (iron rule 1,
//      10.16.2026 amendment); a card nobody approved is never read here.
//   3. A company is created only when no company with that domain or name is
//      already in HubSpot, and only with the card's own fields: name, domain,
//      website. Never a contact, never a person, never any other field.
//   4. The owner is Cameron Creasy, found by name among that portal's ACTIVE
//      owners. In prod he must be owner 79905153 (read live 11.04.2026). In the
//      sandbox a named stand-in may be set with CONVENTION_SANDBOX_OWNER_ID.
'use strict';

const HS = 'https://api.hubapi.com';
const PORTALS = { sandbox: 51163869, prod: 49701209 };
const CAMERON = { name: 'Cameron Creasy', prodOwnerId: '79905153' };
// HubSpot-defined association type, task to company.
const TASK_TO_COMPANY = 192;
// #3012: the task subject names which agent found the lead.
const LEAD_KIND = { 'planner-scout': 'Planner lead', 'gala-scout': 'Gala lead' };
const AGENT_LABEL = { 'planner-scout': 'National Planner Scout', 'gala-scout': 'Gala Scout' };

const on = (v) => String(v || '').trim().toLowerCase() === 'on';

// The sandbox token may live in the Box Keychain (item hubspot-sandbox-token),
// read in this process, never printed or stored (the lib/pinterest.js pattern).
const SANDBOX_KEYCHAIN = 'hubspot-sandbox-token';
function keychain(name) {
  try {
    const { execFileSync } = require('child_process');
    return String(execFileSync('security', ['find-generic-password', '-s', name, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
  } catch (e) { return null; }
}

// Which portal (if any) the switches send to. Prod wins only when its own switch is on.
function target(env = process.env, secrets = keychain) {
  if (on(env.CONVENTION_TO_HUBSPOT_PROD)) return { where: 'prod', portal: PORTALS.prod, token: String(env.HUBSPOT_TOKEN || '').trim() || null, tokenName: 'HUBSPOT_TOKEN' };
  if (on(env.CONVENTION_TO_HUBSPOT)) {
    const t = String(env.HUBSPOT_SANDBOX_TOKEN || '').trim() || (secrets ? secrets(SANDBOX_KEYCHAIN) : null);
    return { where: 'sandbox', portal: PORTALS.sandbox, token: t || null, tokenName: `HUBSPOT_SANDBOX_TOKEN (or Keychain item ${SANDBOX_KEYCHAIN})` };
  }
  return null;
}

function domainOf(u) {
  try { const h = new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ''); return h.includes('.') ? h : null; } catch (e) { return null; }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The task text. The email is escaped and its line breaks kept, nothing else changes.
function taskBody({ sales, card, approvedBy, approvedAt, companyCreated }) {
  const note = [`Approved by ${approvedBy} on ${approvedAt} in the marketing dashboard (${AGENT_LABEL[card.agent] || 'Convention Connector'}, card #${card.id}).`,
    'The email below is exactly what was approved. Send it from HubSpot so it is logged on the contact.',
    companyCreated ? 'The company record was added to HubSpot from this approved card.' : null].filter(Boolean).join(' ');
  return `<p>${esc(note)}</p><p><strong>Subject:</strong> ${esc(sales.subject || '(none given)')}</p><p>${esc(sales.email).replace(/\r?\n/g, '<br>')}</p>`
    + (sales.website ? `<p>Company page: ${esc(sales.website)}</p>` : '');
}

function checkSales(sales) {
  if (!sales || typeof sales !== 'object') return 'the card carries no email for Sales';
  if (!sales.company || !String(sales.company).trim()) return 'the card names no company';
  if (!sales.email || !String(sales.email).trim()) return 'the card carries no email text';
  if (sales.website && !/^https:\/\//.test(sales.website)) return 'the company page is not an https link';
  return null;
}

async function call(fetchImpl, token, method, path, body) {
  const r = await fetchImpl(HS + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

async function findOwner({ fetchImpl, token, where, env, ownerId }) {
  const list = [];
  let after = null;
  for (let i = 0; i < 10; i++) {
    const r = await call(fetchImpl, token, 'GET', `/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    if (!r.ok) return { retry: true, why: `HubSpot owners answered ${r.status}` };
    list.push(...(r.body.results || []));
    after = r.body.paging && r.body.paging.next && r.body.paging.next.after;
    if (!after) break;
  }
  // #3003/#3012: a Scout's salesperson is the owner id saved on the agent,
  // joined by id only. It must still be an ACTIVE owner in this portal.
  if (ownerId) {
    const o = list.find((x) => String(x.id) === String(ownerId) && x.archived !== true);
    if (!o) return { skip: true, why: `HubSpot owner ${ownerId} is not an active owner in this portal; nothing was sent` };
    return { ok: true, id: String(o.id), name: `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email || String(o.id) };
  }
  const want = CAMERON.name.toLowerCase();
  const cam = list.find((o) => `${o.firstName || ''} ${o.lastName || ''}`.trim().toLowerCase() === want && o.archived !== true);
  if (where === 'prod') {
    if (!cam || String(cam.id) !== CAMERON.prodOwnerId) return { skip: true, why: `Cameron Creasy is not owner ${CAMERON.prodOwnerId} in HubSpot any more; nothing was sent` };
    return { ok: true, id: String(cam.id), name: CAMERON.name };
  }
  if (cam) return { ok: true, id: String(cam.id), name: CAMERON.name };
  const stand = String(env.CONVENTION_SANDBOX_OWNER_ID || '').trim();
  const s = stand && list.find((o) => String(o.id) === stand);
  if (s) return { ok: true, id: stand, name: `${`${s.firstName || ''} ${s.lastName || ''}`.trim() || s.email || stand} (sandbox stand-in for Cameron Creasy)`, standIn: true };
  return { skip: true, why: 'Cameron Creasy is not an owner in the sandbox and no stand-in is set (CONVENTION_SANDBOX_OWNER_ID)' };
}

async function findOrCreateCompany({ fetchImpl, token, sales }) {
  const domain = domainOf(sales.website);
  const search = async (propertyName, value) => {
    const r = await call(fetchImpl, token, 'POST', '/crm/v3/objects/companies/search',
      { filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }], properties: ['name', 'domain'], limit: 1 });
    if (!r.ok) throw new Error(`HubSpot company search answered ${r.status}`);
    return (r.body.results || [])[0] || null;
  };
  const hit = (domain && await search('domain', domain)) || await search('name', String(sales.company).trim());
  if (hit) return { id: String(hit.id), created: false };
  const properties = { name: String(sales.company).trim() };
  if (domain) { properties.domain = domain; properties.website = sales.website; }
  const r = await call(fetchImpl, token, 'POST', '/crm/v3/objects/companies', { properties });
  if (!r.ok || !r.body.id) throw new Error(`HubSpot company create answered ${r.status}`);
  return { id: String(r.body.id), created: true, fields: Object.keys(properties) };
}

// Hand one approved card to Sales. Returns { ok, ... } | { skip, why } | { retry, why } | { off }.
async function sendToSales({ card, env = process.env, fetchImpl = globalThis.fetch, now = () => new Date(), secrets = keychain, ownerId = null }) {
  const t = target(env, secrets);
  if (!t) return { off: true, why: 'CONVENTION_TO_HUBSPOT is off' };
  const sales = card.payload && card.payload.sales;
  const bad = checkSales(sales);
  if (bad) return { skip: true, why: bad };
  if (card.status !== 'ready' || !card.decided_by) return { skip: true, why: 'the card is not approved' };
  if (!t.token) return { retry: true, why: `${t.tokenName} is not set on the Box`, credential: t.tokenName };
  const acct = await call(fetchImpl, t.token, 'GET', '/account-info/v3/details');
  if (!acct.ok) return { retry: true, why: `HubSpot account check answered ${acct.status}` };
  if (Number(acct.body.portalId) !== t.portal) return { skip: true, why: `the ${t.tokenName} token is for portal ${acct.body.portalId}, not ${t.portal}; nothing was sent` };
  const owner = await findOwner({ fetchImpl, token: t.token, where: t.where, env, ownerId });
  if (!owner.ok) return owner;
  let company;
  try { company = await findOrCreateCompany({ fetchImpl, token: t.token, sales }); } catch (e) { return { retry: true, why: e.message }; }
  const approvedAt = card.decided_at ? new Date(card.decided_at).toISOString() : now().toISOString();
  const body = taskBody({ sales, card, approvedBy: card.decided_by, approvedAt, companyCreated: company.created });
  const r = await call(fetchImpl, t.token, 'POST', '/crm/v3/objects/tasks', {
    properties: { hs_timestamp: now().toISOString(), hs_task_subject: `${LEAD_KIND[card.agent] || 'Convention lead'}: ${String(sales.company).trim()} (approved card #${card.id})`.slice(0, 250),
      hs_task_body: body, hubspot_owner_id: owner.id, hs_task_status: 'NOT_STARTED', hs_task_type: 'EMAIL' },
    associations: [{ to: { id: company.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_COMPANY }] }],
  });
  if (!r.ok || !r.body.id) {
    // The company may already be made; the claim stays so nothing is written twice. A person looks.
    return { alarm: true, why: `HubSpot task create answered ${r.status}${company.created ? ` after company ${company.id} was created` : ''}`, company_id: company.id, company_created: company.created };
  }
  return { ok: true, where: t.where, portal: t.portal, task_id: String(r.body.id), owner_id: owner.id, owner_name: owner.name, stand_in: !!owner.standIn,
    company_id: company.id, company_created: company.created, company_fields: company.fields || null,
    company_link: `https://app.hubspot.com/contacts/${t.portal}/record/0-2/${company.id}`, approved_by: card.decided_by, approved_at: approvedAt };
}

module.exports = { sendToSales, target, taskBody, checkSales, domainOf, PORTALS, CAMERON, TASK_TO_COMPANY, SANDBOX_KEYCHAIN };
