// ORDER #1658: the Agents page. Katherine (and execs) edit what each marketing
// bot does, and the Box's runs use her latest version.
//
//   GET  /agents                        the page
//   GET  /api/agents                    every agent: default + current instructions, on/off, last run
//   GET  /api/agents/:slug/history      every saved version, newest first
//   POST /api/agents/:slug              { skill_md, enabled, max_cards, note }  -> a NEW version
//   POST /api/agents/:slug/revert       { version }  -> a new version copying that one
//   POST /api/agents/:slug/run          { ask }  -> queued; the Box runs it within 15 minutes
//
// ACCESS: below the #654/#1370 page gate, exec or Katherine only (req.mktUser),
// recorded by email. A fleet key never reaches here.
//
// WHAT CANNOT BE EDITED HERE: the fence. lib/agent-runner.js adds THE FENCE and
// the output contract after whatever instructions are saved, and every card is
// linted and lands as a DRAFT. Sources (what an agent may read) are shown, not
// editable: adding one is a code change.
'use strict';

const express = require('express');
const path = require('path');
const { listAgents, loadAgent } = require('../lib/agent-runner');
const { personOf } = require('./review');

const PAGE = path.join(__dirname, '..', 'public', 'agents.html');

function sourceView(src) {
  const label = src.label || src.path || (src.newest ? `newest ${src.newest}*` : src.type);
  return { label, type: src.type, required: !!src.required, pending: src.type === 'pending', why: src.why || null };
}

function createAgentsRouter({ store }) {
  const r = express.Router();
  const need = (req, res, next) => (personOf(req) ? next() : res.status(403).json({ error: 'Signed-in leadership only.' }));
  const known = (req, res, next) => (listAgents().includes(req.params.slug) ? next() : res.status(404).json({ error: 'no such agent' }));

  r.get(['/agents', '/agents.html'], (req, res) => (personOf(req) ? res.sendFile(PAGE) : res.status(403).send('Signed-in leadership only.')));

  r.get('/api/agents', need, async (req, res) => {
    const current = new Map((await store.allCurrentSettings()).map((s) => [s.agent, s]));
    const runs = new Map((await store.runs()).map((x) => [x.agent, x]));
    const queued = await store.runRequests(50);
    res.json({ agents: listAgents().map((slug) => {
      const d = loadAgent(slug);
      const s = current.get(slug);
      return { slug, name: d.name, job: d.job, cadence: d.cadence, sources: (d.sources || []).map(sourceView),
        default_skill: d.skill, default_max_cards: d.max_cards || 3,
        current: s ? { version: s.version, skill_md: s.skill_md, enabled: s.enabled, max_cards: s.max_cards,
          edited_by: s.edited_by, created_at: s.created_at, note: s.note } : null,
        last_run: runs.get(slug) || null,
        waiting: queued.filter((q) => q.agent === slug && ['queued', 'running'].includes(q.status)).length };
    }) });
  });

  r.get('/api/agents/:slug/history', need, known, async (req, res) => res.json({ versions: await store.settingsHistory(req.params.slug) }));

  r.post('/api/agents/:slug', need, known, async (req, res) => {
    const b = req.body || {};
    const out = await store.saveSettings(req.params.slug, { skill_md: b.skill_md, enabled: b.enabled, max_cards: b.max_cards,
      note: b.note, who: personOf(req) });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ settings: out.settings });
  });

  r.post('/api/agents/:slug/revert', need, known, async (req, res) => {
    const v = Number((req.body || {}).version);
    if (!Number.isInteger(v) || v < 1) return res.status(400).json({ error: 'bad version' });
    const out = await store.revertSettings(req.params.slug, v, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ settings: out.settings });
  });

  r.post('/api/agents/:slug/run', need, known, async (req, res) => {
    const out = await store.queueRun(req.params.slug, String((req.body || {}).ask || '').trim() || null, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ request: out.request });
  });

  return r;
}

module.exports = { createAgentsRouter, sourceView };
