// ORDER #2962 (Mimi 11.04.2026): the agent that checks the humans who check the agents.
//
// "the #1 concern NB has is that we make all of these things and then the staff
// stop using them." Per department head who reviews an agent team, plain facts
// with counts and times, week vs the prior week, for Mimi and NB only.
//
// RULINGS (Mimi popups 11.04.2026): escalation goes straight to Mimi + NB, no
// nudge to the person; FACTS ONLY, no judgment words (labelWords() below is the
// check, and the test runs it over a rendered scorecard); no name yet.
//
// FENCES: READ ONLY on every agent table. It never approves, rejects, archives
// or edits a card and never contacts the person. It reads work-queue columns
// only (ids, agent, title, status, who, when, reason present or not, hand-off
// result); never a card body, payload text, compensation or an HR record.
// The ONE write is reviewer_visits: one row when a department head opens their
// Review or Agents page, and only while REVIEWER_WATCH is on.
//
// A MODULE: each department's agent team registers its tables and pages in
// DEPARTMENTS. Marketing (Katherine's team) is first; Baylee's property agents
// (#2866) register here next with their own reader.
//
// FEATURE FLAG: REVIEWER_WATCH default OFF. Off: the page and API answer 404
// and no visit is recorded. Turning it on is Mimi's popup.
'use strict';

const FLAG = 'REVIEWER_WATCH';
function watchOn(env = process.env) { return /^(1|on|true|yes)$/i.test(String(env[FLAG] || '').trim()); }

const TZ = 'America/Chicago';
const NOT_TRACKABLE = 'not trackable yet';
// Who decided a card when no person did. Their rows are counted apart, never as the head's.
const MACHINE_WHO = /archive-sweep|\(via the Box\)|^the Box\b|agent chain/i;

const DEPARTMENTS = [
  {
    key: 'marketing',
    name: 'Marketing',
    head: 'Katherine Howe',
    head_emails: ['katherine@infinityhospitality.net'],
    review_page: '/review',
    agents_page: '/agents',
    card_link: (id) => `/review#card-${id}`,
    // The pages whose GET counts as a visit by this department's head.
    visit_pages: ['/review', '/review.html', '/agents', '/agents.html'],
  },
];
function department(key) { return DEPARTMENTS.find((d) => d.key === key) || null; }

// ---------------------------------------------------------------- the words check
// Judgment words the scorecard must never carry (Mimi: "NO judgment labels ...
// this early"). Whole words, any case.
const LABEL_WORDS = ['grade', 'graded', 'rank', 'ranked', 'ranking', 'lazy', 'rubber-stamp', 'rubber-stamping', 'rubber stamping',
  'poor', 'poorly', 'excellent', 'great', 'good', 'bad', 'slow', 'slower', 'fast', 'faster', 'behind', 'neglect', 'neglected',
  'neglecting', 'ignored', 'ignoring', 'underperform', 'underperforming', 'best', 'worst', 'failing', 'lagging', 'overdue',
  'disengaged', 'unacceptable', 'concerning', 'should'];
function labelWords(text) {
  const t = String(text || '');
  return LABEL_WORDS.filter((w) => new RegExp(`(^|[^a-z])${w.replace(/[-\s]/g, '[-\\s]')}($|[^a-z])`, 'i').test(t));
}

// ---------------------------------------------------------------- time
const ymdOf = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
const mmddyyyy = (ymd) => `${ymd.slice(5, 7)}.${ymd.slice(8, 10)}.${ymd.slice(0, 4)}`;
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// The instant Nashville's day `ymd` starts (05:00 or 06:00 UTC).
function ctMidnight(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  for (const h of [5, 6]) {
    const t = new Date(Date.UTC(y, m - 1, d, h));
    const hh = Number(t.toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }));
    if (ymdOf(t) === ymd && hh % 24 === 0) return t;
  }
  return new Date(Date.UTC(y, m - 1, d, 6));
}
// Monday of the Nashville week holding `ymd`.
function mondayOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}
// The scorecard on a Monday covers the full week that just ended.
function weekFor(now) {
  const thisMonday = mondayOf(ymdOf(now));
  return addDays(thisMonday, -7);
}
const hours = (a, b) => Math.max(0, Math.floor((new Date(b) - new Date(a)) / 3600e3));
const inWin = (t, w) => t && new Date(t) >= w.from && new Date(t) < w.to;
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ---------------------------------------------------------------- what an approve became
// A ready card's hand-off, as a fact. Untrackable is said, never guessed.
function usedAfterApprove(card) {
  const h = card.handoff || null;
  const kind = card.kind;
  if (kind === 'pin') {
    if (!h) return 'pin not posted yet';
    return h.ok ? 'pin live' : `pin not posted${h.why ? ` (${h.why})` : ''}`;
  }
  if (kind === 'post') {
    if (!h) return 'WordPress draft not made yet';
    if (!h.ok) return 'WordPress draft not made';
    return `WordPress draft made; published: ${NOT_TRACKABLE}`;
  }
  if (kind === 'sales') {
    if (!h || h.pending) return 'HubSpot task not made yet';
    if (!h.ok) return 'HubSpot task not made';
    return `HubSpot task made; done: ${NOT_TRACKABLE}`;
  }
  return NOT_TRACKABLE;
}

// ---------------------------------------------------------------- the facts
// rows: { cards, runs, asks, settings, visits } as readRows() returns them.
// Everything here is a count, a time or a list of ids; nothing judges.
function facts({ dept, rows, from, to, now }) {
  const w = { from, to };
  const human = (who) => !!who && !MACHINE_WHO.test(who);
  const cards = rows.cards || [];

  const decided = cards.filter((c) => inWin(c.decided_at, w) && ['ready', 'rejected', 'archived'].includes(c.status));
  const byPerson = decided.filter((c) => human(c.decided_by));
  const machine = decided.filter((c) => !human(c.decided_by));
  const approved = byPerson.filter((c) => c.status === 'ready');
  const rejected = byPerson.filter((c) => c.status === 'rejected');
  const archived = byPerson.filter((c) => c.status === 'archived');
  const decideHours = byPerson.filter((c) => c.status !== 'archived').map((c) => hours(c.created_at, c.decided_at));
  const edited = cards.filter((c) => c.status === 'draft' && c.edited && inWin(c.decided_at, w) && human(c.decided_by)).length;

  const people = new Map();
  for (const c of byPerson) {
    const p = people.get(c.decided_by) || { who: c.decided_by, approved: 0, rejected: 0, archived: 0 };
    p[c.status === 'ready' ? 'approved' : c.status]++;
    people.set(c.decided_by, p);
  }

  const asks = (rows.asks || []).filter((a) => inWin(a.created_at, w));
  const edits = (rows.settings || []).filter((s) => inWin(s.created_at, w) && human(s.edited_by));
  const madeInWeek = cards.filter((c) => inWin(c.created_at, w)).length;
  const runsInWeek = (rows.runs || []).filter((r) => inWin(r.started_at, w));

  return {
    from: from.toISOString(), to: to.toISOString(),
    drafts_made: madeInWeek,
    runs: runsInWeek.length,
    decided_by_person: byPerson.length,
    approved: approved.length,
    rejected: rejected.length,
    rejected_with_reason: rejected.filter((c) => c.has_reason).length,
    rejected_without_reason: rejected.filter((c) => !c.has_reason).length,
    archived_by_person: archived.length,
    decided_by_machine: machine.length,
    drafts_edited: edited,
    hours_to_decide_median: median(decideHours),
    hours_to_decide_max: decideHours.length ? Math.max(...decideHours) : null,
    per_person: [...people.values()].sort((a, b) => a.who.localeCompare(b.who)),
    approved_use: approved.map((c) => ({ id: c.id, agent: c.agent, title: c.title, use: usedAfterApprove(c), link: dept.card_link(c.id) })),
    asks: asks.length,
    instruction_edits: edits.length,
    instruction_edits_by_agent: countBy(edits, 'agent'),
  };
}

function countBy(xs, k) {
  const m = {};
  for (const x of xs) m[x[k]] = (m[x[k]] || 0) + 1;
  return m;
}

// The state right now: backlog per agent, last visit, runs since it, oldest untouched.
function current({ dept, rows, now }) {
  const drafts = (rows.cards || []).filter((c) => c.status === 'draft');
  const byAgent = new Map();
  for (const c of drafts) {
    const a = byAgent.get(c.agent) || { agent: c.agent, name: c.agent_name || c.agent, waiting: 0, oldest_hours: 0 };
    a.waiting++;
    a.oldest_hours = Math.max(a.oldest_hours, hours(c.created_at, now));
    byAgent.set(c.agent, a);
  }
  const heads = new Set(dept.head_emails.map((e) => e.toLowerCase()));
  const visits = (rows.visits || []).filter((v) => heads.has(String(v.email).toLowerCase()) && new Date(v.at) <= now);
  const lastAt = (pages) => {
    const hits = visits.filter((v) => pages.includes(v.page)).map((v) => new Date(v.at).getTime());
    return hits.length ? new Date(Math.max(...hits)).toISOString() : null;
  };
  const lastReview = lastAt([dept.review_page, `${dept.review_page}.html`]);
  const lastAgents = lastAt([dept.agents_page, `${dept.agents_page}.html`]);
  const lastAny = [lastReview, lastAgents].filter(Boolean).sort().pop() || null;
  const runsSince = lastAny ? (rows.runs || []).filter((r) => new Date(r.started_at) > new Date(lastAny) && new Date(r.started_at) <= now).length : null;
  // Untouched: a draft nobody has edited or asked to redo, oldest first.
  const untouched = drafts.filter((c) => !c.edited && !c.has_redo).sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id)
    .slice(0, 3).map((c) => ({ id: c.id, agent: c.agent, title: c.title, age_hours: hours(c.created_at, now), link: dept.card_link(c.id) }));
  return {
    drafts_waiting: drafts.length,
    backlog: [...byAgent.values()].sort((a, b) => b.oldest_hours - a.oldest_hours || a.agent.localeCompare(b.agent)),
    visits_recorded: visits.length > 0,
    last_review_visit: lastReview, last_agents_visit: lastAgents,
    runs_since_last_visit: runsSince,
    oldest_untouched: untouched,
  };
}

function scorecard({ dept, rows, now = new Date(), weekStart }) {
  const ws = weekStart || weekFor(now);
  const wFrom = ctMidnight(ws), wTo = ctMidnight(addDays(ws, 7));
  const pFrom = ctMidnight(addDays(ws, -7));
  return {
    department: dept.key, department_name: dept.name, head: dept.head,
    week_start: ws, week_end: addDays(ws, 6), generated_at: new Date(now).toISOString(),
    week: facts({ dept, rows, from: wFrom, to: wTo, now }),
    prior: facts({ dept, rows, from: pFrom, to: wFrom, now }),
    now: current({ dept, rows, now }),
  };
}

// ---------------------------------------------------------------- the words
const ctStamp = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return `${mmddyyyy(ymdOf(d))} ${d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })} CT`;
};
const h = (n) => (n == null ? 'none decided' : `${n} h`);
const pair = (a, b) => `${a} (prior week ${b})`;

function renderMarkdown(cards, { base = '' } = {}) {
  const out = [];
  const first = cards[0];
  out.push(`# Reviewer facts, week of ${mmddyyyy(first.week_start)} to ${mmddyyyy(first.week_end)}`);
  out.push('');
  out.push('For Mimi and NB only. Counts and times from the agent tables. Nothing here was sent to anyone.');
  for (const s of cards) {
    const w = s.week, p = s.prior, n = s.now;
    out.push('', `## ${s.department_name}: ${s.head}`, '');
    out.push(`- Drafts the agents made: ${pair(w.drafts_made, p.drafts_made)}; agent runs: ${pair(w.runs, p.runs)}`);
    out.push(`- Cards decided by a person: ${pair(w.decided_by_person, p.decided_by_person)}`);
    out.push(`  - approved ${pair(w.approved, p.approved)}, rejected ${pair(w.rejected, p.rejected)}, archived ${pair(w.archived_by_person, p.archived_by_person)}`);
    out.push(`  - rejections with a reason ${w.rejected_with_reason}, without a reason ${w.rejected_without_reason}`);
    out.push(`  - drafts edited and left as drafts: ${w.drafts_edited}`);
    if (w.per_person.length) out.push(`  - by person: ${w.per_person.map((x) => `${x.who} approved ${x.approved}, rejected ${x.rejected}, archived ${x.archived}`).join('; ')}`);
    out.push(`- Cards closed by the system, not a person: ${pair(w.decided_by_machine, p.decided_by_machine)}`);
    out.push(`- Hours from draft to decision: median ${h(w.hours_to_decide_median)}, longest ${h(w.hours_to_decide_max)} (prior week median ${h(p.hours_to_decide_median)}). The time a card was first opened is not recorded.`);
    out.push(`- New abilities asked of agents: ${pair(w.asks, p.asks)}; instruction edits saved: ${pair(w.instruction_edits, p.instruction_edits)}`);
    if (w.approved_use.length) {
      out.push('- What each approved card became:');
      for (const a of w.approved_use) out.push(`  - #${a.id} ${a.agent}: ${a.use} (${base}${a.link})`);
    } else out.push('- What each approved card became: no cards approved this week.');
    out.push(`- Drafts waiting now: ${n.drafts_waiting}`);
    for (const b of n.backlog) out.push(`  - ${b.name}: ${b.waiting} waiting, oldest ${b.oldest_hours} h`);
    if (n.visits_recorded) {
      out.push(`- Last visit to the Review page: ${ctStamp(n.last_review_visit) || 'none recorded'}; to the Agents page: ${ctStamp(n.last_agents_visit) || 'none recorded'}`);
      out.push(`- Agent runs since the last visit: ${n.runs_since_last_visit}`);
    } else {
      out.push(`- Last visit to the Review and Agents pages: ${NOT_TRACKABLE} (visits are recorded from the day ${FLAG} is switched on)`);
      out.push(`- Agent runs since the last visit: ${NOT_TRACKABLE}`);
    }
    out.push('- The 3 oldest drafts nobody has edited or asked to redo:');
    if (!n.oldest_untouched.length) out.push('  - none');
    for (const u of n.oldest_untouched) out.push(`  - #${u.id} ${u.agent}, ${u.age_hours} h: ${u.title} (${base}${u.link})`);
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------- reads (Postgres)
// Narrow columns only. A card's body and payload text never leave the database:
// the payload is reduced to which hand-off kind it carries.
const READ_SQL = {
  cards: `SELECT id, agent, agent_name, title, status, edited, (reason IS NOT NULL AND btrim(reason) <> '') AS has_reason,
      (redo IS NOT NULL) AS has_redo, decided_by, decided_at, created_at, handoff,
      CASE WHEN payload ? 'pin' THEN 'pin' WHEN payload ? 'post' THEN 'post' WHEN payload ? 'sales' THEN 'sales' ELSE NULL END AS kind
    FROM agent_cards WHERE agent <> 'digest' AND (status = 'draft' OR decided_at >= $1 OR created_at >= $1)`,
  runs: "SELECT agent, started_at, status FROM agent_runs WHERE agent <> 'digest' AND started_at >= $1",
  asks: 'SELECT agent, asked_by, status, created_at FROM agent_asks WHERE created_at >= $1',
  settings: 'SELECT agent, version, edited_by, created_at FROM agent_settings WHERE created_at >= $1',
  visits: 'SELECT dept, page, email, at FROM reviewer_visits WHERE at >= $1',
};
async function readRows(pool, since) {
  const out = {};
  for (const [k, sql] of Object.entries(READ_SQL)) {
    try { out[k] = (await pool.query(sql, [since])).rows; }
    catch (e) { if (k === 'visits') out[k] = []; else throw e; }
  }
  return out;
}

// The one write: a visit row. Created additively; only called while the flag is on.
const VISITS_SQL = [
  `CREATE TABLE IF NOT EXISTS reviewer_visits (
    id SERIAL PRIMARY KEY, dept TEXT NOT NULL, page TEXT NOT NULL, email TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS idx_reviewer_visits ON reviewer_visits(dept, email, at DESC)',
];
async function ensureVisitTable(pool) { for (const q of VISITS_SQL) await pool.query(q); }
async function recordVisit(pool, { dept, page, email }) {
  await pool.query('INSERT INTO reviewer_visits (dept, page, email) VALUES ($1, $2, $3)', [dept, page, String(email).toLowerCase()]);
}

module.exports = {
  FLAG, watchOn, DEPARTMENTS, department, LABEL_WORDS, labelWords, NOT_TRACKABLE, MACHINE_WHO,
  ymdOf, ctMidnight, mondayOf, weekFor, addDays, usedAfterApprove, facts, current, scorecard, renderMarkdown,
  READ_SQL, readRows, VISITS_SQL, ensureVisitTable, recordVisit,
};
