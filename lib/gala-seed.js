// ORDER #3000 (Amendment A, Mimi 11.05.2026): the Gala Scout's starting set.
//
// The seed is the research already done for Katherine, not a new search:
// 07_Marketing_and_Brand/Gala_Scout/Nashville-Gala-Research-Report-11.05.2026.md
// (research run 10.08.2026). It holds 164 recurring galas and fundraisers in
// the 5 counties, each with a source link, and 220 IRS 990 event filers that
// have no date yet. This module reads that report's two tables into rows. It
// reads; it never writes the report and never fetches anything.
//
// "HOW MUCH" (Amendment A, change 1). Never a guess and never "ticket sales":
//   - a 990 lead carries its tax year and its ProPublica link, so its figure is
//     labelled "IRS-reported event gross (TY<year>)" with that link;
//   - a figure that covers several events of one org is labelled "all events",
//     never shown as one gala;
//   - a calendar row's 990 figure has no tax year and no link of its own in the
//     report, so it is labelled "tax year not in the seed" and carries no link
//     until the agent finds the filing. A blank stays blank.
'use strict';

const fs = require('fs');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const link = (s) => { const m = String(s).match(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/); return m ? { text: m[1], url: m[2] } : null; };
const unbold = (s) => String(s).replace(/\*\*/g, '').trim();
const blank = (s) => { const t = String(s || '').trim(); return t ? t : null; };

function eventHowMuch(gross) {
  const g = blank(gross);
  if (!g) return null;
  const all = /\(all events\)/i.test(g);
  return { figure: g.replace(/\s*\(all events\)/i, '').trim(), all_events: all,
    label: `IRS-reported event gross (tax year not in the seed)${all ? ', all events' : ''}`, source: null };
}

// A lead names "A · B + 3 other" when the org holds more than one event.
function leadAllEvents(named) {
  const n = String(named || '');
  return /·/.test(n) || /\+\s*\d+\s+other/i.test(n);
}

function parse(text) {
  const events = [];
  const leads = [];
  let section = null; // { kind: 'month', month } | { kind: 'unconfirmed' } | { kind: 'leads' }
  for (const raw of String(text).split(/\r?\n/)) {
    const h3 = raw.match(/^### (.+?)\s*$/);
    const h2 = raw.match(/^## (.+?)\s*$/);
    if (h2) { section = /^990 event filers not on the calendar/i.test(h2[1]) ? { kind: 'leads' } : null; continue; }
    if (h3) {
      const m = h3[1].match(/^([A-Z][a-z]+) ·/);
      if (m && MONTHS.includes(m[1])) section = { kind: 'month', month: MONTHS.indexOf(m[1]) + 1 };
      else if (/^Month not confirmed/i.test(h3[1])) section = { kind: 'unconfirmed' };
      else section = null;
      continue;
    }
    if (!section || !/^\|/.test(raw) || /^\|\s*-/.test(raw)) continue;
    const c = cells(raw);
    if (section.kind === 'leads') {
      const org = link(c[0]);
      if (!org) continue; // the header row
      const ty = blank(c[2]);
      const gross = blank(c[4]);
      const all = leadAllEvents(c[3]);
      leads.push({
        org: org.text, source: org.url, outside_metro: /⚑/.test(c[0]), city: blank(c[1]), tax_year: ty,
        events_named: blank(c[3]), all_event_gross: gross, largest_event_gross: blank(c[5]),
        how_much: gross ? { figure: gross, all_events: all, label: `IRS-reported event gross (TY${ty || ' unknown'})${all ? ', all events' : ''}`, source: org.url } : null,
        dated: false,
      });
      continue;
    }
    const src = link(c[7]);
    if (!src || /^Date found$|^Timing$/i.test(c[0])) continue;
    const when = blank(c[0]);
    events.push({
      month: section.kind === 'month' ? section.month : null,
      when, dated: /^\d{2}\.\d{2}\.\d{4}$/.test(when || ''),
      event: unbold(c[1]), org: blank(c[2]), venue: blank(c[3]), format: blank(c[4]), confidence: blank(c[5]),
      how_much: eventHowMuch(c[6]), source: src.url,
    });
  }
  return { events, leads };
}

function load(file) { return parse(fs.readFileSync(file, 'utf8')); }

// ORDER #3828: the second seed file, the Sophisticated Giving 2027 register
// (agents/gala-scout/seed/Sophisticated-Giving-2027-Register-11.25.2026.md).
// Three tables: new events, dated updates keyed exactly on a 10.08 row, and
// UNMATCHED pairs. It reads; it never fetches and never edits the 10.08 report.
const PITCH = 'likely booked; pitch 2028';
const monthOf = (s) => { const n = Number(blank(s)); return n >= 1 && n <= 12 ? n : null; };
const isDated = (when) => /^\d{2}\.\d{2}\.\d{4}/.test(when || '');

function parseRegister(text) {
  const head = (k) => { const m = String(text).match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'm')); return m ? m[1] : null; };
  const source = head('SOURCE');
  const source_page = head('PAGES');
  const caution = head('CAUTION');
  const events = [];
  const updates = [];
  const unmatched = [];
  let section = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const h2 = raw.match(/^## (.+?)\s*$/);
    if (h2) { section = /^New events/i.test(h2[1]) ? 'new' : /^Dated updates/i.test(h2[1]) ? 'updates' : /^Unmatched/i.test(h2[1]) ? 'unmatched' : null; continue; }
    if (!section || !/^\|/.test(raw) || /^\|\s*-/.test(raw)) continue;
    const c = cells(raw);
    if (section === 'new') {
      if (/^When/i.test(c[0])) continue;
      events.push({ month: monthOf(c[1]), when: blank(c[0]), dated: isDated(c[0]), event: c[2], org: blank(c[3]),
        venue: null, format: null, confidence: null, how_much: null,
        source, source_page, caution, pitch: blank(c[4]) === PITCH ? PITCH : null, origin: 'register-2027' });
    } else if (section === 'updates') {
      if (/^Seed event$/i.test(c[0])) continue;
      updates.push({ seed_event: c[0], seed_org: c[1], seed_when: c[2], when: blank(c[3]), month: monthOf(c[4]), register_name: blank(c[5]) });
    } else {
      if (/^Register event$/i.test(c[0])) continue;
      unmatched.push({ event: c[0], org: blank(c[1]), when: blank(c[2]), why: blank(c[3]) });
    }
  }
  return { source, source_page, caution, events, updates, unmatched };
}

function loadRegister(file) { return parseRegister(fs.readFileSync(file, 'utf8')); }

// New events are added; a dated update replaces a 10.08 row's date only when
// (event, org, date) match that row exactly. Anything else is UNMATCHED.
// The inputs are not mutated.
function mergeRegister(base, reg) {
  const events = base.events.map((e) => ({ ...e }));
  const applied = [];
  const unmatched = reg.unmatched.map((u) => ({ ...u }));
  for (const u of reg.updates) {
    const hits = events.filter((e) => e.event === u.seed_event && e.org === u.seed_org && e.when === u.seed_when);
    if (hits.length !== 1) {
      unmatched.push({ event: u.register_name || u.seed_event, org: u.seed_org, when: u.when,
        why: hits.length ? `${hits.length} seed rows share this key` : 'no seed row has this exact key' });
      continue;
    }
    const e = hits[0];
    Object.assign(e, { prior_when: e.when, prior_source: e.source, when: u.when, month: u.month, dated: isDated(u.when),
      source: reg.source, source_page: reg.source_page, caution: reg.caution, register_name: u.register_name, origin: 'register-2027' });
    applied.push({ event: e.event, org: e.org, from: e.prior_when, to: e.when });
  }
  return { events: events.concat(reg.events.map((e) => ({ ...e }))), leads: base.leads, applied, unmatched };
}

const money = (s) => Number(String(s || '').replace(/[^0-9.]/g, '')) || 0;

// The agent's standing work (Amendment A, change 2a): date the undated leads, largest first.
function leadsLargestFirst(leads) {
  return leads.slice().sort((a, b) => money(b.all_event_gross) - money(a.all_event_gross));
}

// Cards are per event, sorted by month (change 3); events with no month go last.
function eventsByMonth(events) {
  return events.slice().sort((a, b) => (a.month || 13) - (b.month || 13));
}

// The compact text the agent reads. The full report is over the runner's file cap,
// so the agent gets every event on one line and the top undated leads.
function seedText({ events, leads, applied, unmatched }, { topLeads = 50 } = {}) {
  const hm = (h) => (h ? `${h.figure} = ${h.label}${h.source ? ` (${h.source})` : ''}` : '(blank: no published figure)');
  // A register row is marked [R27]; the source, pages and caution are said once
  // in the legend, so the text stays inside the runner's file cap.
  const line = (e) => {
    const head = `- ${e.month ? MONTHS[e.month - 1] : 'month not confirmed'} | ${e.when || 'unverified'} | ${e.event} | ${e.org || 'unverified'}`;
    const pitch = e.pitch ? ` | ${e.pitch}` : '';
    if (e.origin === 'register-2027' && !e.prior_when) return `${head} | [R27] new${pitch}`;
    const was = e.prior_when ? ` | [R27] was ${e.prior_when}, 2026 venue and source:` : '';
    return `${head} | venue: ${e.venue || 'unverified'} | ${e.confidence || ''} | how much: ${hm(e.how_much)}${was} | source: ${e.prior_when ? e.prior_source : e.source}${pitch}`;
  };
  const ev = eventsByMonth(events).map(line);
  const top = leadsLargestFirst(leads).slice(0, topLeads).map((l, i) => `${i + 1}. ${l.org} (${l.city || 'city unverified'}${l.outside_metro ? ', some events outside the metro' : ''}) | events as filed: ${l.events_named || '(none named)'} | how much: ${hm(l.how_much)}`);
  const withReg = Array.isArray(applied);
  const r27 = withReg ? events.find((e) => e.origin === 'register-2027') : null;
  const added = withReg ? events.filter((e) => e.origin === 'register-2027' && !e.prior_when).length : 0;
  const legend = r27
    ? `[R27] = Sophisticated Giving Charity Register Nashville 2027 (${r27.source}, ${r27.source_page}): ${r27.caution}. It prints no venue, price or contact.\n\n`
    : '';
  const um = withReg && unmatched.length
    ? `\n\n## UNMATCHED: dated in [R27], no exact match in the starting set (a person confirms; do not merge)\n${unmatched.map((u) => `- ${u.event} | ${u.org || 'unverified'} | ${u.when || 'unverified'}`).join('\n')}`
    : '';
  return `GALA SCOUT STARTING SET (research run 10.08.2026${withReg ? `, plus [R27] read 11.25.2026: ${added} new events, ${applied.length} re-dated to 2027` : ''}): ${events.length} recurring events, ${leads.length} large 990 event filers with no date yet.\n\n${legend}`
    + `## The ${events.length} events on the calendar, by month\n${ev.join('\n')}\n\n`
    + `## The ${top.length} largest undated 990 leads (date these first, largest first; each date needs its own source link)\n${top.join('\n')}${um}`;
}

module.exports = { parse, load, parseRegister, loadRegister, mergeRegister, seedText, leadsLargestFirst, eventsByMonth, leadAllEvents, MONTHS, PITCH };
