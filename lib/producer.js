// ORDER #2900 (Mimi, popups 11.03.2026): the Producer, slice 1. The calendar,
// the brakes, and the board. Design: 05_AI_and_Brain/THINKING/
// 2026-10-24_marketing_team_v2.md sections 3 and 6A.
//
// The Producer runs on RULES, not on a model. It owns the week (which agent runs
// on which day), the brakes (a weekly card cap and a hold when too many drafts
// wait), and the board (one line per team member: ready, ran today, held,
// waiting on X since a date, or paused).
//
// What it NEVER does: write or edit copy, approve or reject a card, change an
// agent's instructions (those stay Mimi-approved, 10.11.2026), send, or spend.
// Moving a day on the calendar is a schedule change, not an instruction change,
// so Katherine may do it herself (ruling 2, 11.03.2026).
//
// FEATURE FLAG: PRODUCER_CALENDAR default OFF. While it is off, jobs/agent_run.js
// --due keeps the old dueAgents() schedule exactly, and every "could not run"
// card is still written. Turning it on is Mimi's popup.
'use strict';

const FLAG = 'PRODUCER_CALENDAR';
function producerOn(env = process.env) {
  return /^(1|on|true|yes)$/i.test(String(env[FLAG] || '').trim());
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

// The memo's proposed week (section 3, ruling 2). Bob and Paul run from the
// queue (slice 2, #2901), so they are not on the slice-1 calendar; the queued
// requests job still runs them within 15 minutes of an ask, as today. Paid Ads
// keeps its weekly slot but moves off Monday to spread the week.
const DEFAULT_WEEK = [
  { agent: 'pr-patty', days: ['daily'] },
  { agent: 'gbp', days: ['daily'] },
  { agent: 'seo', days: ['mon'] },
  { agent: 'site-health', days: ['mon'] },
  { agent: 'scout', days: ['mon'] },
  { agent: 'convention-connector', days: ['tue'] },
  { agent: 'paid-ads', days: ['thu'] },
  { agent: 'monthly-report', month_days: [3] },
  { agent: 'email', month_days: [3] },
  { agent: 'citations', month_days: [15] },
];

const WEEKLY_CAP = 25;
const WAITING_HOLD = 15;
// Ruling 2: PR Patty and RED reviews are never held. Google Business carries
// the RED review replies and cannot tell a RED review from a kind one before it
// runs, so the whole agent is exempt until slice 2 can split them.
const EXEMPT = {
  'pr-patty': 'press deadlines are never held',
  gbp: 'it carries the RED review replies, which are never held',
};

function dowOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// The Monday that starts this ymd's week (Nashville calendar days).
function weekStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const back = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - back);
  return t.toISOString().slice(0, 10);
}

function mmdd(ymdOrDate) {
  const s = ymdOrDate instanceof Date
    ? ymdOrDate.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    : String(ymdOrDate).slice(0, 10);
  return `${s.slice(5, 7)}.${s.slice(8, 10)}`;
}

// A weekly agent is one Katherine can move (not daily, not on a day of the month).
function movable(entry) {
  return !!entry && Array.isArray(entry.days) && entry.days.length > 0 && !entry.days.includes('daily');
}

// The default week with Katherine's moves laid over it. Only weekly agents move.
function calendar(overrides = []) {
  const byAgent = new Map(overrides.map((o) => [o.agent, o]));
  return DEFAULT_WEEK.map((e) => {
    const o = byAgent.get(e.agent);
    if (o && movable(e) && Array.isArray(o.days) && o.days.length) {
      return { ...e, days: o.days.slice(), moved_by: o.updated_by || null, moved_at: o.updated_at || null };
    }
    return { ...e };
  });
}

function checkMove(agent, days) {
  const e = DEFAULT_WEEK.find((x) => x.agent === agent);
  if (!e) return { error: 'this team member is not on the calendar' };
  if (!movable(e)) return { error: e.days ? 'a daily team member runs every day and cannot be moved' : 'a monthly team member runs on its day of the month and cannot be moved here' };
  const list = Array.isArray(days) ? days.map((d) => String(d).toLowerCase().slice(0, 3)) : [];
  const uniq = [...new Set(list)];
  if (!uniq.length || uniq.length > 3) return { error: 'pick one to three days of the week' };
  if (uniq.some((d) => !DAYS.includes(d))) return { error: 'that is not a day of the week' };
  return { days: uniq.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)) };
}

// Which agents fall on a Nashville calendar day. Exempt agents first, so a
// brake never stops them by running after the week filled up.
function dueOn(ymd, cal = calendar()) {
  const dow = dowOf(ymd);
  const dom = Number(ymd.slice(8, 10));
  const due = cal.filter((e) => (e.days && (e.days.includes('daily') || e.days.includes(dow)))
    || (e.month_days && e.month_days.includes(dom))).map((e) => e.agent);
  return [...due.filter((a) => EXEMPT[a]), ...due.filter((a) => !EXEMPT[a])];
}

// One brake decision. Pure; every number it uses is counted, never guessed.
function decide({ agent, waiting, used, maxCards, cap = WEEKLY_CAP, hold = WAITING_HOLD }) {
  if (EXEMPT[agent]) return { run: true, why: `never held: ${EXEMPT[agent]}` };
  if (waiting >= hold) return { run: false, why: `${waiting} drafts are waiting for review (the hold starts at ${hold})` };
  if (used + maxCards > cap) return { run: false, why: `this week already has ${used} of ${cap} scheduled cards and this run could add ${maxCards}` };
  return { run: true, why: null };
}

// The day's scheduled runs, with the brakes. runOne(agent) runs one agent and
// returns runAgent's result; the Producer only decides and records.
async function runDay({ ymd, store, runOne, maxCardsOf, log = () => {}, draftsWaiting }) {
  const cal = calendar(store.calendarRows ? await store.calendarRows() : []);
  const week = weekStart(ymd);
  let waiting = draftsWaiting ? await draftsWaiting() : await store.draftsWaiting();
  let used = await store.producerWeekCards(week);
  const out = [];
  for (const agent of dueOn(ymd, cal)) {
    const max = maxCardsOf(agent);
    const d = decide({ agent, waiting, used, maxCards: max });
    if (!d.run) {
      log(`${agent}: held by the Producer (${d.why})`);
      const row = { ymd, week_start: week, agent, decision: 'held', why: d.why, cards: 0 };
      await store.producerLog(row);
      out.push(row);
      continue;
    }
    const r = await runOne(agent);
    const cards = (r.cards || []).length;
    const decision = r.skipped ? 'paused' : (r.blocked ? 'waiting' : (r.ok ? 'ran' : 'failed'));
    const why = r.skipped ? r.skipped : (r.blocked ? `waiting on ${r.blocked.join('; ')}` : (r.ok ? d.why : r.error || null));
    const row = { ymd, week_start: week, agent, decision, why, cards };
    await store.producerLog(row);
    out.push(row);
    used += cards;
    waiting += cards;
  }
  return out;
}

// Where a blocked agent has been stuck since: the date the source declares
// (the v2 section 5 table), else the first run of the newest unbroken streak
// of runs that missed it.
function waitingSince(src, label, history) {
  if (src && src.since) return String(src.since).slice(0, 10);
  let since = null;
  for (const r of history) { // newest first
    if (!(r.unavailable || []).some((u) => u.label === label)) break;
    since = r.started_at;
  }
  return since;
}

function nextDay(entry, ymd) {
  if (!entry) return null;
  if (entry.days && entry.days.includes('daily')) return 'every day';
  if (entry.days) {
    const i = DAYS.indexOf(dowOf(ymd));
    for (let k = 1; k <= 7; k++) { const d = DAYS[(i + k) % 7]; if (entry.days.includes(d)) return DAY_NAMES[d]; }
  }
  if (entry.month_days) return `the ${entry.month_days.map((d) => d + (d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th')).join(' and ')}`;
  return null;
}

// The board: one line per team member. Built from what each agent declares and
// what the tables recorded; a line never says more than the rows show.
//   defs      [{ slug, name, sources }]  (loadAgent output, display name applied)
//   settings  Map slug -> current settings row (enabled, edited_by)
//   history   Map slug -> runs newest first ({ started_at, status, cards, unavailable })
//   today     this ymd's producer log rows
function board({ ymd, defs, settings = new Map(), history = new Map(), today = [], cal = calendar() }) {
  const entries = new Map(cal.map((e) => [e.agent, e]));
  return defs.map((d) => {
    const s = settings.get(d.slug);
    const runs = history.get(d.slug) || [];
    const last = runs[0] || null;
    const entry = entries.get(d.slug) || null;
    const when = nextDay(entry, ymd);
    const base = { slug: d.slug, name: d.name, on_calendar: !!entry, when: when || 'on request' };
    if (s && s.enabled === false) return { ...base, state: 'paused', line: `paused on the Agents page by ${s.edited_by}` };
    const required = (d.sources || []).filter((x) => x.required);
    const missing = [];
    for (const src of required) {
      const label = src.label || src.path || src.type;
      const lastMissed = last && (last.unavailable || []).some((u) => u.label === label);
      if (src.type === 'pending' || lastMissed) {
        const since = waitingSince(src, label, runs);
        missing.push(`${label}${since ? ` since ${mmdd(since)}` : ''}`);
      }
    }
    // The request is "required" for on-request agents; that is not being stuck.
    const stuck = missing.filter((m) => !/^the request\b/.test(m));
    if (stuck.length) return { ...base, state: 'waiting', line: `waiting on ${stuck.join('; ')}` };
    const held = today.filter((r) => r.agent === d.slug && r.decision === 'held').slice(-1)[0];
    if (held) return { ...base, state: 'held', line: `held today: ${held.why}` };
    const ranToday = !!last && new Date(last.started_at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) === ymd;
    if (ranToday && last.status === 'failed') return { ...base, state: 'failed', line: 'ran today and failed; the card says why' };
    if (ranToday) return { ...base, state: 'ran', line: `ran today, ${last.cards || 0} card${last.cards === 1 ? '' : 's'}` };
    if (last && last.status === 'failed') return { ...base, state: 'failed', line: `last run failed ${mmdd(new Date(last.started_at))}` };
    return { ...base, state: 'ready', line: entry ? `ready; next run ${when}` : 'ready when asked' };
  });
}

module.exports = {
  FLAG, producerOn, DAYS, DAY_NAMES, DEFAULT_WEEK, WEEKLY_CAP, WAITING_HOLD, EXEMPT,
  dowOf, weekStart, mmdd, movable, calendar, checkMove, dueOn, decide, runDay, waitingSince, nextDay, board,
};
