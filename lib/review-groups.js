// ORDER #3923 (Mimi 11.28.2026, for Katherine: cards readable at a glance).
// The Review pile in three groups, in this order, each with its count:
//
//   out     "Will go out when you approve"   posts, pins, blog publishes, Google posts
//   decide  "For you to read and decide"     scout batches, ad plans, SEO, topics, fixes
//   reports "Reports, nothing to do"         report cards (their one button is Got it)
//
// The group comes ONLY from the card's own action type: kindOf() in
// lib/approve-will.js, the same value the server sends as card.action.kind
// (routes/review.js, cardAction.actionLine). Never from the title. Pure.
'use strict';

const { kindOf } = require('./approve-will');

const GROUPS = [
  { key: 'out', label: 'Will go out when you approve' },
  { key: 'decide', label: 'For you to read and decide' },
  { key: 'reports', label: 'Reports, nothing to do' },
];

const OUT_KINDS = new Set(['post', 'pin', 'gbp_post']);

function groupOfKind(kind) {
  if (OUT_KINDS.has(kind)) return 'out';
  if (kind === 'report') return 'reports';
  return 'decide';
}

function groupOf(card) {
  const kind = card && card.action && card.action.kind ? card.action.kind : kindOf(card);
  return groupOfKind(kind);
}

// [{ key, label, count, ids }] in the fixed order; the counts add up to cards.length.
function groupCards(cards) {
  const out = GROUPS.map((g) => ({ ...g, count: 0, ids: [] }));
  const at = new Map(out.map((g) => [g.key, g]));
  for (const c of cards || []) { const g = at.get(groupOf(c)); g.count++; g.ids.push(c.id); }
  return out;
}

module.exports = { GROUPS, groupOf, groupOfKind, groupCards };
