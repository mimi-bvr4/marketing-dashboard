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
function seedText({ events, leads }, { topLeads = 50 } = {}) {
  const hm = (h) => (h ? `${h.figure} = ${h.label}${h.source ? ` (${h.source})` : ''}` : '(blank: no published figure)');
  const ev = eventsByMonth(events).map((e) => `- ${e.month ? MONTHS[e.month - 1] : 'month not confirmed'} | ${e.when || 'unverified'} | ${e.event} | ${e.org || 'unverified'} | venue: ${e.venue || 'unverified'} | ${e.confidence || ''} | how much: ${hm(e.how_much)} | source: ${e.source}`);
  const top = leadsLargestFirst(leads).slice(0, topLeads).map((l, i) => `${i + 1}. ${l.org} (${l.city || 'city unverified'}${l.outside_metro ? ', some events outside the metro' : ''}) | events as filed: ${l.events_named || '(none named)'} | how much: ${hm(l.how_much)}`);
  return `GALA SCOUT STARTING SET (research run 10.08.2026): ${events.length} recurring events, ${leads.length} large 990 event filers with no date yet.\n\n`
    + `## The ${events.length} events on the calendar, by month\n${ev.join('\n')}\n\n`
    + `## The ${top.length} largest undated 990 leads (date these first, largest first; each date needs its own source link)\n${top.join('\n')}`;
}

module.exports = { parse, load, seedText, leadsLargestFirst, eventsByMonth, leadAllEvents, MONTHS };
