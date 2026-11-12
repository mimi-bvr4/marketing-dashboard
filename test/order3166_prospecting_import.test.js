// ORDER #3166: after Mary picks the salesperson, the batch goes out through
// HubSpot's Prospecting Agent (Mary's tool). Our side hands her an import-ready
// CSV, a brief and a checklist, and records "Sent to HubSpot". It never writes
// to HubSpot. Fixtures and fakes only: nothing here reaches HubSpot or the web.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');

const desk = require('../lib/mary-desk');
const roster = require('../lib/sales-roster');
const access = require('../lib/access');
const hsImport = require('../lib/hubspot-import');
const { createMemoryStore } = require('../lib/agent-store');
const { createHandoffRouter } = require('../routes/handoff');
const { lint } = require('../lib/ai-tells');

const MARY = { email: 'mtopp@infinityhospitality.net', name: 'Mary Topp' };
const KATHERINE = { email: 'khowe@infinityhospitality.net', name: 'Katherine Howe' };
const PEOPLE = [
  { person_id: 'p_cam', name: 'Cameron Creasy', employment_title: 'Sales', primary_email: 'ccreasy@infinityhospitality.net' },
  { person_id: 'p_dan', name: 'Danielle Makram', employment_title: 'Sales', primary_email: 'danielle@dreameventsandcatering.com' },
];
const OWNERS = [
  { id: '79905153', firstName: 'Cameron', lastName: 'Creasy', email: 'ccreasy@infinityhospitality.net' },
  { id: '87853792', firstName: 'Danielle', lastName: 'Makram', email: 'danielle@dreameventsandcatering.com' },
];
const ROSTER = roster.buildRoster({ people: PEOPLE, owners: OWNERS });
const IDENTITY = { lookup: async (e) => ({
  [MARY.email]: { active: true, rung: 1, person_id: desk.MARY_PERSON_ID },
  [KATHERINE.email]: { active: true, rung: 2, person_id: access.KATHERINE_PERSON_ID },
}[e] || { active: false }) };
const NOW = new Date('2026-11-10T17:00:00Z');

// Two leads in one Planner Scout run. Lead 1 carries a publicly sourced person;
// lead 2 has none, so its person cells stay blank.
async function batch(store, { run_id = 9, email2 = 'Hello, we host galas in Nashville. Galas are our work. https://www.infinityevents.example' } = {}) {
  const ids = [];
  const leads = [
    { company: 'ZZ_TEST Peach Events', website: 'https://zz-test.example/peach', city: 'Atlanta', first_name: 'Ann', last_name: 'Lee', title: 'Owner', contact_email: 'ann@zz-test.example', phone: '404-555-0100',
      subject: 'Galas in Nashville', email: 'Hello Ann, we host galas in Nashville. Galas are our work. https://www.infinityevents.example' },
    { company: 'ZZ_TEST Magnolia, "Planning"', website: 'https://zz-test.example/mag', subject: 'Galas in Nashville', email: email2 },
  ];
  for (const s of leads) {
    const row = await store.insert({ agent: 'planner-scout', agent_name: 'National Planner Scout', job: 'planners', target: 'Atlanta', run_id,
      title: `${s.company}, Atlanta`, body: 'Published in Atlanta society coverage for galas.',
      sources: [{ label: 'ZZ_TEST feature', url: `https://zz-test.example/feature/${ids.length}`, ok: true }], payload: { sales: s } });
    const out = await store.decide(row.id, { action: 'approve', who: KATHERINE.email, reason: 'Gala fit' });
    assert.ok(!out.error, out.error);
    ids.push(row.id);
  }
  return ids;
}

async function withApp(store, who, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.mktUser = who; next(); });
  app.use(createHandoffRouter({ store, identity: IDENTITY, roster: async () => ({ people: ROSTER, why: null, where: 'sandbox' }), env: {}, now: () => NOW }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try { return await fn({ base, post }); } finally { srv.close(); }
}

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\r') { /* skip */ } else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else cur += ch;
  }
  return rows;
}

test('the headers are our portal\'s own contact property labels, so the importer maps every column', () => {
  assert.deepStrictEqual(hsImport.HEADERS, ['First Name', 'Last Name', 'Email', 'Phone Number', 'Company Name', 'Job Title', 'Website URL', 'City', 'Contact owner', 'Lead Source', 'Message']);
  // "Lead Source" is a dropdown in portal 49701209; an agent name is not an option, "Outreach Prospect" is.
  assert.strictEqual(hsImport.LEAD_SOURCE, 'Outreach Prospect');
  assert.ok(!hsImport.HEADERS.some((h) => /list/i.test(h)), 'the list is made by the import, never an unmappable column');
});

test('an assigned batch downloads one CSV row per lead, owner = the picked rep, list name in the file name', async () => {
  const store = createMemoryStore({ lint });
  const ids = await batch(store);
  await withApp(store, MARY, async ({ base, post }) => {
    const key = 'run-9';
    const before = await fetch(`${base}/api/handoff/import.csv?batch=${key}`);
    assert.strictEqual(before.status, 409, 'nothing assigned, nothing to import');
    assert.strictEqual((await post('/api/handoff/assign', { card_ids: ids, owner_id: '79905153' })).status, 200);
    const r = await fetch(`${base}/api/handoff/import.csv?batch=${key}`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/csv/);
    assert.match(r.headers.get('content-disposition'), /filename="KT batch National Planner Scout 11\.10\.2026\.csv"/);
    assert.strictEqual(r.headers.get('x-no-contact-person'), String(ids[1]));
    const rows = parseCsv(await r.text());
    assert.deepStrictEqual(rows[0], hsImport.HEADERS);
    assert.strictEqual(rows.length, 3);
    const rec = rows.slice(1).map((x) => Object.fromEntries(hsImport.HEADERS.map((h, i) => [h, x[i]])));
    assert.ok(rec.every((x) => x['Contact owner'] === 'ccreasy@infinityhospitality.net'), 'the owner column carries the picked rep');
    assert.ok(rec.every((x) => x['Lead Source'] === 'Outreach Prospect'));
    assert.deepStrictEqual([rec[0]['First Name'], rec[0]['Last Name'], rec[0].Email, rec[0]['Phone Number'], rec[0]['Job Title'], rec[0].City],
      ['Ann', 'Lee', 'ann@zz-test.example', '404-555-0100', 'Owner', 'Atlanta']);
    assert.strictEqual(rec[1]['Company Name'], 'ZZ_TEST Magnolia, "Planning"', 'commas and quotes survive');
    assert.match(rec[0].Message, /^Found by National Planner Scout\. Source: https:\/\/zz-test\.example\/feature\/0\. Card #\d+\.$/);
  });
});

test('KNOWN-BAD: a lead with no public business email has a blank Email cell; the outreach draft never lands there', () => {
  const card = { id: 5, agent: 'planner-scout', sources: [], assignment: { state: 'assigned' },
    payload: { sales: { company: 'ZZ_TEST Co', email: 'Hello, this is the draft text someone@zz-test.example', contact_email: 'not an email' } } };
  const { rows, noPerson } = hsImport.buildCsv([card], { ownerOf: () => ({ email: 'ccreasy@infinityhospitality.net' }) });
  assert.strictEqual(rows[0].Email, '');
  assert.deepStrictEqual(noPerson, [5]);
});

test('a cell that starts like a formula is defused', () => {
  assert.strictEqual(hsImport.cell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.strictEqual(hsImport.cell('+1 404'), "'+1 404");
});

test('the brief has no em dash, no capacity number and no dollar figure, and carries the guardrails', async () => {
  const store = createMemoryStore({ lint });
  const ids = await batch(store, { run_id: 11 });
  // Approve refuses em dashes; a capacity or price could still be in the text.
  const c = await store.get(ids[1]);
  c.payload.sales.email = 'Our ballroom seats 300 guests, packages from $12,500 and up to 450 standing. https://www.infinityevents.example';
  await store.assignCard(ids[0], desk.assignRecord(ROSTER[0], MARY, NOW.toISOString()));
  await store.assignCard(ids[1], desk.assignRecord(ROSTER[0], MARY, NOW.toISOString()));
  const [b] = desk.batches(await store.handoffDesk());
  const text = hsImport.brief(b);
  assert.ok(!/[—–]/.test(text), 'no em or en dash');
  assert.ok(!/\$\s?\d/.test(text), 'no dollar figure');
  assert.ok(!/\b\d+\s*(guests|standing|seated|people)\b/i.test(text), 'no capacity number');
  assert.match(text, /\[capacity removed\]/);
  assert.match(text, /\[price removed\]/);
  assert.match(text, /Do not: give a capacity number/);
  assert.match(text, /link to the one venue site/);
  assert.match(text, /Venue fit: https:\/\/www\.infinityevents\.example/);
  assert.match(text, /Main keywords and theme: .*galas/);
  assert.strictEqual(hsImport.scrub('A — B'), 'A, B');
});

test('the checklist is the five steps, names the list, and recommends "Review emails"', () => {
  const steps = hsImport.checklist({ agent_name: 'National Planner Scout' }, NOW);
  assert.strictEqual(steps.length, 5);
  assert.match(steps[0], /Create a list from this import.*KT batch National Planner Scout 11\.10\.2026/);
  assert.match(steps[1], /Contact owner/);
  assert.match(steps[2], /Send from contact owner/);
  assert.match(steps[3], /Review emails/);
  assert.match(steps[4], /Enroll by the list/);
});

test('"Sent to HubSpot": Mary marks it once; Katherine sees "In HubSpot, owner <name>"; Katherine cannot press it', async () => {
  const store = createMemoryStore({ lint });
  const ids = await batch(store, { run_id: 12 });
  await withApp(store, MARY, async ({ base, post }) => {
    assert.strictEqual((await post('/api/handoff/sent-to-hubspot', { card_ids: ids })).status, 409, 'not assigned yet');
    await post('/api/handoff/assign', { card_ids: ids, owner_id: '87853792' });
    const j = await (await fetch(base + '/api/handoff')).json();
    assert.ok(j.batches[0].prospecting, 'an assigned batch carries the brief and the steps');
    assert.strictEqual(j.batches[0].prospecting.checklist.length, 5);
    assert.strictEqual((await post('/api/handoff/sent-to-hubspot', { card_ids: ids })).status, 200);
    assert.strictEqual((await post('/api/handoff/sent-to-hubspot', { card_ids: ids })).status, 409, 'once');
  });
  await withApp(store, KATHERINE, async ({ base, post }) => {
    const j = await (await fetch(base + '/api/handoff')).json();
    assert.strictEqual(j.batches[0].state, 'in_hubspot');
    assert.strictEqual(j.batches[0].line, 'In HubSpot, owner Danielle Makram');
    assert.ok(j.batches[0].leads.every((l) => /^In HubSpot, owner Danielle Makram \(marked by Mary Topp, 11\/10\/2026\)$/.test(l.line)));
    assert.strictEqual((await post('/api/handoff/sent-to-hubspot', { card_ids: ids })).status, 403);
  });
});

test('Mary\'s seat reaches the import file and the "Sent to HubSpot" press, nothing more', () => {
  assert.ok(access.handoffSeatMay('GET', '/api/handoff/import.csv'));
  assert.ok(access.handoffSeatMay('POST', '/api/handoff/sent-to-hubspot'));
  assert.ok(!access.handoffSeatMay('POST', '/api/handoff/import.csv'));
});

test('no HubSpot write: the #3166 files name no HubSpot host and no write method', () => {
  for (const f of ['lib/hubspot-import.js', 'routes/handoff.js', 'public/handoff.html', 'lib/mary-desk.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/api\.hubapi\.com|hubspot\.com\/api/i.test(src), `${f} names a HubSpot API host`);
  }
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib/hubspot-import.js'), 'utf8');
  assert.ok(!/fetch\(|require\('https?'\)|method:\s*'(POST|PATCH|PUT|DELETE)'/.test(lib), 'the import module talks to no network');
});
