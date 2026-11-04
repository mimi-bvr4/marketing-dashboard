// ORDER #2915: Katherine asks a question about her own team's data and gets a
// plain answer with links to the cards it used.
//
// READ ONLY, and ONLY her team's own cards and runs. No model, no web: a
// question is matched to one of a few fixed shapes and answered from the store
// (store.list, store.runHistory). A question that fits none of them says so and
// lists what it can answer. Nothing here writes; test/order2915_ask_her_data
// proves it by calling every route with a store that refuses any write.
//
// Shapes it answers:
//   waiting  "how many drafts are waiting"            drafts not yet decided
//   agent    "what did Scout find last week"          that member's cards in the window
//   approved "which cards did I approve this month"   Ready cards (by her, when she says I/me/my)
//   rejected "what did I reject last week"            Rejected cards
//   ran      "when did Scout last run"                that member's last runs
// Windows: today, yesterday, this week, last week, this month, last month,
// last 7 / 30 days. Weeks start Monday, Nashville time.
'use strict';

const { weekStart } = require('./producer');

const TZ = 'America/Chicago';
const LIST_MAX = 10;
const STATUS_WORD = { draft: 'waiting', ready: 'approved', rejected: 'rejected', archived: 'archived' };

const CAN_ANSWER = [
  'How many drafts are waiting?',
  'What did Scout find last week?',
  'Which cards did I approve this month?',
  'What did I reject last week?',
  'When did PR Patty last run?',
];

const ymdOf = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function monthStart(ymd, back = 0) {
  const [y, m] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 - back, 1));
  return t.toISOString().slice(0, 10);
}

// The time window a question names, as inclusive Nashville dates, or null.
function windowOf(q, today) {
  if (/\btoday\b/.test(q)) return { from: today, to: today, label: 'today' };
  if (/\byesterday\b/.test(q)) { const y = addDays(today, -1); return { from: y, to: y, label: 'yesterday' }; }
  if (/\bthis week\b/.test(q)) return { from: weekStart(today), to: today, label: 'this week' };
  if (/\blast week\b/.test(q)) { const s = addDays(weekStart(today), -7); return { from: s, to: addDays(s, 6), label: 'last week' }; }
  if (/\bthis month\b/.test(q)) return { from: monthStart(today), to: today, label: 'this month' };
  if (/\blast month\b/.test(q)) return { from: monthStart(today, 1), to: addDays(monthStart(today), -1), label: 'last month' };
  const m = q.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/);
  if (m) { const n = Math.max(1, Number(m[1])); return { from: addDays(today, -(n - 1)), to: today, label: `in the last ${n} days` }; }
  return null;
}

const inWindow = (d, w) => { if (!w) return true; if (!d) return false; const y = ymdOf(d); return y >= w.from && y <= w.to; };

// Which team member a question names: their slug, their name, or the name Katherine gave them.
function memberOf(q, members) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const text = ` ${norm(q)} `;
  let best = null;
  for (const m of members) {
    for (const n of [m.name, m.default_name, m.slug.replace(/-/g, ' ')]) {
      const k = norm(n);
      if (k && text.includes(` ${k} `) && (!best || k.length > best.len)) best = { member: m, len: k.length };
    }
  }
  return best ? best.member : null;
}

function shapeOf(q, member, w) {
  if (/\b(approv\w*|ready)\b/.test(q)) return 'approved';
  if (/\breject\w*\b/.test(q)) return 'rejected';
  if (/\b(run|ran|runs|running)\b/.test(q) && (member || /\blast\b/.test(q))) return 'ran';
  if (/\b(waiting|pending|undecided|to review|need(s)? review|not decided)\b/.test(q)) return 'waiting';
  if (member) return 'agent';
  if (/\b(drafts?|cards?)\b/.test(q)) return w ? 'cards' : 'waiting';
  return null;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const cardLink = (c) => `/review?status=${encodeURIComponent(c.status)}#card-${c.id}`;
const cardView = (c, names) => ({ id: c.id, title: c.title || '(untitled)', member: names.get(c.agent) || c.agent_name || c.agent,
  status: STATUS_WORD[c.status] || c.status, created_at: c.created_at, decided_at: c.decided_at || null, link: cardLink(c) });

async function cardsOf(store, status, agent) {
  const rows = await store.list({ status, agent, limit: 200 });
  return rows.filter((c) => c.agent !== 'digest');
}

const newestFirst = (key) => (a, b) => new Date(b[key] || 0) - new Date(a[key] || 0);

// members: [{ slug, name, default_name }] (the team page's list). who: her email.
async function answer({ question, store, members, who, now = new Date() }) {
  const raw = String(question || '').trim();
  if (!raw) return { understood: false, answer: 'Type a question about your team.', can_answer: CAN_ANSWER, cards: [] };
  if (raw.length > 300) return { understood: false, answer: 'Keep the question under 300 characters.', can_answer: CAN_ANSWER, cards: [] };
  const q = raw.toLowerCase();
  const today = ymdOf(now);
  const w = windowOf(q, today);
  const member = memberOf(q, members);
  const shape = shapeOf(q, member, w);
  const names = new Map(members.map((m) => [m.slug, m.name]));
  const mine = /\b(i|me|my|mine)\b/.test(q);
  const whom = member ? ` from ${member.name}` : '';
  const when = w ? ` ${w.label}` : '';

  const done = (text, cards, extra = {}) => ({ understood: true, shape, answer: text,
    cards: cards.slice(0, LIST_MAX).map((c) => cardView(c, names)), more: Math.max(0, cards.length - LIST_MAX),
    window: w, member: member ? member.name : null, ...extra });

  if (!shape) {
    return { understood: false, answer: "I can't answer that from your team's cards and runs. I only read your own team's drafts, approvals, rejections and runs. Try one of these:",
      can_answer: CAN_ANSWER, cards: [] };
  }

  if (shape === 'waiting') {
    const all = (await cardsOf(store, 'draft', member && member.slug)).filter((c) => inWindow(c.created_at, w)).sort(newestFirst('created_at'));
    if (!all.length) return done(`No drafts${whom} are waiting${w ? ` from ${w.label}` : ''}.`, all);
    const by = new Map();
    for (const c of all) by.set(c.agent, (by.get(c.agent) || 0) + 1);
    const split = member ? '' : ` ${[...by].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${names.get(a) || a} ${n}`).join(', ')}.`;
    return done(`${plural(all.length, 'draft is', 'drafts are')} waiting${whom}${w ? ` (made ${w.label})` : ''}.${split}`, all);
  }

  if (shape === 'approved' || shape === 'rejected') {
    const status = shape === 'approved' ? 'ready' : 'rejected';
    const all = (await cardsOf(store, status, member && member.slug))
      .filter((c) => inWindow(c.decided_at, w) && (!mine || (who && String(c.decided_by || '').toLowerCase() === String(who).toLowerCase())))
      .sort(newestFirst('decided_at'));
    const verb = shape === 'approved' ? 'approved' : 'rejected';
    const by = mine ? 'You' : 'Your team';
    if (!all.length) return done(`${by} ${verb} no cards${whom}${when}.`, all);
    return done(`${by} ${verb} ${plural(all.length, 'card', 'cards')}${whom}${when}.`, all);
  }

  if (shape === 'ran') {
    if (!member) return { understood: false, answer: 'Say which team member, for example "When did Scout last run?"', can_answer: CAN_ANSWER, cards: [] };
    const runs = (await store.runHistory(20)).filter((r) => r.agent === member.slug && inWindow(r.started_at, w))
      .sort(newestFirst('started_at'));
    if (!runs.length) return done(`${member.name} has not run${when}.`, [], { runs: [] });
    const fmt = (d) => new Date(d).toLocaleString('en-US', { timeZone: TZ, month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/\//g, '.');
    const last = runs[0];
    const said = last.status === 'failed' ? 'and could not finish' : `and made ${plural(last.cards || 0, 'card', 'cards')}`;
    const view = runs.slice(0, LIST_MAX).map((r) => ({ started_at: r.started_at, status: r.status, cards: r.cards || 0 }));
    return done(`${member.name} last ran ${fmt(last.started_at)} ${said}.${w ? ` ${plural(runs.length, 'run', 'runs')} ${w.label}.` : ''}`, [], { runs: view });
  }

  // 'agent' (one member's cards) or 'cards' (everyone's) in the window, any decision.
  const statuses = ['draft', 'ready', 'rejected', 'archived'];
  const all = [];
  for (const s of statuses) all.push(...(await cardsOf(store, s, member && member.slug)));
  const hit = all.filter((c) => inWindow(c.created_at, w)).sort(newestFirst('created_at'));
  const who2 = member ? member.name : 'Your team';
  if (!hit.length) return done(`${who2} made no cards${when}.`, hit);
  const count = (s) => hit.filter((c) => c.status === s).length;
  const parts = statuses.map((s) => [STATUS_WORD[s], count(s)]).filter(([, n]) => n).map(([word, n]) => `${n} ${word}`);
  return done(`${who2} made ${plural(hit.length, 'card', 'cards')}${when}: ${parts.join(', ')}.`, hit);
}

module.exports = { answer, windowOf, memberOf, shapeOf, CAN_ANSWER, cardLink };
