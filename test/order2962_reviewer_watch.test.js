'use strict';
// ORDER #2962: the agent that checks the humans who check the agents.
// Facts only (no judgment words), read only, exec only, switch default OFF.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const W = require('../lib/reviewer-watch');
const { createReviewerWatchRouter, visitRecorder } = require('../routes/reviewer-watch');

const MKT = W.department('marketing');
const K = 'katherine@infinityhospitality.net';
const MIMI = 'mimi@infinityhospitality.net';
// Monday 11.09.2026 08:00 CT: the scorecard covers 11.02 to 11.08.
const NOW = new Date('2026-11-09T14:00:00Z');
const at = (s) => new Date(s);

function rows() {
  const card = (o) => ({ agent_name: o.agent, edited: false, has_reason: false, has_redo: false, handoff: null, kind: null,
    decided_by: null, decided_at: null, ...o });
  return {
    cards: [
      // decided this week by Katherine
      card({ id: 10, agent: 'pinterest-paul', title: 'Pin A', status: 'ready', kind: 'pin', created_at: at('2026-11-02T15:00:00Z'), decided_by: K, decided_at: at('2026-11-03T15:00:00Z'), handoff: { ok: true, pin_url: 'x' } }),
      card({ id: 11, agent: 'bloggy-bob', title: 'Post B', status: 'ready', kind: 'post', created_at: at('2026-11-01T15:00:00Z'), decided_by: K, decided_at: at('2026-11-04T15:00:00Z'), handoff: { ok: true, wp_id: 5 } }),
      card({ id: 12, agent: 'gbp', title: 'GBP C', status: 'ready', created_at: at('2026-11-04T15:00:00Z'), decided_by: K, decided_at: at('2026-11-04T17:00:00Z') }),
      card({ id: 13, agent: 'gbp', title: 'GBP D', status: 'rejected', has_reason: true, created_at: at('2026-11-03T15:00:00Z'), decided_by: K, decided_at: at('2026-11-05T15:00:00Z') }),
      card({ id: 14, agent: 'convention-connector', title: 'Conv E', status: 'ready', kind: 'sales', created_at: at('2026-11-05T15:00:00Z'), decided_by: K, decided_at: at('2026-11-06T15:00:00Z'), handoff: { ok: true, task_id: 9 } }),
      // archived by the sweep this week: the system, not a person
      card({ id: 15, agent: 'gbp', title: 'Old F', status: 'archived', created_at: at('2026-10-01T15:00:00Z'), decided_by: 'archive-sweep (Mimi ruling 11.03.2026)', decided_at: at('2026-11-03T20:00:00Z') }),
      // prior week: one approve
      card({ id: 16, agent: 'scout', title: 'Scout G', status: 'ready', created_at: at('2026-10-27T15:00:00Z'), decided_by: K, decided_at: at('2026-10-28T15:00:00Z') }),
      // waiting now
      card({ id: 20, agent: 'citations', title: 'Cit H', status: 'draft', created_at: at('2026-10-15T14:00:00Z') }),
      card({ id: 21, agent: 'gbp', title: 'GBP I', status: 'draft', created_at: at('2026-10-20T14:00:00Z') }),
      card({ id: 22, agent: 'gbp', title: 'GBP J', status: 'draft', edited: true, created_at: at('2026-10-10T14:00:00Z') }),
      card({ id: 23, agent: 'gbp', title: 'GBP K', status: 'draft', created_at: at('2026-11-08T14:00:00Z') }),
      card({ id: 24, agent: 'seo', title: 'SEO L', status: 'draft', created_at: at('2026-10-25T14:00:00Z') }),
    ],
    runs: [
      { agent: 'gbp', started_at: at('2026-11-03T12:00:00Z'), status: 'done' },
      { agent: 'gbp', started_at: at('2026-11-07T12:00:00Z'), status: 'done' },
      { agent: 'seo', started_at: at('2026-11-08T12:00:00Z'), status: 'done' },
      { agent: 'scout', started_at: at('2026-10-29T12:00:00Z'), status: 'done' },
    ],
    asks: [{ agent: 'scout', asked_by: K, status: 'new', created_at: at('2026-11-04T12:00:00Z') }],
    settings: [
      { agent: 'gbp', version: 3, edited_by: K, created_at: at('2026-11-05T12:00:00Z') },
      { agent: 'citations', version: 4, edited_by: 'mimi@infinityhospitality.net (via the Box)', created_at: at('2026-11-05T12:00:00Z') },
    ],
    visits: [],
  };
}

test('the week is Monday to Sunday in Nashville, the one that just ended', () => {
  assert.strictEqual(W.weekFor(NOW), '2026-11-02');
  assert.strictEqual(W.ctMidnight('2026-11-02').toISOString(), '2026-11-02T06:00:00.000Z'); // CST
  assert.strictEqual(W.ctMidnight('2026-10-27').toISOString(), '2026-10-27T05:00:00.000Z'); // CDT
  assert.strictEqual(W.mondayOf('2026-11-08'), '2026-11-02');
});

test('every number traces to a row', () => {
  const s = W.scorecard({ dept: MKT, rows: rows(), now: NOW });
  const w = s.week;
  assert.strictEqual(w.approved, 4); // 10, 11, 12, 14
  assert.strictEqual(w.rejected, 1); // 13
  assert.strictEqual(w.rejected_with_reason, 1);
  assert.strictEqual(w.rejected_without_reason, 0);
  assert.strictEqual(w.archived_by_person, 0);
  assert.strictEqual(w.decided_by_machine, 1); // 15, the sweep
  assert.strictEqual(w.decided_by_person, 5);
  // draft to decision hours: 24, 72, 2, 48, 24 -> median 24, longest 72
  assert.strictEqual(w.hours_to_decide_median, 24);
  assert.strictEqual(w.hours_to_decide_max, 72);
  assert.strictEqual(w.asks, 1);
  assert.strictEqual(w.instruction_edits, 1, 'a Box-made version is not a person shaping the team');
  assert.strictEqual(w.runs, 3);
  assert.deepStrictEqual(w.per_person, [{ who: K, approved: 4, rejected: 1, archived: 0 }]);
  assert.strictEqual(s.prior.approved, 1);
  assert.strictEqual(s.prior.runs, 1);
  const use = Object.fromEntries(w.approved_use.map((a) => [a.id, a.use]));
  assert.strictEqual(use[10], 'pin live');
  assert.strictEqual(use[11], 'WordPress draft made; published: not trackable yet');
  assert.strictEqual(use[12], 'not trackable yet');
  assert.strictEqual(use[14], 'HubSpot task made; done: not trackable yet');
  const n = s.now;
  assert.strictEqual(n.drafts_waiting, 5);
  assert.deepStrictEqual(n.backlog.map((b) => [b.agent, b.waiting]), [['gbp', 3], ['citations', 1], ['seo', 1]]);
  // untouched: 22 was edited, so the 3 oldest are 20, 21, 24
  assert.deepStrictEqual(n.oldest_untouched.map((u) => u.id), [20, 21, 24]);
  assert.strictEqual(n.oldest_untouched[0].link, '/review#card-20');
  assert.strictEqual(n.visits_recorded, false);
  assert.strictEqual(n.runs_since_last_visit, null);
});

test('visits: last visit and the runs since it', () => {
  const r = rows();
  r.visits = [{ dept: 'marketing', page: '/review', email: K, at: at('2026-11-05T15:00:00Z') },
    { dept: 'marketing', page: '/agents', email: MIMI, at: at('2026-11-08T15:00:00Z') }];
  const n = W.scorecard({ dept: MKT, rows: r, now: NOW }).now;
  assert.strictEqual(n.last_review_visit, '2026-11-05T15:00:00.000Z');
  assert.strictEqual(n.last_agents_visit, null, "an exec's visit is not the head's");
  assert.strictEqual(n.runs_since_last_visit, 2);
});

test('the rendered scorecard carries no judgment words and says untrackable plainly', () => {
  const md = W.renderMarkdown([W.scorecard({ dept: MKT, rows: rows(), now: NOW })]);
  assert.deepStrictEqual(W.labelWords(md), []);
  assert.match(md, /week of 11\.02\.2026 to 11\.08\.2026/);
  assert.match(md, /Katherine Howe/);
  assert.match(md, /not trackable yet/);
  assert.match(md, /#20 citations/);
  // the check itself catches them
  const hits = W.labelWords('She is rubber-stamping; grade C, ranked last, slow.');
  for (const w of ['grade', 'ranked', 'slow', 'rubber-stamping']) assert.ok(hits.includes(w), w);
});

test('reads are narrow: no card body or payload text leaves the database', () => {
  const sql = W.READ_SQL.cards;
  assert.ok(!/\bbody\b/.test(sql));
  assert.ok(!/payload\s*(,|FROM)/.test(sql), 'payload is reduced to its kind');
  for (const q of Object.values(W.READ_SQL)) assert.match(q.trim(), /^SELECT /);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reviewer-watch.js'), 'utf8');
  assert.ok(!/UPDATE\s+agent_|DELETE\s+FROM|INSERT\s+INTO\s+agent_/i.test(src), 'never writes an agent table');
  assert.ok(!/compensation|salary|pay_rate|adp/i.test(Object.values(W.READ_SQL).join(' ')));
});

// ---------------------------------------------------------------- the route
function serve(opts) {
  const app = express();
  app.use((req, res, next) => { const e = req.headers['x-who']; if (e) req.mktUser = { email: e }; next(); });
  if (opts.recorder) app.use(opts.recorder);
  app.use(createReviewerWatchRouter(opts));
  app.get('/review', (req, res) => res.send('review page'));
  return new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
}
function get(s, p, who) {
  return new Promise((ok, no) => {
    http.get({ port: s.address().port, path: p, headers: who ? { 'x-who': who } : {} }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ status: res.statusCode, body: b }));
    }).on('error', no);
  });
}
const identity = { lookup: async (e) => (e === MIMI ? { active: true, rung: 3 } : { active: true, rung: 2, person_id: 'person_57d0eb01e923' }) };
const ON = { REVIEWER_WATCH: 'on' };

test('exec gate: non-exec gets 403, signed-out 403, exec 200', async () => {
  const s = await serve({ pool: {}, identity, env: ON, clock: () => NOW, read: async () => rows() });
  try {
    assert.strictEqual((await get(s, '/api/reviewer-watch', K)).status, 403, 'Katherine is not exec');
    assert.strictEqual((await get(s, '/reviewer-watch', K)).status, 403);
    assert.strictEqual((await get(s, '/api/reviewer-watch')).status, 403);
    const r = await get(s, '/api/reviewer-watch', MIMI);
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.week_start, '2026-11-02');
    assert.strictEqual(j.departments[0].week.approved, 4);
    assert.deepStrictEqual(W.labelWords(j.markdown), []);
  } finally { s.close(); }
});

test('REVIEWER_WATCH off (the default): 404 for exec, 403 still for non-exec, no visit written', async () => {
  const writes = [];
  const pool = { query: async (q, a) => { writes.push(q); return { rows: [] }; } };
  const s = await serve({ pool, identity, env: {}, clock: () => NOW, read: async () => rows(), recorder: visitRecorder({ pool, env: {} }) });
  try {
    assert.strictEqual((await get(s, '/api/reviewer-watch', MIMI)).status, 404);
    assert.strictEqual((await get(s, '/api/reviewer-watch', K)).status, 403);
    assert.strictEqual((await get(s, '/review', K)).status, 200);
    assert.strictEqual(writes.length, 0);
  } finally { s.close(); }
  assert.strictEqual(W.watchOn({}), false);
});

test('switch on: the head opening Review adds one visit row; an exec opening it adds none', async () => {
  const writes = [];
  const pool = { query: async (q, a) => { writes.push([q, a]); return { rows: [] }; } };
  const s = await serve({ pool, identity, env: ON, clock: () => NOW, read: async () => rows(), recorder: visitRecorder({ pool, env: ON }) });
  try {
    assert.strictEqual((await get(s, '/review', K)).status, 200);
    assert.strictEqual((await get(s, '/review', MIMI)).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    const inserts = writes.filter(([q]) => /INSERT INTO reviewer_visits/.test(q));
    assert.strictEqual(inserts.length, 1);
    assert.deepStrictEqual(inserts[0][1], ['marketing', '/review', K]);
  } finally { s.close(); }
});

test('the CLI writes a file only and never sends', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'reviewer_watch.js'), 'utf8');
  assert.ok(!/sendMail|gmail|nodemailer|twilio|fetch\(/i.test(src));
  assert.match(src, /labelWords/);
});
