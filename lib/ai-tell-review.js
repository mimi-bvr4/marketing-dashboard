// ORDER #3015 (re-queue of #3010 item b): Katherine approves or rejects each
// proposed AI tell on the Review tab.
//
// WHERE THINGS LIVE. The Review tab runs on Railway; the hunt ledger
// (07_Marketing_and_Brand/AI_TELLS_HUNT_LEDGER.md) is in the synced tree on the
// Box, which Railway cannot reach. So:
//   * the Box posts each proposed tell as a card of its own kind (agent
//     'ai-tell-hunt', payload.ai_tell) through the card path every agent uses;
//   * the verdict is stored where the tab already stores card state
//     (agent_cards.status / decided_by / reason): approve = 'ready',
//     reject = 'rejected';
//   * `node jobs/ai_tell_hunt.js pull-verdicts` on the Box copies each verdict
//     into the ledger through the existing decide() and appendLedger(). Ledger
//     and duplicate rules are unchanged; pulling twice writes one row.
//
// APPROVE RECORDS THE VERDICT ONLY. Changing the ban list, lib/ai-tells.js and
// LIST_UPDATED stays a separate two-repo branch step (RE-PIN NOTE, #3010).
//
// WHO MAY PRESS: the Review tab's own rule, unchanged. The #1370 page gate lets
// only an exec or Katherine with a live SSO session reach /api/review, and the
// router records that person's email. Nothing here widens it.
//
// FEATURE FLAG: AI_TELL_HUNT default OFF. Off: no tell script on the page, the
// tell-card API answers 404, a tell card takes no verdict and nothing is posted.
// Rollback: unset AI_TELL_HUNT, or revert this branch's merge.
'use strict';

const H = require('./ai-tell-hunt');

const AGENT = 'ai-tell-hunt';
const AGENT_NAME = 'AI Tell Detective';
const JOB = 'proposed AI tell';
const MACHINE = 'the Box (Monday hunt)';
const SCRIPT_TAG = '<script src="/review-ai-tell.js" defer></script>\n';
const APPROVE_NOTE = 'Approve records your verdict only. It does not change the ban list or the lint check. Adding an approved tell to the list is a separate step, made on a branch. Reject is recorded and this tell is never proposed again.';

const on = (env = process.env) => H.huntOn(env);
function isTellCard(card) { return !!(card && card.payload && card.payload.ai_tell); }

// The card row for one proposal, in the shape store.insert takes.
function cardRow(proposal) {
  const c = H.cardOf(proposal);
  const lines = c.body.split('\n');
  lines[lines.length - 1] = APPROVE_NOTE;
  return { agent: AGENT, agent_name: AGENT_NAME, job: JOB, title: c.title, body: lines.join('\n'),
    sources: [], payload: { ai_tell: { key: c.key, proposal } }, seen_key: c.key };
}

// The verdict rule for a tell card. The store calls this instead of its own
// rule for any card that carries payload.ai_tell.
function decideTell(card, { action, who, reason } = {}, env = process.env) {
  if (!on(env)) return { error: 'The AI tell review is switched off (AI_TELL_HUNT).', status: 404 };
  if (!who) return { error: 'no person to record' };
  if (action !== 'approve' && action !== 'reject') return { error: 'An AI tell card is approved or rejected, nothing else.' };
  if (card.status !== 'draft') {
    const was = card.status === 'ready' ? 'approved' : card.status;
    return { error: `This tell was already ${was}${card.decided_by ? ` by ${card.decided_by}` : ''}. One verdict per tell.`, status: 409 };
  }
  const why = reason && String(reason).trim() ? String(reason).trim().slice(0, 500) : null;
  // No approveBlockers here: approving a tell publishes nothing, and the card's
  // examples are quoted evidence that may hold the very tells we ban.
  return { fields: { status: action === 'approve' ? 'ready' : 'rejected', decided_by: who, reason: why } };
}

const ymdCT = (d) => new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

// Box side: copy each recorded verdict into the hunt ledger, oldest first.
async function pullVerdicts({ store, ledgerFile }) {
  const cards = [...await store.list({ status: 'ready', agent: AGENT, limit: 200 }), ...await store.list({ status: 'rejected', agent: AGENT, limit: 200 })]
    .filter(isTellCard)
    .sort((a, b) => new Date(a.decided_at || 0) - new Date(b.decided_at || 0) || a.id - b.id);
  let ledger = H.readLedger(ledgerFile);
  const added = []; const skipped = [];
  for (const c of cards) {
    const verdict = c.status === 'ready' ? 'approve' : 'reject';
    const note = `Review card ${c.id}${c.reason ? `: ${c.reason}` : ''}`;
    const r = H.decide({ ledger, proposal: c.payload.ai_tell.proposal, verdict, who: c.decided_by, ymd: ymdCT(c.decided_at), note });
    if (r.error) { skipped.push({ id: c.id, why: r.error }); continue; }
    H.appendLedger(ledgerFile, r.entry);
    ledger = r.ledger;
    added.push(r.entry);
  }
  return { added, skipped };
}

// Box side: post one card per proposal not already on the tab.
async function postCards({ store, cards }) {
  const keys = cards.map((c) => c.key);
  const seen = new Set((keys.length ? await store.seenCards(AGENT, keys) : []).map((r) => r.seen_key));
  const posted = []; const already = [];
  for (const c of cards) {
    if (seen.has(c.key)) { already.push(c.key); continue; }
    posted.push(await store.insert(cardRow(c.proposal)));
    seen.add(c.key);
  }
  return { posted, already };
}

// The real (non-dry) hunt: pull verdicts, hunt against the ledger, post the
// new cards, record the run. Gated by AI_TELL_HUNT. Touches no ban list and
// no lint; writes only the ledger and the card store.
async function postHunt({ ask, store, banText, ledgerFile, today, env = process.env }) {
  if (!on(env)) throw new Error('AI_TELL_HUNT is off: posting proposed tells to the Review tab is switched off.');
  const pulled = await pullVerdicts({ store, ledgerFile });
  const hunt = await H.huntDry({ ask, banText, ledger: H.readLedger(ledgerFile), today });
  if (!hunt.ok) return { pulled, hunt, posted: [], already: [] };
  const { posted, already } = await postCards({ store, cards: hunt.cards });
  H.appendLedger(ledgerFile, { ymd: today, kind: 'run', who: MACHINE, key: '', note: `${hunt.summary}; ${posted.length} posted to Review` });
  return { pulled, hunt, posted, already };
}

module.exports = { AGENT, AGENT_NAME, JOB, MACHINE, SCRIPT_TAG, APPROVE_NOTE, on, isTellCard, cardRow, decideTell, ymdCT, pullVerdicts, postCards, postHunt };
