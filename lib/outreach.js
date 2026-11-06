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
// mailing address. The address is not guessed: it is OUTREACH_MAILING_ADDRESS,
// and until that is set the draft says so in brackets, so a salesperson sees the
// gap before sending.
//
// WHO SENDS. Convention cards go to Cameron Creasy (#2940, 11.04 ruling). The
// salesperson for the Planner Scout and the Gala Scout is not named yet (#3000
// "ASK BEFORE BUILD"), so their approved cards wait, untouched, until it is.
'use strict';

const FLAG = 'OUTREACH_AUTO_SEND';
const ADDRESS_ENV = 'OUTREACH_MAILING_ADDRESS';

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

function mailingAddress(env = process.env) {
  const a = String(env[ADDRESS_ENV] || '').trim();
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

// Who sends an agent's approved outreach. null = not named yet; the card waits.
const OWNERS = { 'convention-connector': 'Cameron Creasy' };
function ownerFor(agent) { return OWNERS[agent] || null; }

// The draft as it is stored on the card: footer added by code, auto pot off.
function draft(sales, env = process.env) {
  if (!sales || !sales.email) return sales;
  return { ...sales, email: withFooter(sales.email, env), auto_pot: false };
}

module.exports = { FLAG, ADDRESS_ENV, OPT_OUT, NO_ADDRESS, autoSendSwitch, autoSend, mailingAddress, footer, withFooter, ownerFor, draft, OWNERS };
