'use strict';
// ORDER #3807 (Mimi 11.24.2026): the Executioner does approved actions.
//
// jobs/agent_handoff.js has always performed an approved card's action (the
// WordPress draft, the pin, the Google post). This module gives that work one
// name and one set of rules:
//   - it only ever acts on an APPROVED card (status 'ready'); the store's own
//     readyForHandoff / claimHandoff queries already refuse anything else;
//   - every result is written back on the card: link, id and the time in CT;
//   - a failure is written on the card in ONE line with the platform's own
//     error, and the card goes back to Review. At most one retry (two tries
//     per approval); a failure that cannot clear goes back at once;
//   - a "wait" (a setup step is missing, so the platform was never asked) is
//     not a failure: the card stays approved and counts as waiting;
//   - it never sends email. Sales cards (HubSpot tasks via Mary's desk) are not
//     its kind and keep their own rules.
//
// FEATURE FLAG: EXECUTIONER default OFF. Off: the hand-off behaves exactly as
// before (failures are logged and retried as they always were). The result
// stamp in CT and the read-only card on /agents are on either way.

const FLAG = 'EXECUTIONER';
const MAX_TRIES = 2; // the first try plus one retry
const KINDS = ['post', 'pin', 'gbp_post'];
const NAME = 'The Executioner';

function on(env = process.env) { return String(env[FLAG] || '').trim().toLowerCase() === 'on'; }

function kindOf(card) {
  const p = (card && card.payload) || {};
  if (p.sales) return null;
  if (p.gbp_post) return 'gbp_post';
  if (p.pin) return 'pin';
  if (p.post) return 'post';
  return null;
}

// "11.25.2026 11:42 CT", the house stamp.
function ctStamp(d) {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(t).map((x) => [x.type, x.value]));
  return `${parts.month}.${parts.day}.${parts.year} ${parts.hour}:${parts.minute} CT`;
}
function ctDay(d) { return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

// One line, the platform's own words, never a stack.
function oneLine(why) {
  const s = String(why || 'it failed and gave no reason').replace(/\s+/g, ' ').trim();
  return s.length > 240 ? `${s.slice(0, 237)}...` : s;
}

// What gets written back on the card after a success: link, id, time CT.
function result(kind, r, at) {
  const base = { by: 'executioner', at_ct: ctStamp(at) };
  // #3817: a post published live links to the live URL; a draft to its edit page.
  if (kind === 'post') return { ...base, link: r.live_link || r.edit_link || null, id: r.id != null ? String(r.id) : null };
  if (kind === 'pin') return { ...base, link: r.url || null, id: r.id != null ? String(r.id) : null };
  return { ...base, link: r.post_url || null, id: r.post_name || null };
}

// The approval this try belongs to. A new Approve starts the count again.
function approvalOf(card) { return card && card.decided_at ? new Date(card.decided_at).toISOString() : null; }

// After an action did not succeed. Returns what happened: 'waiting', 'retry'
// or 'returned'. With the switch off it does nothing and returns null, so the
// caller keeps its old behaviour.
async function afterFailure({ store, card, kind, r, at, env = process.env, log = () => {} }) {
  if (!on(env)) return null;
  const why = oneLine(r && r.why);
  const approval = approvalOf(card);
  if (r && r.wait) {
    await store.setExec(card.id, { approval, kind, waiting: why, waiting_since: (card.exec && card.exec.approval === approval && card.exec.waiting_since) || at, tries: (card.exec && card.exec.approval === approval && card.exec.tries) || 0 });
    log(`card ${card.id}: Executioner waiting: ${why}`);
    return 'waiting';
  }
  const prior = card.exec && card.exec.approval === approval ? Number(card.exec.tries) || 0 : 0;
  const tries = prior + 1;
  const final = !!(r && (r.skip || r.alarm)) || tries >= MAX_TRIES;
  if (!final) {
    await store.setExec(card.id, { approval, kind, tries, error: why, failed_at: at, failed_at_ct: ctStamp(at) });
    log(`card ${card.id}: Executioner try ${tries} failed, one retry left: ${why}`);
    return 'retry';
  }
  await store.returnToReview(card.id, { approval, kind, tries, error: why, failed_at: at, failed_at_ct: ctStamp(at), returned: true });
  log(`card ${card.id}: Executioner failed (${tries} ${tries === 1 ? 'try' : 'tries'}), back to Review: ${why}`);
  return 'returned';
}

// The line a Review card shows for the Executioner, or null.
function cardLine(card) {
  const e = card && card.exec; const h = card && card.handoff;
  if (card && card.status === 'draft' && e && e.returned) {
    return { state: 'failed', line: `Not done: ${e.error} (${e.failed_at_ct || ctStamp(e.failed_at)}). Back on Review; Approve again to try once more.` };
  }
  if (card && card.status === 'ready' && h && h.ok && h.at_ct) {
    // #3817: say plainly whether the blog went live, or why it is still a draft.
    if (h.published === true) return { state: 'done', line: `Published live ${h.at_ct}${h.id ? `, id ${h.id}` : ''}.`, link: h.link || null };
    if (h.published === false) return { state: 'done', line: `Saved as a draft ${h.at_ct}${h.id ? `, id ${h.id}` : ''}, not published: ${oneLine(h.publish_why)}`, link: h.link || null };
    return { state: 'done', line: `Done ${h.at_ct}${h.id ? `, id ${h.id}` : ''}.`, link: h.link || null };
  }
  if (card && card.status === 'ready' && !h && e && e.waiting) return { state: 'waiting', line: `Waiting: ${e.waiting}` };
  if (card && card.status === 'ready' && !h && e && e.tries) return { state: 'retry', line: `Try ${e.tries} failed: ${e.error}. It tries once more on the next run (every 15 minutes).` };
  return null;
}

// The Executioner's own card on /agents: done today, failed today, waiting.
function summary(rows, { now = new Date(), env = process.env } = {}) {
  const today = ctDay(now);
  const done = []; const failed = []; const waiting = [];
  for (const c of rows || []) {
    const h = c.handoff; const e = c.exec;
    if (c.status === 'ready' && h && h.ok && !h.pending && h.at && ctDay(h.at) === today) done.push(c);
    else if (c.status === 'draft' && e && e.returned && e.failed_at && ctDay(e.failed_at) === today) failed.push(c);
    else if (c.status === 'ready' && !h) waiting.push(c);
  }
  const item = (c) => ({ id: c.id, agent: c.agent, title: c.title, kind: c.kind, line: (cardLine(c) || {}).line || (c.status === 'ready' && !c.handoff ? 'Approved; the next run (every 15 minutes) does it.' : ''), link: c.handoff && c.handoff.link ? c.handoff.link : null });
  return {
    name: NAME, on: on(env), day: today,
    job: 'Does exactly what an approved card says: saves the blog draft, posts the Google post, pins the pin. It never acts on a card nobody approved, and it never sends email.',
    done: done.length, failed: failed.length, waiting: waiting.length,
    lists: { done: done.slice(0, 20).map(item), failed: failed.slice(0, 20).map(item), waiting: waiting.slice(0, 20).map(item) },
  };
}

module.exports = { FLAG, MAX_TRIES, KINDS, NAME, on, kindOf, ctStamp, oneLine, result, approvalOf, afterFailure, cardLine, summary };
