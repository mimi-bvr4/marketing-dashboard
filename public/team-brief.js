// ORDER #3116 (Mimi, 11.07.2026): Katherine's team on the home brief shows the
// exceptions, not all 20 agents alphabetically. Shared by the home page
// (window.TeamBrief) and the tests (require). Nothing here reads or writes.
//
//   1. failed: the last run failed (red), with the run's own note as a one-line reason;
//   2. waiting on a person: a required source is not connected yet (the team
//      page's "Waiting on input"), or an ask is waiting for an exec to approve;
//   3. everybody else, folded into one line. A paused agent that has not run
//      yet goes there too, never at the top.
// The rules mirror status() in public/agents.html, so the two pages agree.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeamBrief = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const REASON_MAX = 140;

  function isPaused(a) {
    const on = a.current ? a.current.enabled !== false : true;
    return !on || !!a.paused || (!!a.card_only && !a.ask_page);
  }
  function oneLine(s) {
    const line = String(s == null ? '' : s).split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
    return line.length > REASON_MAX ? line.slice(0, REASON_MAX - 1).trimEnd() + '…' : line;
  }
  // ORDER #3158: a run that failed because the model's answer could not be read
  // shows a sentence a person can act on, never the parser's own words
  // ("Expected ',' or '}' after property value in JSON at position 10934").
  // Shared by the home brief, the Producer board (lib/producer.js) and the
  // failed run's card (lib/agent-runner.js). Any other note passes through.
  // "Cut off" only when the model said it stopped at the length limit (the
  // runner writes that into the error); an unterminated string can also come
  // from a quote repair, so it is not proof of a cut-off.
  const CUT_RE = /cut off|length limit|max_tokens/i;
  const BAD_JSON_RE = /not valid JSON|in JSON at position|Unexpected token|Unexpected end of JSON input|Unterminated string|Bad control character|had no JSON object|needed too many repairs|Expected [^ ]+ (or [^ ]+ )?after (property|array)|Expected property name|Expected ':' after/i;
  function plainNote(s) {
    const t = String(s == null ? '' : s);
    if (!BAD_JSON_RE.test(t)) return oneLine(t);
    return CUT_RE.test(t)
      ? "The model's answer was cut off before it finished, so nothing was saved. It tries again on its next run."
      : "The model's answer came back garbled and could not be read, so nothing was saved. It tries again on its next run.";
  }
  function waitingReason(a) {
    const src = (a.sources || []).find((s) => s.required && s.pending);
    if (src) return 'waiting on input: ' + (src.label || src.name || 'a source') + (src.why ? ' (' + src.why + ')' : '');
    const asks = (a.asks || []).filter((x) => x.status === 'awaiting_exec').length;
    if (asks) return asks === 1 ? 'an ask is waiting for your approval' : asks + ' asks are waiting for your approval';
    return null;
  }

  function split(agents) {
    const failed = [], waiting = [], others = [];
    for (const a of agents || []) {
      const run = a.last_run;
      if (run && run.status === 'failed') { failed.push({ agent: a, reason: plainNote(run.note) }); continue; }
      const w = isPaused(a) ? null : waitingReason(a);
      if (w) { waiting.push({ agent: a, reason: w }); continue; }
      others.push({ agent: a, paused: isPaused(a), ran: !!(run && run.status && run.status !== 'failed') });
    }
    const pausedOrNotRun = others.filter((o) => o.paused || !o.ran).length;
    return { failed, waiting, others, ranFine: others.length - pausedOrNotRun, pausedOrNotRun };
  }

  // The folded line, worded as Mimi asked, and honest about paused members.
  function othersLine(b) {
    const n = b.others.length;
    if (!n) return '';
    if (!b.pausedOrNotRun) return n + (n === 1 ? ' other ran fine' : ' others ran fine') + ' · see the team';
    return b.ranFine + ' ran fine, ' + b.pausedOrNotRun + ' paused or not run yet · see the team';
  }

  return { split, othersLine, isPaused, oneLine, plainNote, waitingReason, REASON_MAX };
}));
