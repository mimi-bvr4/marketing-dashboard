// ORDER #3539 (Mimi 11.17.2026, popup ruling on #3505: YES to boards:write on Trial,
// sandbox only). The ONE board-making call in the Pinterest code. RUNS ON THE BOX,
// inside lib/pinterest-connect.js syncAccounts.
//
// 🔴 THE FENCES (code, not prompt):
//   1. Only while PINTEREST_SANDBOX is on, and only for the Infinity Hospitality
//      Group account (TRIAL_ACCOUNT). Switch OFF: this file makes no call at all.
//   2. The host is the SANDBOX_API constant, never a base passed in, so it can
//      never reach the production host.
//   3. Exactly ONE board, named BOARD_NAME, and only when the sandbox account has
//      no board at all. Any run that finds a board (any name) makes none. A board
//      read that failed makes none either (no list, no board).
// The token is used in the Authorization header only, never logged or returned.
'use strict';

const pt = require('./pinterest');

const BOARD_NAME = 'IH Pin Publisher demo';
const BOARD_DESCRIPTION = 'Trial sandbox board for the Pinterest Standard-upgrade demo (ORDER #3539).';

// Returns { made: { id, name } } | { skip: why } | { failed: why }. Never throws.
async function ensureSandboxBoard({ token, venue, existing, fetchImpl = globalThis.fetch, env = process.env }) {
  if (!pt.sandboxOn(env)) return { skip: 'PINTEREST_SANDBOX is off' };
  if (String(venue || '').toUpperCase() !== pt.TRIAL_ACCOUNT) return { skip: `only the ${pt.TRIAL_ACCOUNT} account gets a sandbox board` };
  if (!Array.isArray(existing)) return { skip: 'the sandbox boards were not read this run' };
  if (existing.length) return { skip: `the sandbox already has a board (${existing.length})` };
  try {
    const r = await fetchImpl(`${pt.SANDBOX_API}/boards`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: BOARD_NAME, description: BOARD_DESCRIPTION }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id) return { failed: `Pinterest refused the sandbox board: ${j.message || r.status}` };
    return { made: { id: j.id, name: j.name || BOARD_NAME } };
  } catch (e) { return { failed: `Pinterest could not be reached for the sandbox board: ${e.message}` }; }
}

module.exports = { ensureSandboxBoard, BOARD_NAME };
