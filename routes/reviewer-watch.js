// ORDER #2962: the reviewer facts page (exec only) and the visit log.
//
//   GET /reviewer-watch            the page (exec only; 404 while REVIEWER_WATCH is off)
//   GET /api/reviewer-watch        { departments: [scorecard], markdown } ?week=YYYY-MM-DD (a Monday)
//
// visitRecorder: while REVIEWER_WATCH is on, a department head's GET of their
// Review or Agents page adds one reviewer_visits row. It never blocks or changes
// the page; a failed write is logged and the page is served as before.
//
// ACCESS: below the #654/#1370 page gate, and then EXEC ONLY (Dispatch rung 3,
// the #1370 rule). Katherine passes the page gate but not this one: department
// heads do not see the scorecards (order #2962 fences).
'use strict';

const express = require('express');
const path = require('path');
const W = require('../lib/reviewer-watch');
const { personOf } = require('./review');
const { isExec } = require('./agents');

const PAGE = path.join(__dirname, '..', 'public', 'reviewer-watch.html');

function visitRecorder({ pool, env = process.env, log = console.error }) {
  let ready = null;
  return (req, res, next) => {
    if (req.method !== 'GET' || !pool || !W.watchOn(env)) return next();
    const email = personOf(req);
    const dept = email && W.DEPARTMENTS.find((d) => d.visit_pages.includes(req.path) && d.head_emails.includes(email));
    if (!dept) return next();
    ready = ready || W.ensureVisitTable(pool).catch((e) => { ready = null; throw e; });
    ready.then(() => W.recordVisit(pool, { dept: dept.key, page: req.path, email }))
      .catch((e) => log('[reviewer-watch] visit not recorded:', e.message));
    return next();
  };
}

function createReviewerWatchRouter({ pool, identity, env = process.env, clock = () => new Date(), read = W.readRows }) {
  const r = express.Router();
  const gate = async (req, res, next) => {
    if (!personOf(req)) return res.status(403).json({ error: 'Signed-in leadership only.' });
    let ok = false;
    try { ok = await isExec(req, identity); } catch (e) { ok = false; }
    if (!ok) return res.status(403).json({ error: 'Exec only.' });
    if (!W.watchOn(env)) return res.status(404).json({ error: `${W.FLAG} is off` });
    return next();
  };

  r.get(['/reviewer-watch', '/reviewer-watch.html'], gate, (req, res) => res.sendFile(PAGE));

  r.get('/api/reviewer-watch', gate, async (req, res) => {
    const now = clock();
    const q = String(req.query.week || '');
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(q) ? W.mondayOf(q) : W.weekFor(now);
    try {
      const since = W.ctMidnight(W.addDays(weekStart, -7));
      const rows = await read(pool, since);
      const departments = W.DEPARTMENTS.map((dept) => W.scorecard({ dept, rows, now, weekStart }));
      res.json({ week_start: weekStart, departments, markdown: W.renderMarkdown(departments) });
    } catch (e) {
      res.status(500).json({ error: `could not read the agent tables: ${e.message}` });
    }
  });
  return r;
}

module.exports = { createReviewerWatchRouter, visitRecorder };
