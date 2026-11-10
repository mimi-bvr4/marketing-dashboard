// ORDER #3165 (Mimi, 11.09.2026, Katherine meeting): "we will need to have that
// land on Mary's desk, each campaign or batch, mary needs to see what sales
// person would be best for it- she can open up the blast, read the content, see
// that main keywords or what it is and then decide".
//
// An approved sales card (Planner Scout, Gala Scout, Convention Charles, and any
// future outreach card that carries payload.sales) no longer goes straight to a
// salesperson. It waits on Mary Topp's Sales Hand-off desk (/handoff). Mary
// opens the batch, reads it, and picks the salesperson from the live roster
// (lib/sales-roster.js, HubSpot owner ids only, never free text). Only then
// does jobs/agent_handoff.js send it down the #2940/#3012 path, unchanged, to
// that owner id.
//
// A BATCH is one agent run (agent_cards.run_id): the cards a run made together.
// A LEAD is one card in it. Mary assigns a whole batch to one person, or splits
// it by lead, or sends leads back to Katherine with a note.
//
// The record lives on the card, agent_cards.assignment (JSONB, additive):
//   { state: 'assigned', owner_id, owner_name, by, by_name, at }
//   { state: 'sent_back', note, by, by_name, at }
// The store sets it with one guarded UPDATE, so a second assign is refused and
// can never cause a second hand-off.
//
// FEATURE FLAG: HANDOFF_VIA_MARY default ON (Mimi ruled it in the order:
// "Ship it ON, since Mimi ruled it"). HANDOFF_VIA_MARY=off puts back the #3012
// behaviour exactly (a Scout card goes to the owner id saved on the agent).
'use strict';

const FLAG = 'HANDOFF_VIA_MARY';
const WAITING = 'Waiting on Mary to pick a salesperson';
const DESK = 'Mary Topp';
// Mary Topp, Director of Revenue Operations. People spine id (dispatch
// people.person_id, read 11.10.2026) and HubSpot owner id (Owner_Directory,
// the order's roster line). She picks; she is never a pick herself.
const MARY_PERSON_ID = 'person_325956f2f429';
const MARY_OWNER_ID = '79618815';

function on(env = process.env) {
  return String(env[FLAG] == null ? '' : env[FLAG]).trim().toLowerCase() !== 'off';
}

const isSalesCard = (c) => !!(c && c.payload && c.payload.sales);
const assignmentOf = (c) => (c && c.assignment && typeof c.assignment === 'object' ? c.assignment : null);

// The assignment that lets the Box hand a card off, or null.
function assigned(c) {
  const a = assignmentOf(c);
  return a && a.state === 'assigned' && /^\d{1,20}$/.test(String(a.owner_id || '')) ? a : null;
}

const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric' });
};

// One card's state on the desk, and the line Katherine and Mary both read.
function leadState(c) {
  const a = assignmentOf(c);
  if (a && a.state === 'assigned') return { state: 'assigned', line: `Assigned to ${a.owner_name || `HubSpot owner ${a.owner_id}`} by ${a.by_name || a.by}, ${day(a.at)}` };
  if (c.status === 'ready' && !c.handoff) {
    if (a && a.state === 'sent_back') return { state: 'waiting', line: WAITING, resent: true };
    return { state: 'waiting', line: WAITING };
  }
  if (a && a.state === 'sent_back') return { state: 'sent_back', line: `Sent back to Katherine by ${a.by_name || a.by}, ${day(a.at)}${a.note ? `: ${a.note}` : ''}` };
  return { state: 'other', line: '' };
}

// The main keywords of a batch, counted from its own words. Plain counting, no
// model: the words that come up most, minus the common ones.
const STOP = new Set(('a an and are as at be been but by can do for from has have he her his how i if in into is it its '
  + 'just me more most my no not of on one or our out over she so some than that the their them then there these they '
  + 'this those to up us very was we were what when where which who will with would you your yours about after all also '
  + 'any back because before being both could each even every few first get go here him like make many may much must new '
  + 'now only other own same should since such take thank through too under until well while why yet hope love would '
  + 'best regards hello hi dear team planner planners email subject reply unsubscribe infinity hospitality group nashville').split(/\s+/));
function keywords(text, n = 6) {
  const counts = new Map();
  for (const w of String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[a-z][a-z'-]{2,}/g) || []) {
    const k = w.replace(/'s$/, '').replace(/^-+|-+$/g, '');
    if (k.length < 4 || STOP.has(k)) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);
}

function batchKey(c) { return c.run_id ? `run-${c.run_id}` : `card-${c.id}`; }

function leadOf(c) {
  const s = c.payload.sales;
  return {
    card_id: c.id, title: c.title, company: s.company || null, website: s.website || null, city: s.city || null,
    subject: s.subject || null, email: s.email || '', body: c.body || '', target: c.target || null,
    sources: (c.sources || []).filter((x) => x && (x.label || x.url)).map((x) => ({ label: x.label || null, url: x.url || null, ok: x.ok !== false })),
    approved_by: c.decided_by || null, approved_at: c.decided_at || null, approve_note: c.reason || null,
    handoff: c.handoff ? { ok: !!c.handoff.ok, pending: !!c.handoff.pending, owner_name: c.handoff.owner_name || null, why: c.handoff.why || null } : null,
    ...leadState(c),
  };
}

function batchStatus(leads) {
  const n = (s) => leads.filter((l) => l.state === s).length;
  if (n('waiting')) return { state: 'waiting', line: `${WAITING} (${n('waiting')} of ${leads.length} lead${leads.length === 1 ? '' : 's'})` };
  const names = [...new Set(leads.filter((l) => l.state === 'assigned').map((l) => l.line.replace(/^Assigned to (.*?) by .*$/, '$1')))];
  if (names.length && !n('sent_back')) return { state: 'assigned', line: `Assigned to ${names.join(' and ')}` };
  if (names.length) return { state: 'assigned', line: `Assigned to ${names.join(' and ')}; ${n('sent_back')} sent back` };
  if (n('sent_back')) return { state: 'sent_back', line: 'Sent back to Katherine' };
  return { state: 'other', line: '' };
}

// Cards (sales cards only) -> batches, newest first. Each batch carries what
// Mary reads to decide: source agent, the content, the keywords, the target,
// the leads with their sources, and Katherine's approve note.
function batches(cards, { names = new Map() } = {}) {
  const groups = new Map();
  for (const c of cards) {
    if (!isSalesCard(c)) continue;
    const k = batchKey(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const out = [];
  for (const [key, cs] of groups) {
    cs.sort((a, b) => a.id - b.id);
    const leads = cs.map(leadOf);
    const first = cs[0];
    const text = cs.map((c) => [c.title, c.body, c.payload.sales.subject, c.payload.sales.email].filter(Boolean).join('\n')).join('\n');
    const notes = [...new Set(leads.map((l) => l.approve_note).filter(Boolean))];
    out.push({
      key, run_id: first.run_id || null, agent: first.agent, agent_name: names.get(first.agent) || first.agent_name,
      job: first.job || null, target: [...new Set(cs.map((c) => c.target).filter(Boolean))].join('; ') || null,
      keywords: keywords(text), approved_by: [...new Set(leads.map((l) => l.approved_by).filter(Boolean))],
      approve_notes: notes, newest: cs.reduce((m, c) => (String(c.decided_at || c.created_at || '') > m ? String(c.decided_at || c.created_at || '') : m), ''),
      leads, ...batchStatus(leads),
    });
  }
  return out.sort((a, b) => (a.state === 'waiting') !== (b.state === 'waiting') ? (a.state === 'waiting' ? -1 : 1) : b.newest.localeCompare(a.newest));
}

// Mary's one morning line, or null when nothing waits.
function waitingLine(batchList) {
  const n = batchList.filter((b) => b.state === 'waiting').length;
  return n ? `${n} batch${n === 1 ? '' : 'es'} waiting for a salesperson on the Sales Hand-off desk` : null;
}

// The record an assign writes on a card. who = { email, name } from the session.
function assignRecord(owner, who, at) {
  return { state: 'assigned', owner_id: String(owner.owner_id), owner_name: owner.name, by: who.email, by_name: who.name || who.email, at };
}
function sendBackRecord(note, who, at) {
  return { state: 'sent_back', note: String(note || '').trim().slice(0, 500), by: who.email, by_name: who.name || who.email, at };
}

module.exports = { FLAG, WAITING, DESK, MARY_PERSON_ID, MARY_OWNER_ID, on, isSalesCard, assignmentOf, assigned, leadState,
  keywords, batches, batchStatus, waitingLine, assignRecord, sendBackRecord };
