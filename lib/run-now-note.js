// ORDER #2961 (parity with #2912): the Run-now "Optional request" box is for
// THIS run only. A request that asks to change an agent's standing behaviour
// must not silently become a one-off, so every Run-now box says so and offers
// "Make this permanent", which files an Ask. The Box sorts that Ask like any
// other (lib/agent-asks.js); an instruction change waits for Mimi to approve it.
// Rollback lever: revert this commit; the Run-now box goes back to run-only.
'use strict';

const RUN_ONCE_NOTE = 'This applies to this run only. To change it for good, use Ask for a new ability.';

// The words Mimi named ("change", "always", "from now on", "instead of") plus
// their close kin. Used only to highlight the note; the button is always there.
const STANDING_RE = /\b(change|changes|always|never again|from now on|going forward|instead of|every time|each time|permanent(ly)?|for good)\b/i;

function asksForStandingChange(text) {
  return STANDING_RE.test(String(text || ''));
}

function permanentAsk(text) {
  return `Make this permanent, a standing change to your instructions (asked from the Run-now box): ${String(text || '').trim()}`;
}

module.exports = { RUN_ONCE_NOTE, STANDING_RE, asksForStandingChange, permanentAsk };
