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
  // ORDER #3310: an agent whose title and name are the same words by order
  // (the Keyword Queen, #3163) sets "title_always" so its card still shows a title.
  function showEyebrow(role, name, always) {
    if (!role || !String(role).trim()) return false;
    if (always === true) return true;
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
  // ORDER #3128 the name is never clipped. The card's name shrinks one step at a
  // time until it fits its column; measure(px) is the name's width at that size.
  // Null means no step fits, and the page stacks the portrait above the name.
  const NAME_STEPS = [24, 22, 20, 18, 16, 15];
  function fitFontPx(measure, avail, startPx) {
    const start = startPx || NAME_STEPS[0];
    const steps = [start, ...NAME_STEPS.filter((px) => px < start)];
    for (const px of steps) if (measure(px) <= avail) return px;
    return null;
  }
  // ORDER #3128 one box, not two. A member that ships OFF carries the need
  // "Mimi: switch it on (AGENT_X)" and the paused line "off until Mimi switches
  // it on (AGENT_X)". Same switch, same words: the Paused box stays and that
  // need drops out of Waiting on. Any other need is kept.
  function switchOf(s) {
    const m = /switch(?:es)? it on \(([A-Z0-9_]+)\)/.exec(String(s || ''));
    return m ? m[1] : null;
  }
  function cardBoxes(needs, paused) {
    const list = Array.isArray(needs) ? needs : [];
    const sw = switchOf(paused);
    return { needs: sw ? list.filter((n) => switchOf(n) !== sw) : list.slice(), paused: paused || null };
  }
  // ORDER #3831 (3815 follow-on): a Waiting on line or a source's why can carry
  // a URL (the Ads Export spec's Google Doc). Escape every character the way the
  // page's esc() does, and turn only a literal http:// or https:// run into a
  // new-tab link. Nothing from the agent file is ever passed through as HTML,
  // and no other scheme (javascript:, data:, mailto:) is ever linked. A bracket
  // or full stop right after the URL stays outside the link.
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escText(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]); }
  const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
  function trimTail(u) {
    let url = u;
    for (;;) {
      const last = url.slice(-1);
      if (/[.,;:!?]/.test(last)) { url = url.slice(0, -1); continue; }
      if (last === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) { url = url.slice(0, -1); continue; }
      if (last === ']' && (url.match(/\[/g) || []).length < (url.match(/\]/g) || []).length) { url = url.slice(0, -1); continue; }
      return url;
    }
  }
  function linkText(s) {
    const text = String(s == null ? '' : s);
    let out = '';
    let at = 0;
    for (const m of text.matchAll(URL_RE)) {
      const url = trimTail(m[0]);
      if (!/^https?:\/\/[^/]/i.test(url)) continue;
      out += escText(text.slice(at, m.index));
      const e = escText(url);
      out += `<a href="${e}" target="_blank" rel="noopener noreferrer">${e}</a>`;
      at = m.index + url.length;
    }
    return out + escText(text.slice(at));
  }
  return { sameWords, showEyebrow, stuckCount, STUCK, pickClip, speakerFor, speakerHtml, NAME_STEPS, fitFontPx, switchOf, cardBoxes, escText, linkText };
}));
