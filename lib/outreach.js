// ORDER #3000 ruling 1 (Mimi 11.05.2026): the shared outreach draft step. NB's
// "Email agent" is not a character; it is this step, used by every outreach card
// (Convention Charles, the National Planner Scout, the Gala Scout).
//
// MANUAL NOW. Every outreach email is a DRAFT that the assigned salesperson sends
// from HubSpot, so it is logged on the contact (the #2940 Convention pattern).
// This module has NO send function and imports no mailer. There is nothing here
// that can send, with the switch on or off.
//
// FEATURE FLAG: OUTREACH_AUTO_SEND default OFF. Even ON it does nothing: the
// criteria for the "auto pot" are not ruled (a later order, Mimi and NB). The
// per-card flag `auto_pot` is always written false until then, and autoSend()
// always answers no, saying why.
//
// CAN-SPAM FROM DAY ONE. Every outreach draft carries an opt-out line and IHG's
// mailing address. ORDER #3012 (Mimi, 11.05.2026 23:36 CT): the address is the
// main office, 345 Hill Ave, Nashville, TN 37210, whenever OUTREACH_MAILING_ADDRESS
// is unset. Set to another value, that value is used. Set to an empty string, the
// draft says so in brackets (NO_ADDRESS), so a salesperson sees the gap before sending.
//
// WHO SENDS. Convention cards go to Cameron Creasy (#2940, 11.04 ruling). The
// Planner Scout's and the Gala Scout's salesperson is a setting on each agent
// (ORDER #3003, #3012): a HubSpot owner id, joined by id, never by name. It is
// decided Mon 11.09.2026; until it is set their cards say "No salesperson set
// yet" and their approved cards wait in Ready, untouched, never a HubSpot task.
'use strict';

const FLAG = 'OUTREACH_AUTO_SEND';
const ADDRESS_ENV = 'OUTREACH_MAILING_ADDRESS';
const DEFAULT_ADDRESS = '345 Hill Ave, Nashville, TN 37210';

const OPT_OUT = 'If you would rather not hear from us, reply "no thanks" and we will not email you again.';
const NO_ADDRESS = '[IHG mailing address: not set yet (OUTREACH_MAILING_ADDRESS). Add it before sending.]';

function autoSendSwitch(env = process.env) {
  return /^(1|on|true|yes)$/i.test(String(env[FLAG] || '').trim());
}

// Always no. The switch only changes the reason given.
function autoSend(env = process.env) {
  return { send: false, why: autoSendSwitch(env)
    ? `${FLAG} is on, but the auto-send criteria are not ruled yet (ORDER #3000 ruling 1), so nothing is sent`
    : `${FLAG} is off: a salesperson sends every outreach email from HubSpot` };
}

// Unset: the main office (#3012). An empty string: null, so the footer shows NO_ADDRESS.
function mailingAddress(env = process.env) {
  if (env[ADDRESS_ENV] === undefined || env[ADDRESS_ENV] === null) return DEFAULT_ADDRESS;
  const a = String(env[ADDRESS_ENV]).trim();
  return a || null;
}

function footer(env = process.env) {
  return `--\n${OPT_OUT}\n${mailingAddress(env) || NO_ADDRESS}`;
}

// Adds the footer once. An email that already carries the opt-out line is left as is.
function withFooter(email, env = process.env) {
  const e = String(email || '').replace(/\s+$/, '');
  if (e.includes(OPT_OUT)) return e;
  return `${e}\n\n${footer(env)}`;
}

// Who sends an agent's approved outreach. Convention Charles: Cameron Creasy, by
// the #2940 rule in lib/hubspot-sales-task.js (unchanged). The Scouts: the
// HubSpot owner id saved on the agent (store.salesOwnerId), never a name.
const OWNERS = { 'convention-connector': 'Cameron Creasy' };
const OWNER_SETTING_AGENTS = ['planner-scout', 'gala-scout'];
const NO_OWNER = 'No salesperson set yet';
const OWNER_ID_RE = /^\d{1,20}$/;

function ownerSettingAgent(agent) { return OWNER_SETTING_AGENTS.includes(agent); }

// A saved owner id, checked: digits only (a HubSpot owner id). Anything else is "not set".
function cleanOwnerId(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return OWNER_ID_RE.test(s) ? s : null;
}

// { name } for Convention Charles, { id } for a Scout with its owner set, null otherwise.
async function salesOwner(agent, { store } = {}) {
  if (OWNERS[agent]) return { name: OWNERS[agent] };
  if (!ownerSettingAgent(agent)) return null;
  const id = store && store.salesOwnerId ? cleanOwnerId(await store.salesOwnerId(agent)) : null;
  return id ? { id } : null;
}

// The label a card shows for who sends it.
function ownerLine(owner) {
  if (!owner) return NO_OWNER;
  return owner.name ? owner.name : `HubSpot owner ${owner.id}`;
}

// Kept for #3000 callers: the fixed name, or null (a Scout's owner is read with salesOwner()).
function ownerFor(agent) { return OWNERS[agent] || null; }

// The draft as it is stored on the card: footer added by code, auto pot off.
function draft(sales, env = process.env) {
  if (!sales || !sales.email) return sales;
  return { ...sales, email: withFooter(sales.email, env), auto_pot: false };
}

module.exports = { FLAG, ADDRESS_ENV, DEFAULT_ADDRESS, OPT_OUT, NO_ADDRESS, NO_OWNER, OWNER_SETTING_AGENTS, autoSendSwitch, autoSend, mailingAddress, footer, withFooter,
  ownerFor, ownerSettingAgent, cleanOwnerId, salesOwner, ownerLine, draft, OWNERS };
