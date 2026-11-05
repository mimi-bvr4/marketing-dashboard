// ORDER #2963: Marketing's department config for the shared agent-platform module.
// Every value here was a literal in the agent code before the module; each line
// names where it came from so parity can be checked against main.
// Not wired yet (slice 1): the in-repo agent code still runs as before.
'use strict';

const path = require('path');
const { defineDepartment } = require('../packages/agent-platform');

module.exports = defineDepartment({
  id: 'marketing',
  name: 'Marketing',
  // lib/reviewer-watch.js DEPARTMENTS[0]
  head: { name: 'Katherine Howe', emails: ['katherine@infinityhospitality.net'] },
  // Instruction (SKILL.md) changes wait for an exec; Mimi approves (10.11.2026, lib/producer.js header).
  instruction_approver: { name: 'Mimi Beaver', emails: ['mimi@infinityhospitality.net'] },
  // lib/agent-runner.js AGENTS_DIR: agents/<slug>/SKILL.md + agent.json
  agents_dir: path.join(__dirname, '..', 'agents'),
  skills_dir: path.join(__dirname, '..', 'agents'),
  review_gate: ['exec', 'head'],
  copy_checks: true,
  laws: ['finance read-only', 'compensation never', 'HubSpot prod read-only'],
  // lib/producer.js WEEKLY_CAP, WAITING_HOLD
  producer: { weekly_cap: 25, waiting_hold: 15 },
  // lib/agent-voices.js (#2955)
  voices: true,
  // jobs/kh_route.js pending(): ORDER_<date>_<n>_KH_<slug>.md
  build_route: { order_tag: 'KH', requester: 'Katherine Howe' },
  // server.js mounts and lib/reviewer-watch.js DEPARTMENTS[0]
  pages: { review: '/review', agents: '/agents', producer: '/api/producer' },
  visit_pages: ['/review', '/review.html', '/agents', '/agents.html'],
});
