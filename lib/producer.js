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
// Slice 2 (ORDER #2901, the queue and the routing) is at the foot of this file,
// behind its own switch, PRODUCER_QUEUE.
//
// FEATURE FLAG: PRODUCER_CALENDAR default OFF. While it is off, jobs/agent_run.js
// --due keeps the old dueAgents() schedule exactly, and every "could not run"
// card is still written. Turning it on is Mimi's popup.
'use strict';

const { safeReason } = require('./safe-reason');

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
  // #3000: on the calendar, each OFF behind its own switch until Mimi turns it on.
  { agent: 'planner-scout', days: ['wed'] },
  { agent: 'gala-scout', days: ['wed'] },
  { agent: 'engagement-sleuth', days: ['fri'] },
  // #2903: the Monthly Report carries the email scorecard, so the Email agent
  // no longer has its own run on the 3rd (one report on the 3rd, not two).
  { agent: 'monthly-report', month_days: [3] },
  { agent: 'citations', month_days: [15] },
];

// ORDER #2903 (memo 6D): an agent whose agent.json names a "paused_until"
// source is paused while that source is still "pending". Paid Ads waits on the
// Google + Meta export Sheet: a paused agent is one line on the board, never a
// weekly "could not run" card. The pause ends by itself the day the source is
// connected (its type stops being "pending"); nobody has to remember to lift it.
// A person who presses Run now still gets the run and its card, as before.
function pausedFor(def) {
  const want = def && def.paused_until;
  if (!want) return null;
  const src = (def.sources || []).find((s) => (s.label || s.path || s.type) === want);
  if (!src || src.type !== 'pending') return null;
  return `paused until the ${want} exists${src.since ? `; waiting since ${mmdd(src.since)}` : ''}`;
}

// ORDER #2903 (memo 6E and ruling 5): a team member whose agent.json says
// "card_only" sits on the team page as a character card but is never run by
// the marketing runner (the Web Agent works on its own page; Site Guardian is
// built and run elsewhere). The value is the line the board shows.
function cardOnly(def) {
  return def && typeof def.card_only === 'string' && def.card_only.trim() ? def.card_only.trim() : null;
}

// ORDER #3000 (Mimi 11.05.2026): a new team member ships OFF. Its agent.json
// names its own switch ("switch": "AGENT_GALA_SCOUT"); until Mimi turns that
// switch on, it sits on the team page and on the calendar but is never run,
// scheduled or asked, and the board says so in one line. Turning it on is
// Mimi's popup. An agent with no "switch" is unaffected.
function switchOff(def, env = process.env) {
  const name = def && typeof def.switch === 'string' ? def.switch.trim() : '';
  if (!name) return null;
  if (/^(1|on|true|yes)$/i.test(String((env || {})[name] || '').trim())) return null;
  return `off until Mimi switches it on (${name})`;
}

const WEEKLY_CAP = 25;
const WAITING_HOLD = 15;
// Ruling 2: PR Patty and RED reviews are never held. Google Business carries
// the RED review replies, so it is never stopped and never counts against the cap.
const EXEMPT = {
  'pr-patty': 'press deadlines are never held',
  gbp: 'it carries the RED review replies, which are never held',
};

// ORDER #2909 (Mimi popup 11.03.2026, "Split it in the next piece"): while the
// 15-waiting hold is on, Google Business still runs but keeps only its RED
// review replies. Its profile post idea and its replies to kind reviews wait
// with the other held work. With the hold off, nothing changes.
//
// The agent can only tell a RED review after it reads the pulse, so it reads
// and drafts as usual, and code keeps the RED cards. RED is the agent's own
// rule, agents/gbp/SKILL.md line 12: "3 stars or below, or any review that
// mentions pricing, staff or a problem ... Mark the card title "RED"". So a
// card is RED when its title carries the word RED, the mark that rule asks
// for. Never from the star count alone.
const RED_TITLE = /\bRED\b/;
function isRedCard(c) { return !!c && RED_TITLE.test(String(c.title || '')); }
const HOLD_SPLIT = {
  gbp: {
    only: 'red',
    held: 'post ideas',
    keep: isRedCard,
    note: 'THE PRODUCER\'S HOLD IS ON (too many drafts are waiting for review). This run, draft ONLY the reply cards '
      + 'your instructions mark RED. Write no profile post idea and no reply to a kind review; they wait until the hold lifts.',
  },
};
// What the runner needs for a split run: which cards to keep, the line the
// agent reads, and what was held. null when the agent has no split.
function holdSplit(slug, only) {
  const s = HOLD_SPLIT[slug];
  return s && s.only === only ? { only: s.only, keep: s.keep, note: s.note, held: s.held } : null;
}

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
  // #2909: under the hold, a split agent runs for its never-held part only.
  if (HOLD_SPLIT[agent] && waiting >= hold) {
    const s = HOLD_SPLIT[agent];
    return { run: true, only: s.only, why: `RED review replies only; held: ${s.held}, ${waiting} waiting` };
  }
  if (EXEMPT[agent]) return { run: true, why: `never held: ${EXEMPT[agent]}` };
  if (waiting >= hold) return { run: false, why: `${waiting} drafts are waiting for review (the hold starts at ${hold})` };
  if (used + maxCards > cap) return { run: false, why: `this week already has ${used} of ${cap} scheduled cards and this run could add ${maxCards}` };
  return { run: true, why: null };
}

// The day's scheduled runs, with the brakes. runOne(agent) runs one agent and
// returns runAgent's result; the Producer only decides and records.
async function runDay({ ymd, store, runOne, maxCardsOf, log = () => {}, draftsWaiting, defOf, env = process.env }) {
  const cal = calendar(store.calendarRows ? await store.calendarRows() : []);
  const week = weekStart(ymd);
  let waiting = draftsWaiting ? await draftsWaiting() : await store.draftsWaiting();
  let used = await store.producerWeekCards(week);
  const out = [];
  for (const agent of dueOn(ymd, cal)) {
    // #2903: a paused agent is not run at all; the day's log says why.
    let def = null;
    if (defOf) { try { def = defOf(agent); } catch (e) { def = null; } }
    const pz = switchOff(def, env) || pausedFor(def) || (cardOnly(def) ? `not run here: ${cardOnly(def)}` : null);
    if (pz) {
      log(`${agent}: ${pz}`);
      const row = { ymd, week_start: week, agent, decision: 'paused', why: pz, cards: 0 };
      await store.producerLog(row);
      out.push(row);
      continue;
    }
    const max = maxCardsOf(agent);
    const d = decide({ agent, waiting, used, maxCards: max });
    if (!d.run) {
      log(`${agent}: held by the Producer (${d.why})`);
      const row = { ymd, week_start: week, agent, decision: 'held', why: d.why, cards: 0 };
      await store.producerLog(row);
      out.push(row);
      continue;
    }
    // #2909: with the hold off the call is exactly runOne(agent), as before.
    const r = d.only ? await runOne(agent, { only: d.only }) : await runOne(agent);
    const cards = (r.cards || []).length;
    const decision = r.skipped ? 'paused' : (r.blocked ? 'waiting' : (r.ok ? 'ran' : 'failed'));
    // #2910: a waiting row names each source's reason; a failed row's error is secret-free.
    const reasonOf = (l) => { const u = (r.unavailable || []).find((x) => x.label === l); return u && u.why ? `${l} (${safeReason(u.why, 120)})` : l; };
    const why = r.skipped ? r.skipped : (r.blocked ? `waiting on ${r.blocked.map(reasonOf).join('; ')}` : (r.ok ? d.why : (r.error ? safeReason(r.error, 300) : null)));
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
function board({ ymd, defs, settings = new Map(), history = new Map(), today = [], cal = calendar(), env = process.env }) {
  const entries = new Map(cal.map((e) => [e.agent, e]));
  return defs.map((d) => {
    const s = settings.get(d.slug);
    const runs = history.get(d.slug) || [];
    const last = runs[0] || null;
    const entry = entries.get(d.slug) || null;
    const when = nextDay(entry, ymd);
    const base = { slug: d.slug, name: d.name, on_calendar: !!entry, when: when || 'on request' };
    const off = switchOff(d, env);
    if (off) return { ...base, state: 'off', line: off };
    if (s && s.enabled === false) return { ...base, state: 'paused', line: `paused on the Agents page by ${s.edited_by}` };
    // #2903: a card-only team member and a paused one are one plain line each.
    const own = cardOnly(d);
    if (own) return { ...base, when: 'on its own', state: 'own', line: own };
    const pz = pausedFor(d);
    if (pz) return { ...base, state: 'paused', line: pz };
    const required = (d.sources || []).filter((x) => x.required);
    const missing = [];
    for (const src of required) {
      const label = src.label || src.path || src.type;
      const lastMissed = last && (last.unavailable || []).some((u) => u.label === label);
      if (src.type === 'pending' || lastMissed) {
        const since = waitingSince(src, label, runs);
        // #2910: the source's own reason, secret-free, so nobody reads a log.
        const u = lastMissed ? last.unavailable.find((x) => x.label === label) : null;
        const why = u && u.why ? safeReason(u.why, 120) : '';
        missing.push(`${label}${since ? ` since ${mmdd(since)}` : ''}${why ? ` (${why})` : ''}`);
      }
    }
    // #2910: a failed run says why; any other source the last run missed is named with its reason.
    const failedWhy = last && last.status === 'failed' && last.note ? `: ${safeReason(last.note, 140)}` : '';
    const reqLabels = new Set(required.map((src) => src.label || src.path || src.type));
    const extra = last ? (last.unavailable || []).filter((u) => !u.quiet && !reqLabels.has(u.label) && !/^the request\b/.test(u.label || '')).slice(0, 2)
      .map((u) => `${u.label}${u.why ? `: ${safeReason(u.why, 100)}` : ''}`) : [];
    const also = extra.length ? `; missing ${extra.join('; ')}` : '';
    // The request is "required" for on-request agents; that is not being stuck.
    const stuck = missing.filter((m) => !/^the request\b/.test(m));
    if (stuck.length) return { ...base, state: 'waiting', line: `waiting on ${stuck.join('; ')}` };
    const held = today.filter((r) => r.agent === d.slug && r.decision === 'held').slice(-1)[0];
    if (held) return { ...base, state: 'held', line: `held today: ${held.why}` };
    const ranToday = !!last && new Date(last.started_at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) === ymd;
    if (ranToday && last.status === 'failed') return { ...base, state: 'failed', line: failedWhy ? `ran today and failed${failedWhy}` : 'ran today and failed; the card says why' };
    if (ranToday) return { ...base, state: 'ran', line: `ran today, ${last.cards || 0} card${last.cards === 1 ? '' : 's'}${also}` };
    if (last && last.status === 'failed') return { ...base, state: 'failed', line: `last run failed ${mmdd(new Date(last.started_at))}${failedWhy}` };
    return { ...base, state: 'ready', line: entry ? `ready; next run ${when}` : 'ready when asked' };
  });
}

// ------------------------------------------------------------ slice 2: one queue, and routing
// ORDER #2901 (memo sections 3.2, 3.4 and 6B). Every ask (Katherine's Drive
// order, Run now, a chain) lands in ONE queue, agent_run_requests, with a
// priority; the request runner takes it in priority order. The chains that used
// to be called from the runner (lib/agent-chains.js) are routed from here, and
// Scout's blog move is a new route to Bloggy Bob. A Drive ask that names two or
// three team members becomes one queued run each (jobs/kh_route.js).
//
// FEATURE FLAG: PRODUCER_QUEUE default OFF. While it is off: the queue is taken
// oldest first, exactly as before; only the three chains of #1759 run (no Scout
// route, no per-run cap on the new-post chain); a Drive ask naming two agents is
// left for the lanes; Site Health keeps its duplicate titles. Turning it on is
// Mimi's popup.
const QUEUE_FLAG = 'PRODUCER_QUEUE';
function queueOn(env = process.env) {
  return /^(1|on|true|yes)$/i.test(String(env[QUEUE_FLAG] || '').trim());
}

// Memo 3.2: press deadlines and RED reviews first, then Katherine's own asks,
// then chains. A person's ask to PR Patty or Google Business is the deadline
// class (a press request or a review reply); a chain is never above a person.
const PRIORITY = { deadline: 1, person: 2, chain: 3 };
const DEADLINE_AGENTS = ['pr-patty', 'gbp'];
function priorityOf({ agent, chain } = {}) {
  if (chain) return PRIORITY.chain;
  return DEADLINE_AGENTS.includes(agent) ? PRIORITY.deadline : PRIORITY.person;
}

// The order the request runner takes queued rows in. Pure; ties go oldest first.
function orderQueue(rows) {
  const p = (r) => (Number.isInteger(r.priority) ? r.priority : priorityOf(r));
  return rows.slice().sort((a, b) => p(a) - p(b) || new Date(a.created_at) - new Date(b.created_at) || (a.id || 0) - (b.id || 0));
}

// After a run's cards are saved, the Producer routes them. Each route only ever
// QUEUES a draft run; a route failure never fails the run, it comes back as a note.
async function afterRun({ slug, cards, store, env = process.env, log = () => {} }) {
  if (!store || !store.chainRun || !cards || !cards.length) return null;
  const chains = require('./agent-chains');
  let r = null;
  try {
    if (slug === 'seo') r = { chain: chains.CHAIN_BOB, agent: 'Bloggy Bob', ...(await chains.seoToBob({ store, cards, env, log })) };
    else if (slug === 'citations') r = { chain: chains.CHAIN_PATTY, agent: 'PR Patty', ...(await chains.citationGapToPatty({ store, cards })) };
    else if (slug === 'scout' && queueOn(env)) r = { chain: chains.CHAIN_SCOUT_BOB, agent: 'Bloggy Bob', ...(await chains.scoutToBob({ store, cards, env })) };
    else return null;
  } catch (e) {
    log(`${slug}: chain did not run: ${e.message}`);
    return { note: `chain did not run: ${String(e.message).slice(0, 200)}`, queued: [], skipped: [] };
  }
  if (!r.queued.length && !r.skipped.length) return null;
  r.note = `${r.queued.length} ${r.agent} run${r.queued.length === 1 ? '' : 's'} queued`
    + (r.skipped.length ? `, ${r.skipped.length} not queued (${r.skipped.map((s) => `${s.item}: ${s.why}`).join('; ').slice(0, 300)})` : '');
  log(`${slug}: ${r.note}`);
  return r;
}

// Once a day, after the scheduled runs: the new-post route to Pinterest Paul.
async function dailyRoutes({ store, fetchImpl, env = process.env, log = () => {} }) {
  return require('./agent-chains').newPostsToPaul({ store, fetchImpl, log, cap: queueOn(env) });
}

// A Drive ask that names 2 or 3 team members is split; more than 3 is too broad
// to split by keyword and stays with the lanes.
const MAX_SPLIT = 3;
function splitAsk(agents) {
  const list = [...new Set(agents || [])];
  if (list.length < 2) return { split: false, why: list.length ? 'names one team member' : 'names no team member' };
  if (list.length > MAX_SPLIT) return { split: false, why: `names ${list.length} team members (more than ${MAX_SPLIT} is left for the lanes)` };
  return { split: true, agents: list };
}

// ------------------------------------------------------------ 6C: the fact-change fan-out
// ORDER #2902 (memo sections 2 #3 and 6C). When Katherine marks a Collateral
// Cadet answer "changed" (old wording -> new wording), the Producer queues one
// re-check each by Email (its approved drafts), Citations (the listings) and
// Google Business (the profile), and pre-fills the Change Log entry. Each
// re-check is a DRAFT run: it makes cards on the Review tab and nothing else.
// The Change Log entry is only a filled form; an area owner still approves it
// before staff see it (ruling 10.13).
//
// The Producer writes no copy here: the asks below are bookkeeping (what
// changed, where the Cadet found it). It never edits an agent's instructions.
//
// FEATURE FLAG: PRODUCER_FACT_CHANGE default OFF. Off, the Cadet page has no
// "This changed" button and the route refuses with 404, exactly as before.
const FACT_FLAG = 'PRODUCER_FACT_CHANGE';
function factChangeOn(env = process.env) {
  return /^(1|on|true|yes)$/i.test(String(env[FACT_FLAG] || '').trim());
}
const CHAIN_FACT = 'fact-change';
const FACT_AGENTS = [
  { agent: 'email', name: 'Email', job: 'Re-check your approved and waiting email drafts' },
  { agent: 'citations', name: 'Listings + Citations', job: 'Re-check the venue listings and directory facts' },
  { agent: 'gbp', name: 'Google Business', job: 'Re-check the Google Business profile text and the post ideas' },
];
const FACT_PLACES = 12;

function checkChange(raw, phrase) {
  const to = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (to.length < 1) return { error: 'type what it changed to' };
  if (to.length > 120) return { error: 'keep it under 120 characters' };
  if (phrase && to.toLowerCase() === String(phrase).trim().toLowerCase()) return { error: 'that is the same wording as before' };
  return { to };
}

// Where the Cadet found the old wording, as short lines for an agent's ask.
function factPlaces(result) {
  const out = [];
  for (const m of (result && result.materials) || []) if (m.status === 'FOUND') out.push(`${m.title}${m.company ? ` (${m.company})` : ''}`);
  for (const s of (result && result.sites) || []) for (const pg of s.pages || []) out.push(`${s.site}${pg.page || ''}`);
  return out;
}

// This agent's own cards (waiting for review, or approved) that still carry the
// old wording, each with the line that holds it. Read only: a card is never
// edited, approved or rejected here; the agent drafts a corrected NEW card.
const FACT_CARDS = 5;
const FACT_LINE = 220;
async function staleCards(agentStore, agent, phrase) {
  if (!agentStore.list) return [];
  const needle = String(phrase).toLowerCase();
  const out = [];
  for (const [status, label] of [['ready', 'approved'], ['draft', 'waiting for review']]) {
    for (const c of await agentStore.list({ status, agent, limit: 200 })) {
      const text = `${c.title || ''}\n${c.body || ''}`;
      if (!text.toLowerCase().includes(needle)) continue;
      const line = text.split(/\n+/).find((l) => l.toLowerCase().includes(needle)) || '';
      out.push({ title: String(c.title || 'untitled').slice(0, 120), state: label, line: line.trim().slice(0, FACT_LINE) });
    }
  }
  return out;
}

function factAsk({ before, after, job, places, cards = [] }) {
  const where = places.length
    ? `The Collateral Cadet found the old wording in:\n${places.slice(0, FACT_PLACES).map((p) => `- ${p}`).join('\n')}${places.length > FACT_PLACES ? `\n- and ${places.length - FACT_PLACES} more` : ''}`
    : 'The Collateral Cadet did not find the old wording in any material or website it could read.';
  const mine = cards.length
    ? `\n\nYour own cards that still say it:\n${cards.slice(0, FACT_CARDS).map((c) => `- "${c.title}" (${c.state}): ${c.line}`).join('\n')}${cards.length > FACT_CARDS ? `\n- and ${cards.length - FACT_CARDS} more` : ''}`
    : '';
  return `A venue fact changed: "${before}" is now "${after}". ${job} for the old wording. `
    + `For each place that still says "${before}", draft the corrected version for review. `
    + `Draft only: nothing is published, posted or sent. If nothing of yours says it, say so in one line.\n\n${where}${mine}`;
}

// The fan-out. cadetAsk is the Cadet search row (id, phrase, status, result).
// Every re-check is queued at Katherine's priority (a person's ask), and keyed
// on the search and the agent, so marking the same answer twice queues nothing new.
async function factChange({ cadetAsk, to, who, agentStore, env = process.env }) {
  if (!factChangeOn(env)) return { error: 'not turned on', status: 404 };
  if (!who) return { error: 'no person to record', status: 403 };
  if (!cadetAsk) return { error: 'no such search', status: 404 };
  if (cadetAsk.status !== 'done' || !cadetAsk.result) return { error: 'this search has not finished yet', status: 409 };
  const c = checkChange(to, cadetAsk.phrase);
  if (c.error) return { error: c.error, status: 400 };
  const places = factPlaces(cadetAsk.result);
  const lines = [];
  for (const a of FACT_AGENTS) {
    const cards = await staleCards(agentStore, a.agent, cadetAsk.phrase);
    const r = await agentStore.chainRun({ chain: CHAIN_FACT, key: `cadet-${cadetAsk.id}:${a.agent}`, agent: a.agent,
      ask: factAsk({ before: cadetAsk.phrase, after: c.to, job: a.job, places, cards }), priority: PRIORITY.person, requestedBy: who });
    lines.push(r.request ? { agent: a.agent, name: a.name, queued: true, request_id: r.request.id, own_cards: cards.length }
      : { agent: a.agent, name: a.name, queued: false, why: r.skipped || r.error || 'not queued' });
  }
  return { before: cadetAsk.phrase, after: c.to, places: places.length, lines };
}

// Katherine's "This changed" on one Cadet answer: record the mark, then fan
// out. The first mark stands: marking it again (even with other wording) queues
// nothing new and answers with what the first mark did.
async function cadetChanged({ id, to, who, cadetStore, agentStore, env = process.env }) {
  if (!factChangeOn(env)) return { error: 'not turned on', status: 404 };
  if (!who) return { error: 'no person to record', status: 403 };
  const a = await cadetStore.ask(id);
  if (!a) return { error: 'no such search', status: 404 };
  if (a.status !== 'done' || !a.result) return { error: 'this search has not finished yet', status: 409 };
  const c = checkChange(to, a.phrase);
  if (c.error && !a.changed_to) return { error: c.error, status: 400 };
  const m = await cadetStore.markChanged(id, c.to || a.changed_to, who);
  if (m.error) return m;
  const out = await factChange({ cadetAsk: a, to: m.mark.changed_to, who: m.mark.changed_by, agentStore, env });
  if (out.error) return out;
  return { ...out, first: m.first, changed_by: m.mark.changed_by, changed_at: m.mark.changed_at };
}

module.exports = {
  FACT_FLAG, factChangeOn, CHAIN_FACT, FACT_AGENTS, checkChange, factPlaces, staleCards, factAsk, factChange, cadetChanged,
  pausedFor, cardOnly,
  FLAG, producerOn, DAYS, DAY_NAMES, DEFAULT_WEEK, WEEKLY_CAP, WAITING_HOLD, EXEMPT, RED_TITLE, isRedCard, HOLD_SPLIT, holdSplit,
  switchOff, dowOf, weekStart, mmdd, movable, calendar, checkMove, dueOn, decide, runDay, waitingSince, nextDay, board,
  QUEUE_FLAG, queueOn, PRIORITY, DEADLINE_AGENTS, priorityOf, orderQueue, afterRun, dailyRoutes, MAX_SPLIT, splitAsk,
};
