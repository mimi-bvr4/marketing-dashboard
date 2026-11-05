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
  // ORDER #2955 the "say something" button. A random clip of that character's,
  // never the same one twice in a row (when there is more than one).
  function pickClip(n, last, rand) {
    const r = rand || Math.random;
    if (!n || n < 1) return -1;
    if (n === 1) return 0;
    let i = Math.floor(r() * (n - 1));
    if (last != null && last >= 0 && i >= last) i += 1; // skip the last one
    return Math.min(Math.max(i, 0), n - 1);
  }
  // The button exists only when the switch is on AND that character has a clip.
  function speakerFor(state, slug) {
    if (!state || state.on !== true || !state.voices) return null;
    const clips = state.voices[slug];
    return clips && clips.length ? clips : null;
  }
  function speakerHtml(state, slug, name, esc) {
    if (!speakerFor(state, slug)) return '';
    const e = esc || ((s) => String(s));
    return `<button type="button" class="speak" data-speak="${e(slug)}" aria-label="Hear ${e(name)} say something" title="Say something">`
      + '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z M16 9a4 4 0 0 1 0 6 M18.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + `</button><span class="speakcap" data-speakcap="${e(slug)}" aria-live="polite" hidden></span>`;
  }
  return { sameWords, showEyebrow, stuckCount, STUCK, pickClip, speakerFor, speakerHtml };
}));
