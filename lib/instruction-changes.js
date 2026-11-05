// ORDER #2979 (Mimi popup 11.05.2026, "Hers go live, I'm notified."): an
// instruction change Katherine saves goes live on the agent's next run with no
// approval step; Mimi sees one line per change and can undo it in one click.
// Replaces the 10.11.2026 ruling (Mimi approves each instruction change first).
//
// WHAT CHANGES WITH THE SWITCH ON (FEATURE FLAG: INSTRUCTION_CHANGES_LIVE default OFF):
//   An Ask the Box sorts as "instructions" is saved as the agent's next version
//   by jobs/agent_asks.js (status 'applied'), instead of waiting as 'awaiting_exec'.
//   Off: it waits for an exec exactly as before. Edit instructions on /agents
//   already saved straight to a new version (#1658) and still does.
// WHAT DOES NOT DEPEND ON THE SWITCH (additive, read-only or exec-only):
//   the change list (GET /api/agents/changes), the before/after view, Undo
//   (exec only), and the change lines in the Monday reviewer-facts draft.
// UNCHANGED: "build" asks still become ORDERs; "cant" still goes to Rules; the
//   fence (drafts only, copy checks, no em dashes) is appended by
//   lib/agent-runner.js after any saved text, so no saved version can edit it.
// NO SENDS: Mimi is notified on the page and in the reviewer-facts draft only.
//
// ROLLBACK: unset INSTRUCTION_CHANGES_LIVE (asks wait for an exec again), or
// revert this commit; nothing here alters or deletes a saved version.
'use strict';

const FLAG = 'INSTRUCTION_CHANGES_LIVE';
function liveOn(env = process.env) { return /^(1|on|true|yes)$/i.test(String(env[FLAG] || '').trim()); }

// Item 5 of the order, word for word.
const COPY = 'Instruction changes go live on save. Mimi is notified and can undo.';

// Who saved a version when no person did (seeds, merges, the Box). Not listed as a change.
const MACHINE_WHO = /\(via the Box\)|^the Box\b|agent chain/i;

const UNDO_RE = /^Undo of version (\d+)\b/;
const undoNote = (version, who) => `Undo of version ${version} by ${who} (ORDER #2979)`;
function undoOf(note) { const m = UNDO_RE.exec(String(note || '')); return m ? Number(m[1]) : null; }
const askNote = (ask) => `ask #${ask.id} from ${ask.asked_by}, live on save (ORDER #2979)`;

const changeLink = (agent, version) => `/agents#change-${agent}-${version}`;

// rows: agent_settings rows (any agents, any order). Returns one line per change
// a person saved, newest first, with whether it was undone and whether Undo is
// still possible (only on the agent's current version, so Undo never throws
// away a later change).
function changeList(rows, { limit = 50 } = {}) {
  const byAgent = new Map();
  for (const r of rows) { const a = byAgent.get(r.agent) || []; a.push(r); byAgent.set(r.agent, a); }
  const out = [];
  for (const [agent, vs] of byAgent) {
    vs.sort((x, y) => x.version - y.version);
    const top = vs[vs.length - 1].version;
    const undone = new Map();
    for (const v of vs) { const u = undoOf(v.note); if (u) undone.set(u, v); }
    for (const v of vs) {
      if (!v.edited_by || MACHINE_WHO.test(v.edited_by)) continue;
      const u = undoOf(v.note);
      const by = undone.get(v.version);
      out.push({ agent, version: v.version, who: v.edited_by, at: v.created_at, note: v.note || null,
        is_undo: !!u, undo_of: u, undone_by: by ? by.edited_by : null, undone_at: by ? by.created_at : null,
        can_undo: v.version === top && !u && !by, link: changeLink(agent, v.version) });
    }
  }
  return out.sort((a, b) => new Date(b.at) - new Date(a.at) || b.version - a.version).slice(0, limit);
}

// A plain line diff (longest common subsequence). [{ op: ' ' | '-' | '+', line }]
function lineDiff(before, after) {
  const a = String(before || '').split('\n'), b = String(after || '').split('\n');
  if (a.length * b.length > 4e6) return [...a.map((line) => ({ op: '-', line })), ...b.map((line) => ({ op: '+', line }))];
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', line: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', line: a[i++] });
    else out.push({ op: '+', line: b[j++] });
  }
  while (i < n) out.push({ op: '-', line: a[i++] });
  while (j < m) out.push({ op: '+', line: b[j++] });
  return out;
}

// The version before `version`, or the repo default when it is version 1.
function priorOf(history, version, def) {
  const p = history.filter((v) => v.version < version).sort((x, y) => y.version - x.version)[0];
  if (p) return { version: p.version, skill_md: p.skill_md, enabled: p.enabled, max_cards: p.max_cards };
  return { version: 0, skill_md: def.skill, enabled: true, max_cards: def.max_cards || 3 };
}

// Undo: a NEW version copying the prior one (every save is a version, #1658),
// so History shows the change and the undo; nothing is deleted.
async function undoChange({ store, agent, version, def, who }) {
  const history = await store.settingsHistory(agent, 500);
  const v = history.find((x) => x.version === Number(version));
  if (!v) return { error: 'no such version', status: 404 };
  const top = Math.max(...history.map((x) => x.version));
  if (v.version !== top) return { error: 'A newer change was saved after this one. Use History to put back a version.', status: 409 };
  if (undoOf(v.note)) return { error: 'This is already an undo. Use History to put back a version.', status: 409 };
  const p = priorOf(history, v.version, def);
  return store.saveSettings(agent, { skill_md: p.skill_md, enabled: p.enabled, max_cards: p.max_cards, note: undoNote(v.version, who), who });
}

// Applies a sorted instruction ask while the switch is on. Returns the saved
// settings, or { stale: true } when the instructions moved since it was sorted.
async function applyAsk({ store, ask, triage, def }) {
  const cur = await store.currentSettings(ask.agent);
  if ((cur ? cur.version : 0) !== triage.base_version) return { stale: true };
  return store.saveSettings(ask.agent, { skill_md: triage.proposed_skill_md, enabled: cur ? cur.enabled : true,
    max_cards: cur ? cur.max_cards : (def.max_cards || 3), note: askNote(ask), who: ask.asked_by });
}

module.exports = { FLAG, liveOn, COPY, MACHINE_WHO, undoNote, undoOf, askNote, changeLink, changeList, lineDiff, priorOf, undoChange, applyAsk };
