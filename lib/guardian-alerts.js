// ORDER #2903, ruling 5 (Mimi, popup 11.03.2026): Site Guardian lives on
// Katherine's team page as "the night watch", and its alerts go to MIMI FIRST,
// never to Katherine first. It is security work, and it patches.
//
// This replaces, for the first message of every alert, the "one message to
// Mimi, Katherine and Sam at the same moment" plan in #2193's step 0 reply.
// Site Guardian's build stays in #2193; this module is only the route.
//
// It DECIDES who hears an alert first and sends nothing. Whatever sender #2193
// builds must call route() and message exactly route(alert).first. Who else
// hears it after that is Mimi's call, made by a person, never by this code.
//
// Recipients are roles, never phone numbers or addresses: the sender resolves
// a role to a number with the work-phone rule at send time.
'use strict';

const FIRST = Object.freeze(['mimi']);
const NEVER_FIRST = Object.freeze(['katherine']);

// The kinds of alert #2193 plans. An unknown kind still goes to Mimi: a new
// kind of trouble must never fall through to nobody, or to the wrong person.
const KINDS = Object.freeze({
  down: 'a site is down',
  hack: 'a site shows signs of a hack',
  vulnerable: 'a plugin on a site has a known vulnerability',
  patched: 'a vulnerable plugin was patched after a backup point',
  'box-network': 'the Box lost its own network (every site looks down from the Box only)',
});

function route(alert = {}) {
  const kind = Object.prototype.hasOwnProperty.call(KINDS, alert.kind) ? alert.kind : 'unknown';
  return {
    kind,
    what: KINDS[kind] || 'something Site Guardian does not have a name for yet',
    first: FIRST.slice(),
    then: 'Mimi decides who else hears it',
  };
}

module.exports = { route, FIRST, NEVER_FIRST, KINDS };
