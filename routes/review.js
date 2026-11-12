// ORDER #1015 Part 2: the Review tab.
//
//   GET  /review                    the page
//   GET  /api/review/cards?status=  draft (default) | ready | rejected | archived | reference (#2993); &agent=
//   GET  /api/review/handover       the HANDOVER_AT line (#2993), or { on: false }
//   GET  /api/review/runs           each agent's last run (done / failed / missing sources)
//   POST /api/review/cards/:id      { action: 'approve' | 'reject' | 'edit' | 'restore', reason?, body? }
//   POST /api/review/lint           { text } -> the AI-tells lint ("Check text")
//   POST /api/review/detective      { text } -> the AI Tell Detective (#3008; 404 while AI_TELL_DETECTIVE is off)
//   GET  /api/review/ai-tell-cards  ids of proposed-tell cards on Drafts (#3015; 404 while AI_TELL_HUNT is off)
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
const handover = require('../lib/handover');
const outreach = require('../lib/outreach');
const maryDesk = require('../lib/mary-desk');
const detective = require('../lib/ai-tell-detective');
const tellReview = require('../lib/ai-tell-review');
const fs = require('fs');

const PAGE = path.join(__dirname, '..', 'public', 'review.html');
// #2908: 'archived' is the Archived filter (hidden from Drafts, never deleted).
const STATUSES = new Set(['draft', 'ready', 'rejected', 'archived']);

function personOf(req) {
  const u = req.mktUser;
  return u && u.email ? String(u.email).toLowerCase() : null;
}

function createReviewRouter({ store }) {
  const r = express.Router();
  const need = (req, res, next) => (personOf(req) ? next() : res.status(403).json({ error: 'Signed-in leadership only.' }));
  r.get(['/review', '/review.html'], (req, res) => {
    if (!personOf(req)) return res.status(403).send('Signed-in leadership only.');
    // #3015: AI_TELL_HUNT off = the file exactly as it was. On = one script tag
    // that puts Approve tell / Reject tell on the proposed-tell cards.
    if (!tellReview.on()) return res.sendFile(PAGE);
    res.type('html').send(fs.readFileSync(PAGE, 'utf8').replace('</body>', `${tellReview.SCRIPT_TAG}</body>`));
  });
  // #3015: the ids of the proposed-tell cards waiting on Drafts (404 while off).
  r.get('/api/review/ai-tell-cards', need, async (req, res) => {
    if (!tellReview.on()) return res.status(404).json({ error: 'off', switch: 'AI_TELL_HUNT' });
    const cards = await store.list({ status: 'draft', agent: tellReview.AGENT });
    res.json({ ids: cards.filter(tellReview.isTellCard).map((c) => c.id) });
  });
  // #2993: where the handover line is, for the page's "Examples from before handover" tab.
  r.get('/api/review/handover', need, (req, res) => {
    const at = handover.handoverAt();
    res.json({ on: !!at, at: at ? at.toISOString() : null, tab: handover.REFERENCE_TAB, header: handover.REFERENCE_HEADER });
  });
  r.get('/api/review/cards', need, async (req, res) => {
    // #1664: show the name Katherine gave each agent, on old cards too.
    const names = new Map((store.profiles ? await store.profiles() : []).filter((p) => p.display_name).map((p) => [p.agent, p.display_name]));
    // #3003/#3012: who sends a sales card ("No salesperson set yet" for a Scout with no owner id).
    const owners = new Map();
    for (const a of [...outreach.OWNER_SETTING_AGENTS, ...Object.keys(outreach.OWNERS)]) owners.set(a, outreach.ownerLine(await outreach.salesOwner(a, { store })));
    // #3165 (HANDOFF_VIA_MARY on): every sales card goes to Mary's desk, so the
    // card carries her state instead ("Waiting on Mary to pick a salesperson",
    // "Assigned to X by Mary Topp, date", "Sent back to Katherine by ...").
    const viaMary = maryDesk.on();
    const named = (c) => {
      const o = names.has(c.agent) ? { ...c, agent_name: names.get(c.agent) } : c;
      if (viaMary && c.payload && c.payload.sales) return { ...o, mary: maryDesk.leadState(c), sales_owner: maryDesk.DESK };
      return c.payload && c.payload.sales && owners.has(c.agent) ? { ...o, sales_owner: owners.get(c.agent) } : o;
    };
    // #2993: every card made before HANDOVER_AT, any status, grouped by agent,
    // newest first. Empty while the line is unset. Each card stays openable,
    // copyable and approvable; none of them counts.
    if (req.query.status === 'reference') {
      const at = handover.handoverAt();
      const cards = at && store.referenceCards ? (await store.referenceCards()).map((c) => ({ ...named(c), reference: true })) : [];
      return res.json({ reference: true, at: at ? at.toISOString() : null, header: handover.REFERENCE_HEADER,
        cards, groups: handover.groupByAgent(cards).map((g) => ({ agent: g.agent, agent_name: g.agent_name, ids: g.cards.map((c) => c.id) })) });
    }
    const status = STATUSES.has(req.query.status) ? req.query.status : 'draft';
    const agent = /^[a-z0-9-]+$/.test(req.query.agent || '') ? req.query.agent : undefined;
    const cards = await store.list({ status, agent });
    res.json({ cards: cards.map(named) });
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
  // ORDER #3008: the AI Tell Detective (verdict, rule numbers, fixes, clean
  // rewrite). Behind AI_TELL_DETECTIVE, default OFF: while off it answers 404
  // and the page keeps the plain lint above. Nothing is stored.
  r.post('/api/review/detective', need, (req, res) => {
    if (!detective.on()) return res.status(404).json({ error: 'off', switch: 'AI_TELL_DETECTIVE' });
    const text = String((req.body && req.body.text) || '');
    if (text.length > 200000) return res.status(413).json({ error: 'too long' });
    res.json(detective.check(text));
  });
  return r;
}

module.exports = { createReviewRouter, personOf };
