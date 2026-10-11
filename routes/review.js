// ORDER #1015 Part 2: the Review tab.
//
//   GET  /review                    the page
//   GET  /api/review/cards?status=  draft (default) | ready | rejected; &agent=
//   GET  /api/review/runs           each agent's last run (done / failed / missing sources)
//   POST /api/review/cards/:id      { action: 'approve' | 'reject' | 'edit', reason?, body? }
//   POST /api/review/lint           { text } -> the AI-tells lint ("Check text")
//
// ACCESS: mounted below the #654/#1370 page gate, so only an exec or Katherine
// with a live SSO session reaches here (req.mktUser). The decision is recorded
// against that person's email. A fleet key never reaches /api/review (the
// gate's allow list is /api/ga4/* only).
//
// APPROVE IS NOT PUBLISH. It moves a card to 'ready'. Nothing here calls
// WordPress, Google, a directory, an ad platform or an inbox. A card with an
// em dash cannot be approved (AI_TELLS_BAN_LIST enforcement).
'use strict';

const express = require('express');
const path = require('path');
const { lint } = require('../lib/ai-tells');

const PAGE = path.join(__dirname, '..', 'public', 'review.html');
const STATUSES = new Set(['draft', 'ready', 'rejected']);

function personOf(req) {
  const u = req.mktUser;
  return u && u.email ? String(u.email).toLowerCase() : null;
}

function createReviewRouter({ store }) {
  const r = express.Router();
  const need = (req, res, next) => (personOf(req) ? next() : res.status(403).json({ error: 'Signed-in leadership only.' }));
  r.get(['/review', '/review.html'], (req, res) => (personOf(req) ? res.sendFile(PAGE) : res.status(403).send('Signed-in leadership only.')));
  r.get('/api/review/cards', need, async (req, res) => {
    const status = STATUSES.has(req.query.status) ? req.query.status : 'draft';
    const agent = /^[a-z0-9-]+$/.test(req.query.agent || '') ? req.query.agent : undefined;
    res.json({ cards: await store.list({ status, agent }) });
  });
  r.get('/api/review/runs', need, async (req, res) => res.json({ runs: await store.runs() }));
  r.post('/api/review/cards/:id', need, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad id' });
    const { action, reason, body } = req.body || {};
    const out = await store.decide(id, { action, reason, body, who: personOf(req) });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ card: out.card });
  });
  r.post('/api/review/lint', need, (req, res) => {
    const text = String((req.body && req.body.text) || '');
    if (text.length > 200000) return res.status(413).json({ error: 'too long' });
    res.json(lint(text));
  });
  return r;
}

module.exports = { createReviewRouter, personOf };
