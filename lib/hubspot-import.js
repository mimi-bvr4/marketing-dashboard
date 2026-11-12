// ORDER #3166 (Mimi, 11.09.2026): "then mary needs to use her Hubspot
// Prospecting agent that is now in hubspot to send out the emails".
//
// After Mary picks the salesperson on the Sales Hand-off desk (#3165), our side
// hands her three things, and HubSpot is never written by us:
//   1. an import-ready CSV (one row per assigned lead) for HubSpot's contact import,
//   2. a "Prospecting Agent brief" she copies into the play,
//   3. a 5-step checklist.
// Mary imports, creates the list, sets up the play and enrolls, in HubSpot,
// herself. Humans send. Nothing in this file talks to the network.
//
// HEADERS are the LABELS of our portal's own contact properties, so the importer
// auto-maps them by label. Read from portal 49701209 on 11.10.2026 (read-only):
// "Contact owner" (hubspot_owner_id), "Lead Source" (lead_source, a DROPDOWN),
// "Company Name", "Job Title", "Website URL", "City", "Message". "First Name",
// "Last Name", "Email" and "Phone Number" are HubSpot's default contact labels.
//
// LEAD SOURCE: our portal's "Lead Source" is a dropdown. An agent's name is not
// one of its options, so a row carrying "National Planner Scout" there would be
// an import error. The row carries the existing option "Outreach Prospect", and
// the agent's name goes in "Message" beside the source link.
//
// LIST NAME: HubSpot makes the list in the import itself ("create a list from
// this import"), not from a column, so the list name is the FILE NAME and the
// checklist's step 1, never an unmappable column.
//
// NEVER GUESSED: a cell is filled only from a field the agent itself returned
// (payload.sales.first_name, last_name, title, contact_email, phone, city). The
// outreach DRAFT lives in payload.sales.email and never goes in the Email column.
'use strict';

const HEADERS = ['First Name', 'Last Name', 'Email', 'Phone Number', 'Company Name', 'Job Title', 'Website URL', 'City', 'Contact owner', 'Lead Source', 'Message'];
const LEAD_SOURCE = 'Outreach Prospect';

const day = (d) => {
  const t = d instanceof Date ? d : new Date(d);
  return t.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric' });
};

const clean = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
// A spreadsheet must not run a cell as a formula (CSV injection).
const safe = (v) => { const s = clean(v); return /^[=+\-@\t]/.test(s) ? `'${s}` : s; };
const cell = (v) => { const s = safe(v); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(e));

function importName(batch, at = new Date()) {
  return `KT batch ${clean(batch.agent_name || batch.agent)} ${day(at).replace(/\//g, '.')}`;
}
function fileName(batch, at) { return `${importName(batch, at).replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ')}.csv`; }

// card: an agent_cards row. owner: { email, name } of the salesperson Mary picked.
function row(card, owner, agentName) {
  const s = (card.payload && card.payload.sales) || {};
  const src = (card.sources || []).find((x) => x && x.url && x.ok !== false) || (card.sources || []).find((x) => x && x.url);
  return {
    'First Name': s.first_name, 'Last Name': s.last_name,
    Email: okEmail(s.contact_email) ? clean(s.contact_email) : '',
    'Phone Number': s.phone, 'Company Name': s.company, 'Job Title': s.title,
    'Website URL': s.website, City: s.city,
    'Contact owner': owner.email || owner.name || '',
    'Lead Source': LEAD_SOURCE,
    Message: `Found by ${clean(agentName || card.agent_name || card.agent)}${src ? `. Source: ${src.url}` : ''}. Card #${card.id}.`,
  };
}

// Only leads Mary has assigned go in the file. ownerOf(card) -> { email, name }.
function buildCsv(cards, { ownerOf, agentName } = {}) {
  const rows = []; const noPerson = [];
  for (const c of cards) {
    const a = c.assignment;
    if (!a || a.state !== 'assigned') continue;
    const r = row(c, ownerOf(c), agentName);
    if (!r['First Name'] && !r['Last Name'] && !r.Email) noPerson.push(c.id);
    rows.push(r);
  }
  const csv = [HEADERS.map(cell).join(','), ...rows.map((r) => HEADERS.map((h) => cell(r[h])).join(','))].join('\r\n') + '\r\n';
  return { csv, rows, noPerson };
}

// The brief may carry no em dash, no capacity number and no dollar figure.
function scrub(text) {
  return String(text || '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/(?:US)?\$\s?\d[\d,.]*\s*(?:k|K|m|M|million|thousand)?\b/g, '[price removed]')
    .replace(/\b\d[\d,]*\s*(?:dollars|USD)\b/gi, '[price removed]')
    .replace(/\b(?:up to|seats?|seating|capacity(?: of)?|holds?|accommodates?|fits?)\s+(?:up to\s+)?\d[\d,]*(?:\s*(?:guests|people|seated|standing))?/gi, '[capacity removed]')
    .replace(/\b\d[\d,]*\s*(?:-|to)?\s*\d*\s*(?:guests|people|attendees|seated|standing)\b/gi, '[capacity removed]');
}

const GUARDRAILS = [
  'Do: write as the salesperson, warm and short, one clear ask (a call or a tour).',
  'Do: link to the one venue site the lead fits, the venue\'s own site.',
  'Do: keep every fact that is in the approved email; add none.',
  'Do not: give a capacity number. Say "we can talk through your guest count".',
  'Do not: give a price or any dollar figure.',
  'Do not: use em dashes.',
  'Do not: claim an award, a review or a date that is not in the approved email.',
];

const SITE = /https?:\/\/[^\s)"'<>]+/g;
// batch: a desk batch (lib/mary-desk.js batches()).
function brief(batch) {
  const leads = batch.leads.filter((l) => l.state === 'assigned' || l.state === 'in_hubspot');
  const sites = [...new Set(leads.flatMap((l) => String(l.email || '').match(SITE) || []))];
  const lines = [
    `Batch: ${batch.agent_name}${batch.run_id ? `, run ${batch.run_id}` : ''}, ${leads.length} lead${leads.length === 1 ? '' : 's'}.`,
    `Target: ${batch.target || 'not set on the cards'}.`,
    `Main keywords and theme: ${batch.keywords.length ? batch.keywords.join(', ') : 'none counted'}.`,
    `Venue fit: ${sites.length ? sites.join(', ') : 'the approved emails name no venue site; pick the venue site that fits each lead'}.`,
    batch.approve_notes && batch.approve_notes.length ? `Katherine's note: ${batch.approve_notes.join(' / ')}.` : null,
    '',
    'Guardrails:', ...GUARDRAILS.map((g) => `- ${g}`),
    '',
    'The approved content:',
    ...leads.map((l) => `- ${l.company || l.title}: subject "${l.subject || ''}"\n${l.email || ''}`),
  ].filter((x) => x !== null);
  return scrub(lines.join('\n'));
}

function checklist(batch, at) {
  const name = importName(batch, at);
  return [
    `Import the CSV into HubSpot (Contacts, Import, one file, one object) and tick "Create a list from this import". Name the list "${name}".`,
    'Check the Contact owner column came through as the salesperson you picked.',
    'Prospecting Agent: use the play for this batch type, with "Send from contact owner". Paste the brief below into the play.',
    'Set the mode to "Review emails" (recommended), so the salesperson approves each email before it sends.',
    `Enroll by the list "${name}". Then press "Sent to HubSpot" here.`,
  ];
}

// The record "Sent to HubSpot" adds on an assigned card's assignment.
function sentRecord(who, at) { return { by: who.email, by_name: who.name || who.email, at }; }

module.exports = { HEADERS, LEAD_SOURCE, GUARDRAILS, importName, fileName, row, buildCsv, scrub, brief, checklist, sentRecord, cell };
