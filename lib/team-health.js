// ORDER #2918 (#2898 steps 3 and 4): the marketing team's daily health check,
// and the weekly improvement list for Mimi.
//
// The check, every morning, per team member: ran / missed a due run / blocked
// (a required source missing) / held by the Producer / not due, the drafts
// waiting and the oldest one's age, and any ask older than 24h with no answer.
// Alerts: a missed due run, an ask stuck past 24h, or 15 or more drafts waiting.
//
// It EXTENDS what is there and builds no second board: the due list is
// jobs/agent_run.js dueAgents() (or the Producer's calendar, lib/producer.js,
// when PRODUCER_CALENDAR is on); the runs are store.runHistory() (the same rows
// the Producer's "Who is stuck" board reads); the held days are the Producer's
// own log (store.producerDay). It shows on the Producer card (GET /api/producer
// .health) and its one line is printed by the 06:00 run (jobs/agent_run.js --due).
//
// READ ONLY, and narrow: it reads agent, status and time columns only. It never
// reads or returns a card's title, body, sources or payload, a source's reason,
// or the text of an ask, and it never approves, rejects, edits or deletes a card.
// The one write in this file is writeWeekly(): one new file per week under
// BRAIN_INBOX/_DROPS/awaiting, behind MARKETING_WEEKLY_LIST.
//
// FEATURE FLAG: MARKETING_WEEKLY_LIST default OFF. Off, the 06:00 run prints the
// health line and writes nothing. Turning it on is Mimi's popup.
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./producer');

const ASK_STUCK_HOURS = 24;
const DRAFTS_ALERT = 15;
const OLD_DRAFT_HOURS = 7 * 24;
// An ask is answered once it is sorted into a decision: building, built, applied,
// declined or "can't". These are the statuses that still owe Katherine an answer.
const OPEN_ASKS = ['new', 'sorting', 'awaiting_exec', 'failed'];
// Every store method the check may call. All reads.
const READS = ['runHistory', 'draftAges', 'listAsks', 'producerDay', 'calendarRows'];

const WEEKLY_FLAG = 'MARKETING_WEEKLY_LIST';
function weeklyOn(env = process.env) { return /^(1|on|true|yes)$/i.test(String(env[WEEKLY_FLAG] || '').trim()); }

const hoursBetween = (a, b) => Math.max(0, Math.floor((new Date(b) - new Date(a)) / 3600e3));
const ymdOf = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

// The live schedule for a Nashville day: the Producer's calendar when it is on,
// else the old dueAgents(). Paused and card-only members are never due.
async function dueList({ ymd, store, env }) {
  if (!P.producerOn(env)) return require('../jobs/agent_run').dueAgents(ymd);
  const { loadAgent } = require('./agent-runner');
  const cal = P.calendar(store.calendarRows ? await store.calendarRows() : []);
  return P.dueOn(ymd, cal).filter((s) => { try { const d = loadAgent(s); return !P.pausedFor(d) && !P.cardOnly(d); } catch (e) { return true; } });
}

// Whether a member's required source is missing: a "pending" source, or one the
// last run could not read. Only a yes or no leaves here, never the source.
function isBlocked(def, last) {
  if (last && last.status === 'blocked') return true;
  for (const src of (def.sources || []).filter((x) => x.required)) {
    const label = src.label || src.path || src.type;
    if (src.type === 'request' || /^the request\b/.test(label)) continue; // on-request members need an ask, not a source
    if (src.type === 'pending' && !P.pausedFor(def)) return true;
    if (last && (last.unavailable || []).some((u) => u.label === label)) return true;
  }
  return false;
}

async function teamHealth({ ymd, store, defs, due, now = new Date(), env = process.env }) {
  const dueSlugs = due || await dueList({ ymd, store, env });
  const history = new Map();
  for (const h of (await store.runHistory(20)) || []) {
    if (new Date(h.started_at) > now) continue;
    const a = history.get(h.agent) || []; a.push(h); history.set(h.agent, a);
  }
  const drafts = new Map(((await store.draftAges()) || []).map((d) => [d.agent, d]));
  const asks = ((await store.listAsks()) || []).filter((a) => OPEN_ASKS.includes(a.status) && new Date(a.created_at) <= now);
  const today = store.producerDay ? (await store.producerDay(ymd)) || [] : [];
  const members = defs.slice();
  for (const s of dueSlugs) if (!members.some((d) => d.slug === s)) members.push({ slug: s, name: s, sources: [] });

  const agents = members.map((d) => {
    const runs = (history.get(d.slug) || []).slice().sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    const last = runs[0] || null;
    const ranToday = runs.find((r) => ymdOf(r.started_at) === ymd) || null;
    const blocked = isBlocked(d, last);
    const isDue = dueSlugs.includes(d.slug);
    const heldToday = today.some((r) => r.agent === d.slug && ['held', 'paused'].includes(r.decision));
    let state;
    if (P.pausedFor(d) || P.cardOnly(d)) state = 'paused';
    else if (isDue && ranToday) state = ranToday.status === 'blocked' ? 'blocked' : 'ran';
    else if (isDue && heldToday) state = 'held';
    else if (isDue) state = 'missed';
    else state = blocked ? 'blocked' : 'not due';
    const dr = drafts.get(d.slug);
    const mine = asks.filter((a) => a.agent === d.slug && hoursBetween(a.created_at, now) > ASK_STUCK_HOURS);
    return {
      slug: d.slug, name: d.name || d.slug, due: isDue, state, blocked,
      last_run: last ? new Date(last.started_at).toISOString() : null,
      drafts: dr ? dr.n : 0,
      oldest_draft_hours: dr && dr.oldest ? hoursBetween(dr.oldest, now) : null,
      stuck_asks: mine.length,
      oldest_ask_hours: mine.length ? Math.max(...mine.map((a) => hoursBetween(a.created_at, now))) : null,
    };
  });

  const alerts = [];
  for (const a of agents) if (a.state === 'missed') alerts.push({ kind: 'missed', slug: a.slug, line: `${a.name} missed its due run` });
  for (const a of agents) if (a.stuck_asks) alerts.push({ kind: 'ask', slug: a.slug, line: `${a.name} has ${a.stuck_asks === 1 ? 'an ask' : `${a.stuck_asks} asks`} waiting ${a.oldest_ask_hours}h with no answer` });
  const waiting = [...drafts.values()].reduce((n, d) => n + (d.n || 0), 0);
  if (waiting >= DRAFTS_ALERT) alerts.push({ kind: 'drafts', slug: null, line: `${waiting} drafts are waiting for review (the alert starts at ${DRAFTS_ALERT})` });

  const dueRows = agents.filter((a) => a.due);
  const h = { ymd, due: dueSlugs, agents, alerts, drafts_waiting: waiting,
    due_count: dueRows.length, due_ran: dueRows.filter((a) => a.state === 'ran' || a.state === 'blocked').length,
    blocked_count: agents.filter((a) => a.blocked).length };
  h.line = summaryLine(h);
  return h;
}

// The one line for Mimi's morning page and the 06:00 log. No order numbers.
function summaryLine(h) {
  const head = `Marketing team ${P.mmdd(h.ymd)}: `;
  const al = h.alerts.length ? `${h.alerts.length} alert${h.alerts.length === 1 ? '' : 's'}: ${h.alerts.map((a) => a.line).join('; ')}.` : 'all clear.';
  const tail = `${h.due_ran} of ${h.due_count} due runs ran${h.blocked_count ? `, ${h.blocked_count} blocked` : ''}, ${h.drafts_waiting} drafts waiting.`;
  return `${head}${al} ${tail}`;
}

// ---------------------------------------------------------------- the weekly list
// From a week of checks: one line per character that needs something (which,
// what, why). A character with a clean week is not on the list.
function weeklyList({ weekStart, days }) {
  const by = new Map();
  for (const day of days) {
    for (const a of day.agents) {
      const w = by.get(a.slug) || { slug: a.slug, name: a.name, missed: 0, blocked: 0, ask: null, draft: null };
      if (a.state === 'missed') w.missed++;
      if (a.blocked) w.blocked++;
      if (a.oldest_ask_hours != null) w.ask = Math.max(w.ask || 0, a.oldest_ask_hours);
      if (a.oldest_draft_hours != null) w.draft = Math.max(w.draft || 0, a.oldest_draft_hours);
      by.set(a.slug, w);
    }
  }
  const lines = [];
  for (const w of by.values()) {
    const what = []; const why = [];
    if (w.missed) { what.push('look into the missed run'); why.push(`missed ${w.missed} due run${w.missed === 1 ? '' : 's'}`); }
    if (w.blocked) { what.push('connect the source it waits on'); why.push(`blocked on ${w.blocked} day${w.blocked === 1 ? '' : 's'}`); }
    if (w.ask != null) { what.push('answer its open ask'); why.push(`an ask waited ${w.ask}h with no answer`); }
    if (w.draft != null && w.draft >= OLD_DRAFT_HOURS) { what.push('review or clear its oldest drafts'); why.push(`oldest draft waited ${Math.floor(w.draft / 24)} days`); }
    if (what.length) lines.push({ slug: w.slug, name: w.name, what: what[0], why: why.join('; ') });
  }
  return { weekStart, lines };
}

function weeklyRecord({ weekStart, lines, stamp }) {
  return [
    `## [PREFERENCE] ${stamp}, marketing team week of ${P.mmdd(weekStart)}: what to improve`,
    '**DO:** read the list and pick what to fix first, or say "none this week". Nothing changes until you pick.',
    ...lines.map((l) => `- ${l.name}: ${l.what} (why: ${l.why})`),
    '**WHY IT\'S STUCK:** the daily team health check found these this week; each needs a person\'s choice (a schedule, a source, or an answer).',
    '**HOW LONG:** a minute to read.',
    '**WHAT IT UNBLOCKS:** next week runs without the same misses.',
    `**AGE:** ${stamp}.`,
    '',
  ].join('\n');
}

// ONE record per week: the file name carries the week, and a second write that
// week is refused (the file is opened with 'wx', so two runs cannot both write it).
function writeWeekly({ inbox, weekStart, days, stamp }) {
  const list = weeklyList({ weekStart, days });
  if (!list.lines.length) return { skipped: 'nothing to improve this week', lines: [] };
  if (!inbox) return { skipped: 'no project tree found, so no record was filed', lines: list.lines };
  const dir = path.join(inbox, '_DROPS', 'awaiting');
  const file = path.join(dir, `marketing_team_week_${weekStart}.md`);
  if (fs.existsSync(file)) return { skipped: 'this week already has its record', file, lines: list.lines };
  fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(file, weeklyRecord({ weekStart, lines: list.lines, stamp }), { flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') return { skipped: 'this week already has its record', file, lines: list.lines }; throw e; }
  return { file, lines: list.lines };
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// The week's checks, rebuilt from the run history and the Producer's log (no
// new table). Each past day is read as of 07:00 CT that morning; drafts are the
// ones still waiting now, so the list leans on the newest day for drafts.
async function weekDays({ weekStart, upTo, store, defs, now = new Date(), env = process.env }) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const ymd = addDays(weekStart, i);
    if (ymd > upTo) break;
    const morning = new Date(`${ymd}T13:00:00Z`);
    out.push(await teamHealth({ ymd, store, defs, now: morning < now ? morning : now, env }));
  }
  return out;
}

// The 06:00 step (jobs/agent_run.js --due, after the day's runs): print the one
// line; on Sunday, with MARKETING_WEEKLY_LIST on, file the week's record.
async function dailyStep({ ymd, store, defs, due, now = new Date(), log = console.log, inbox, env = process.env, stamp }) {
  const health = await teamHealth({ ymd, store, defs, due, now, env });
  log(`team health: ${health.line}`);
  let weekly = null;
  if (P.dowOf(ymd) === 'sun') {
    if (!weeklyOn(env)) weekly = { skipped: `${WEEKLY_FLAG} is off` };
    else {
      const weekStart = P.weekStart(ymd);
      const days = await weekDays({ weekStart, upTo: ymd, store, defs, now, env });
      weekly = writeWeekly({ inbox, weekStart, days, stamp: stamp || `${P.mmdd(ymd)}.${ymd.slice(0, 4)} ${now.toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' })} CT` });
    }
    log(`team weekly list: ${weekly.file ? `filed ${path.basename(weekly.file)}, ${weekly.lines.length} line(s)` : weekly.skipped}`);
  }
  return { health, weekly };
}

module.exports = {
  ASK_STUCK_HOURS, DRAFTS_ALERT, OLD_DRAFT_HOURS, OPEN_ASKS, READS, WEEKLY_FLAG, weeklyOn,
  dueList, isBlocked, teamHealth, summaryLine, weeklyList, weeklyRecord, writeWeekly, weekDays, dailyStep,
};
