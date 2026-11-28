// ORDER #3923 (Mimi 11.28.2026, for Katherine: "visual schedule of whos running
// when"). The team's week as data the /agents page draws: seven day columns,
// today marked, every scheduled agent as a chip with its run time and its state
// in words. Pure: it reads the Producer's own calendar (lib/producer.js
// calendar/dueOn), the board, run history and the Producer's day log, and
// changes nothing. No schedule time, brake or rule is decided here.
//
//   daily    agents that run every day (PR Patty, Google Business), one band
//            across the top, each once, with today's state
//   days     Mon..Sun of this Nashville week; each column holds every weekly
//            and monthly agent due that day, exactly once
//   monthly  the monthly agents with their date ("15th", "3rd"), shown on the
//            column of that date when it falls in this week
//
// Run time: every scheduled agent runs from the one 06:00 CT launchd job
// (jobs/launchd/com.infinitybrain.marketing-agents.plist, Hour 6 Minute 0;
// jobs/agents_daily.sh runs jobs/agent_run.js --due). With PATTY_EVENING_RUN on,
// PR Patty runs on the HARO editions instead (jobs/launchd/
// com.infinitybrain.pr-patty-evening.plist, 16:00 to 18:15).
'use strict';

const P = require('./producer');

const RUN_TIME = '06:00';
const PATTY_EVENING_TIME = '16:00 to 18:15';
const WEEK = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

// The state words the chip carries beside its color, so color is never the only signal.
const WORDS = {
  ran: 'ran',
  due: 'due',
  paused: 'paused',
  held: 'held by the brake',
  failed: 'failed',
  waiting: 'waiting on input',
  none: 'no run recorded',
};

// The week that actually runs. With PRODUCER_CALENDAR on, the Producer's
// calendar (Katherine's moves included). Off, jobs/agent_run.js dueAgents():
// Google Business and PR Patty daily, five agents on Mondays, the Monthly
// Report on the 3rd, Citations on the 15th. The test pins this copy to
// dueAgents() day by day so the two cannot drift.
const LEGACY_WEEK = [
  { agent: 'gbp', days: ['daily'] },
  { agent: 'pr-patty', days: ['daily'] },
  { agent: 'site-health', days: ['mon'] },
  { agent: 'paid-ads', days: ['mon'] },
  { agent: 'scout', days: ['mon'] },
  { agent: 'seo', days: ['mon'] },
  { agent: 'convention-connector', days: ['mon'] },
  { agent: 'monthly-report', month_days: [3] },
  { agent: 'citations', month_days: [15] },
];
function liveCalendar(cal, env = process.env) {
  return P.producerOn(env) ? cal : LEGACY_WEEK.map((e) => ({ ...e }));
}

function runTime(agent, env = process.env) {
  if (agent === 'pr-patty' && require('./patty-evening').eveningOn(env)) return PATTY_EVENING_TIME;
  return RUN_TIME;
}

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

function addDays(ymd, k) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + k));
  return t.toISOString().slice(0, 10);
}

const nashvilleYmd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

// One agent's state on one day, from facts only.
//   boardRow  this agent's line on the Producer's board (state off/paused/own = not run)
//   logRows   the Producer's log for that day, this agent's rows
//   runs      this agent's runs, newest first
function stateOn({ day, ymd, boardRow, logRows = [], runs = [] }) {
  const last = logRows.slice(-1)[0];
  if (last && ['ran', 'failed', 'held', 'paused', 'waiting'].includes(last.decision)) return last.decision;
  const run = runs.find((r) => r && r.started_at && nashvilleYmd(r.started_at) === day);
  if (run) return run.status === 'failed' ? 'failed' : (run.status === 'running' ? 'due' : 'ran');
  const stopped = boardRow && ['off', 'paused', 'own'].includes(boardRow.state);
  if (stopped) return 'paused';
  return day >= ymd ? 'due' : 'none';
}

// weekView({ ymd, cal, board, history, logs, nameOf, env })
//   history  Map slug -> runs newest first
//   logs     Map ymd -> producer_log rows for that day
function weekView({ ymd, cal: producerCal = P.calendar(), board = [], history = new Map(), logs = new Map(), nameOf = (s) => s, env = process.env }) {
  const on = P.producerOn(env);
  const cal = liveCalendar(producerCal, env);
  const start = P.weekStart(ymd);
  const boardOf = new Map(board.map((b) => [b.slug, b]));
  const daily = cal.filter((e) => e.days && e.days.includes('daily'));
  const dailySet = new Set(daily.map((e) => e.agent));
  const entryOf = new Map(cal.map((e) => [e.agent, e]));
  const chip = (agent, day) => {
    const e = entryOf.get(agent) || {};
    const logRows = (logs.get(day) || []).filter((r) => r.agent === agent);
    const state = stateOn({ day, ymd, boardRow: boardOf.get(agent), logRows, runs: history.get(agent) || [] });
    const c = { agent, name: nameOf(agent), time: runTime(agent, env), state, word: WORDS[state], movable: on && P.movable(e) };
    if (e.month_days) c.on = e.month_days.map(ordinal).join(' and ');
    return c;
  };
  const days = WEEK.map(([key, label], i) => {
    const day = addDays(start, i);
    const due = P.dueOn(day, cal).filter((a) => !dailySet.has(a));
    return { key, label, ymd: day, mmdd: P.mmdd(day), today: day === ymd, chips: [...new Set(due)].map((a) => chip(a, day)) };
  });
  return {
    today: ymd,
    week_start: start,
    producer_on: on,
    run_time: RUN_TIME,
    daily: daily.map((e) => chip(e.agent, ymd)),
    days,
    monthly: cal.filter((e) => e.month_days).map((e) => ({ agent: e.agent, name: nameOf(e.agent), on: e.month_days.map(ordinal).join(' and '), time: runTime(e.agent, env) })),
  };
}

module.exports = { weekView, stateOn, runTime, ordinal, liveCalendar, LEGACY_WEEK, WORDS, RUN_TIME, PATTY_EVENING_TIME };
