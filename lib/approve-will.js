// ORDER #3570 (Katherine 11.18.2026 via Mimi): every Review card says, in one
// plain line above its buttons, what Approve will do. The words come from what
// the code actually does next with an approved card:
//
//   * a Sales email (payload.sales): jobs/agent_handoff.js makes one HubSpot
//     task (lib/hubspot-sales-task.js), or, with HANDOFF_VIA_MARY on, the card
//     goes to Mary Topp's /handoff desk first (lib/mary-desk.js);
//   * a pin (payload.pin): jobs/agent_handoff.js calls lib/pinterest.js
//     createPin on the Box's next run; with PINTEREST_SANDBOX on (Trial) it is
//     a sandbox pin only its creator can see;
//   * a blog post (payload.post): jobs/agent_handoff.js saves an unpublished
//     WordPress draft (lib/wp-draft.js sends status "draft" only);
//   * a proposed AI tell (payload.ai_tell): the verdict is recorded only
//     (lib/ai-tell-review.js);
//   * Keyword Queen topics (payload.topics): Approve only files the card; each
//     topic has its own Send button;
//   * anything else: status 'ready' and nothing more. Nothing reads it but the
//     seen-before memory and the counts.
//
// A card from a REPORT agent with no payload has no next step at all, so it
// shows "Got it" instead of Approve, and Got it is Archive (no action).
//
// This file only describes. It changes nothing Approve does.
'use strict';

// Agents whose cards are reports or FYI readouts: nothing to send, post or use
// as a draft. A card from one of these that carries a payload still shows Approve.
const REPORT_AGENTS = new Set(['digest', 'site-health', 'site-guardian', 'scout', 'seo', 'paid-ads', 'citations']);

const NO_OWNER = 'No salesperson set yet';
const DEFAULT_SALES = 'Cameron Creasy';

function kindOf(card) {
  const p = card && card.payload;
  if (p && p.ai_tell) return 'tell';
  if (p && p.sales) return 'sales';
  if (p && p.pin) return 'pin';
  if (p && p.post) return 'post';
  if (p && p.topics) return 'topics';
  if (REPORT_AGENTS.has(card && card.agent)) return 'report';
  return 'plain';
}

// { kind, got_it, line } for a draft card; null for any other status.
// `card.mary` and `card.sales_owner` are the fields routes/review.js already
// puts on a sales card before it reaches the page.
function approveWill(card) {
  if (!card || card.status !== 'draft') return null;
  const kind = kindOf(card);
  const p = card.payload || {};
  let line = null;
  if (kind === 'tell') line = 'record your verdict only. The ban list and the lint check do not change; adding the tell is a separate step, made on a branch.';
  else if (kind === 'sales' && card.mary) line = "send this lead to Mary Topp's Sales Hand-off desk. Nothing reaches HubSpot until she picks a salesperson, and nothing is emailed from here.";
  else if (kind === 'sales' && card.sales_owner === NO_OWNER) line = `keep it in Ready. ${NO_OWNER}, so no HubSpot task is made until Mimi or Katherine sets one.`;
  else if (kind === 'sales') {
    const who = card.sales_owner || DEFAULT_SALES;
    line = `make one HubSpot task for ${who} with this email word for word${p.sales.company ? `, linked to ${p.sales.company}` : ''}, on the Box's next run. ${who} sends it; nothing is emailed from here.`;
  } else if (kind === 'pin') line = `queue this pin for the Box's next run (it checks every 15 minutes)${p.pin.board ? `, board ${p.pin.board}` : ''}. While our Pinterest app is on Trial it is a sandbox pin, sandbox only until Pinterest grants Standard; nothing public.`;
  else if (kind === 'post') line = `save it as an unpublished WordPress draft on ${p.post.site || 'the site'}, on the Box's next run. Nothing is published; a person publishes it in WordPress.`;
  else if (kind === 'topics') line = 'file it as done. No topic goes to Bloggy Bob from Approve; each topic has its own Send button.';
  else if (kind === 'plain') line = 'file it as done, marked ready for you to use. Nothing is posted, sent or saved anywhere else.';
  return { kind, got_it: kind === 'report', line };
}

module.exports = { approveWill, kindOf, REPORT_AGENTS };
