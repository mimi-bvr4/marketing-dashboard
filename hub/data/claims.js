'use strict';

// A copy fact that is waiting on Katherine is written as a claim:
//   { text, status: 'UNVERIFIED', check: 'what has to be confirmed' }
// It is kept in the record so nobody has to re-find it, and it is NEVER
// rendered until its status is 'approved'. Plain strings are skeleton copy
// with no open fact-check item.

function unverified(text, check) {
  return { text, status: 'UNVERIFIED', check };
}

function published(claim) {
  if (claim == null) return null;
  if (typeof claim === 'string') return claim;
  return claim.status === 'approved' ? claim.text : null;
}

function isHeld(claim) {
  return claim != null && typeof claim === 'object' && claim.status !== 'approved';
}

module.exports = { unverified, published, isHeld };
