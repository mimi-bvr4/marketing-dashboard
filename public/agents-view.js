// ORDER #2941: the pure display rules of the team page, shared by the page
// (window.AgentsView) and the tests (require). Nothing here reads or writes.
//
// THE EYEBROW RULE: a card shows its role above the name ONLY when the name
// says something different. "The producer" over "The Producer" is the same
// words twice, so the name shows once. A renamed agent ("Convention Charles"
// for the convention connector) keeps the eyebrow, so the job is still visible.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentsView = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Case, punctuation, spacing and a leading "the" never make two words different.
  function sameWords(a, b) {
    const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '').replace(/ /g, '');
    return norm(a) === norm(b);
  }
  function showEyebrow(role, name) {
    if (!role || !String(role).trim()) return false;
    return !sameWords(role, name);
  }
  // The Producer's board states that mean someone is stuck (lib/producer.js board()).
  const STUCK = ['waiting', 'failed', 'held'];
  function stuckCount(board) {
    return (board || []).filter((b) => STUCK.includes(b.state)).length;
  }
  return { sameWords, showEyebrow, stuckCount, STUCK };
}));
