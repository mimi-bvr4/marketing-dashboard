'use strict';
// ORDER #3948 (RULINGS_LEDGER, "MARKETING CARD HOLD UNTIL RELAUNCH", Mimi 11.28.2026
// ~10:20 AM CT): no agent files a card on Review until the whole team can do what
// it is supposed to do. Her words: "we dont need any of the cards until the full
// operation is running".
//
// FEATURE FLAG: MARKETING_RELAUNCH default OFF.
// Off (unset) = the hold is IN FORCE, which is what her ruling ships:
//   - lib/agent-store.js createPgStore().insert saves no card for the Marketing
//     department. What the agent found is kept as a dated report note
//     (agent_report_notes, the table #3814 already writes), so nothing is lost.
//   - jobs/agent_handoff.js: the Executioner pass (handoff) and the Producer's
//     handoffs (handoff-map fire) do nothing.
//   - The Team and Review pages show TEAM_LINE at the top.
// Unchanged by the hold: every agent still runs on its schedule and keeps its own
// snapshots; the Night Watch (site-guardian) is exempt and its alerts still go to
// Mimi first; the Google Ads monitor still pulls; nothing published is touched.
// On = the relaunch. Turning it on is Mimi's popup, nobody else's.
const FLAG = 'MARKETING_RELAUNCH';
const HOLD_DEPARTMENT = 'marketing';
// The Night Watch never files through this path today (brain-core
// box_jobs/site_guardian/watch.py writes guardian_state), but if it ever does,
// its alerts are never held.
const EXEMPT = Object.freeze(['site-guardian']);
const TEAM_LINE = 'The team is on hold while it is being finished. Nothing needs you. It comes back when Mimi relaunches it.';
const NOTE_PREFIX = 'Held while the team is on hold: ';

function relaunched(env = process.env) {
  return /^(1|on|true|yes)$/i.test(String((env || {})[FLAG] || '').trim());
}
function holdOn(env = process.env) { return !relaunched(env); }

// Does the hold keep this card off Review? Pure.
function holds(card, { env = process.env, department = HOLD_DEPARTMENT } = {}) {
  if (!holdOn(env)) return false;
  if (department !== HOLD_DEPARTMENT) return false;
  return !EXEMPT.includes(String((card || {}).agent || ''));
}

// The report note a held card becomes (title + body; the store stamps the department).
function noteFor(card) {
  return { agent: card.agent, agent_name: card.agent_name || card.agent, run_id: card.run_id || null,
    title: NOTE_PREFIX + String(card.title || '(untitled)'), body: String(card.body || '') };
}

// What the page reads (GET /api/card-hold).
function status(env = process.env) {
  const on = holdOn(env);
  return { hold: on, flag: FLAG, line: on ? TEAM_LINE : null };
}

module.exports = { FLAG, HOLD_DEPARTMENT, EXEMPT, TEAM_LINE, NOTE_PREFIX, relaunched, holdOn, holds, noteFor, status };
