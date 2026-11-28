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
  // ORDER #3923: the drawn portrait each character has until someone uploads
  // one. Moved here from agents.html so the Review page draws the same faces.
  const LOOK = {
    'bloggy-bob': ['#F3DED8', '#8A4832', 'M2 20h4L17 9l-4-4L2 16v4z M11 7l4 4'],
    'site-health': ['#DCE6E4', '#2F5D5A', 'M9 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12z M14 14l5 5'],
    'monthly-report': ['#E1E0EE', '#46407A', 'M3 20V11 M9 20V5 M15 20v-6 M2 20h19'],
    'citations': ['#DDE8DF', '#2F5D3F', 'M11 2l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V5l7-3z M8 11l2 2 4-4'],
    'gbp': ['#F2E0DC', '#8A2B22', 'M4 17h14 M6 17v-3a5 5 0 0 1 10 0v3 M11 7v2 M9 5h4'],
    'paid-ads': ['#E7E3DD', '#4D453D', 'M8 3h6v3H8z M6 4H4v16h14V4h-2 M7 11h8 M7 15h5'],
    'seo': ['#E6EEDC', '#4A6A2A', 'M3 18l5-6 4 3 6-8 M14 7h4v4'],
    'pr-patty': ['#F1E3EC', '#7A3A62', 'M3 10v4h3l6 4V6L6 10H3z M15 9a4 4 0 0 1 0 6 M17 6a8 8 0 0 1 0 12'],
    'copywriter': ['#EEE6D6', '#6B5426', 'M4 20h4l10-10-4-4L4 16v4z M3 4h8 M3 8h5'],
    'email': ['#E0EAEC', '#2F5D66', 'M3 6h18v12H3z M3 6l9 7 9-7'],
    'convention-connector': ['#DDE3EE', '#34466B', 'M3 20V9l8-5 8 5v11 M8 20v-6h6v6 M3 9h16'],
    'pinterest-paul': ['#F4DCDC', '#9A2A2A', 'M11 2a7 7 0 0 0-2.5 13.5L7 21 M11 2a7 7 0 0 1 0 14 M9 9a2 2 0 1 1 4 0c0 2-2 2-2 4'],
    'scout': ['#E2E6EE', '#3B4A66', 'M2 15a4 4 0 1 0 8 0 4 4 0 0 0-8 0 M12 15a4 4 0 1 0 8 0 4 4 0 0 0-8 0 M10 15h2 M4 11l2-6h3l1 6 M18 11l-2-6h-3l-1 6'],
  };
  function face(a, size) {
    const label = `Portrait of ${a.name}`;
    if (a.portrait) return `<span class="face" style="width:${size}px;height:${size}px"><img src="${escText(a.portrait)}" alt="${escText(label)}" width="${size}" height="${size}"></span>`;
    const [tint, ink, icon] = LOOK[a.slug] || ['#E7E3DD', '#4D453D', 'M6 12h10 M11 7v10'];
    return `<svg class="face" width="${size}" height="${size}" viewBox="0 0 88 88" role="img" aria-label="${escText(label)}">
      <circle cx="44" cy="44" r="44" fill="${tint}"/><path d="M18 78c2-14 12-22 26-22s24 8 26 22" fill="${ink}"/><circle cx="44" cy="34" r="14" fill="${ink}"/>
      <circle cx="69" cy="67" r="17" fill="#fff" stroke="${ink}" stroke-width="2"/>
      <g transform="translate(57 55)"><path d="${icon}" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  }

  // ORDER #3923: the team's week, open at the top of the team page. week is
  // GET /api/producer's "week" (lib/week-view.js). portraitOf(slug) gives an
  // uploaded portrait url or null. Each chip shows the portrait, name, run time
  // and its state in words (the color repeats the word, never replaces it).
  // A chip Katherine may move carries the day picker, opened from the chip.
  const DAY_OPTS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
  function weekChip(c, dayKey, portraitOf) {
    const pic = face({ slug: c.agent, name: c.name, portrait: portraitOf ? portraitOf(c.agent) : null }, 28);
    const when = c.on ? `${escText(c.on)}, ${escText(c.time)}` : escText(c.time);
    const pick = c.movable && dayKey ? `<details class="pick"><summary>Move ${escText(c.name)}</summary>
      <select data-movesel="${escText(c.agent)}" data-from="${escText(dayKey)}" aria-label="Move ${escText(c.name)} to another day">${DAY_OPTS.map(([k, l]) => `<option value="${k}" ${k === dayKey ? 'selected' : ''}>${l}</option>`).join('')}</select></details>` : '';
    return `<div class="wchip st-${escText(c.state)}" data-chip="${escText(c.agent)}|${escText(dayKey || 'daily')}">
      <div class="wtop">${pic}<span class="wname">${escText(c.name)}</span></div>
      <span class="wmeta"><span class="wtime">${when}</span> <span class="wstate">${escText(c.word)}</span></span>${pick}</div>`;
  }
  function weekHtml(week, portraitOf) {
    if (!week || !Array.isArray(week.days)) return '';
    const band = (week.daily || []).length ? `<div class="wband"><h3>Every day</h3><div class="wchips">${week.daily.map((c) => weekChip(c, null, portraitOf)).join('')}</div></div>` : '';
    const monthly = (week.monthly || []).length ? `<p class="meta wmonthly">Monthly: ${week.monthly.map((m) => `${escText(m.name)} on the ${escText(m.on)}`).join(', ')}.</p>` : '';
    // On a phone the columns become one list, today first (CSS order on .wday.today).
    const days = week.days.map((d) => `<div class="wday${d.today ? ' today' : (d.ymd < week.today ? ' past' : '')}" data-day="${escText(d.key)}"${d.today ? ' aria-current="date"' : ''}>
      <h3>${escText(d.label)} <span class="wdate">${escText(d.mmdd)}</span>${d.today ? ' <span class="wtoday">Today</span>' : ''}</h3>
      ${d.chips.length ? d.chips.map((c) => weekChip(c, d.key, portraitOf)).join('') : '<p class="wnone">No scheduled runs</p>'}</div>`).join('');
    return `<section class="teamweek" id="teamweek" aria-labelledby="teamweekH">
      <h2 class="serif" id="teamweekH">This week: who runs when</h2>
      ${week.producer_on ? '' : '<p class="note">The Producer\'s calendar is not switched on, so this is the fixed schedule that runs now. Moving a day opens once it is on.</p>'}
      ${band}<div class="wdays">${days}</div>${monthly}
      <p class="meta wkey">Every scheduled run starts at ${escText(week.run_time)} unless the chip says otherwise. Each chip says in words whether it ran, is due, is paused, was held by the brake, failed, is waiting on input, or has no run recorded.</p>
    </section>`;
  }
  return { sameWords, showEyebrow, stuckCount, STUCK, pickClip, speakerFor, speakerHtml, NAME_STEPS, fitFontPx, switchOf, cardBoxes, escText, linkText, LOOK, face, weekHtml, weekChip };
}));
