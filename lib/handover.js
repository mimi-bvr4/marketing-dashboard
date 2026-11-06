// ORDER #2993 (Mimi popups 11.05.2026): Katherine's handover reset, Mon 11.09.2026.
//
// "I want her to be able to see all of the old stuff as references of the
// capabilities, but I don't want them counting on her pile."
//
// A TIME RULE, NO DATA REWRITE. One setting, HANDOVER_AT (an ISO instant, e.g.
// 2026-11-09T00:00:00-06:00, Nashville midnight). Every card created before it,
// whatever its status, is a REFERENCE card: listed under "Examples from before
// handover" on the Review page, and left out of every waiting count (Drafts,
// the Producer's 15-hold, the Monday digest, the team health check, Ask about
// your team) and out of the reviewer facts (#2962). No card row is changed.
// Approve on a reference card still works and is still logged (decided_by,
// decided_at); it simply never counts, either way.
//
// ROLLBACK LEVER: unset HANDOVER_AT. With it unset (or unreadable) every
// function here answers "no handover" and behavior is exactly as before.
// The shared agent platform (#2963) takes this per team later.
'use strict';

const FLAG = 'HANDOVER_AT';
const REFERENCE_HEADER = "What each agent can do. These don't count toward your pile.";
const REFERENCE_TAB = 'Examples from before handover';
const BEFORE_LABEL = 'Before handover';

// The handover instant, or null when unset or unreadable.
function handoverAt(env = process.env) {
  const raw = String((env && env[FLAG]) || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A card made before the line. False whenever there is no line.
function isReference(card, at = handoverAt()) {
  if (!at || !card || card.created_at == null) return false;
  const t = new Date(card.created_at);
  return !Number.isNaN(t.getTime()) && t < at;
}

// The cards that count: all of them with no line, else those made on/after it.
function counted(cards, at = handoverAt()) {
  return at ? (cards || []).filter((c) => !isReference(c, at)) : (cards || []);
}

// Reference cards grouped by agent, newest first inside each group; groups in
// the order of their newest card.
function groupByAgent(cards) {
  const by = new Map();
  for (const c of cards || []) {
    const g = by.get(c.agent) || { agent: c.agent, agent_name: c.agent_name || c.agent, cards: [] };
    g.cards.push(c);
    by.set(c.agent, g);
  }
  const t = (c) => new Date(c.created_at).getTime() || 0;
  for (const g of by.values()) g.cards.sort((a, b) => t(b) - t(a) || b.id - a.id);
  return [...by.values()].sort((a, b) => t(b.cards[0]) - t(a.cards[0]) || String(a.agent).localeCompare(String(b.agent)));
}

module.exports = { FLAG, REFERENCE_HEADER, REFERENCE_TAB, BEFORE_LABEL, handoverAt, isReference, counted, groupByAgent };
