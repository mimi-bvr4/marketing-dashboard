// ORDER #1658: the Agents page. Katherine (and execs) edit what each marketing
// bot does, and the Box's runs use her latest version.
//
//   GET  /agents                        the page
//   GET  /api/agents                    every agent: default + current instructions, on/off, last run
//   GET  /api/agents/:slug/history      every saved version, newest first
//   POST /api/agents/:slug              { skill_md, enabled, max_cards, note }  -> a NEW version
//   POST /api/agents/:slug/revert       { version }  -> a new version copying that one
//   POST /api/agents/:slug/run          { ask }  -> queued; the Box runs it within 15 minutes
//                                       (409 for an agent with an ask_page, #1688: asked on that page)
//   POST /api/agents/:slug/asks         { ask }  -> Katherine asks the bot for a new ability
//   POST /api/agents/asks/:id/decide    { decision: 'apply' | 'decline', note }  EXEC ONLY (rung 3)
//   POST /api/agents/:slug/name         { name }  -> #1664, '' puts the default back
//   PUT  /api/agents/:slug/portrait     raw PNG/JPG/WebP body, 1.5 MB max  -> #1664
//   DELETE /api/agents/:slug/portrait   -> back to the drawn portrait
//   GET  /api/agents/:slug/portrait     the picture
//   GET  /api/agents/:slug/profile-log  every name and portrait change
//   GET  /api/agents/:slug/watch        #1666 the competitor sites (Scout only)
//   POST /api/agents/:slug/watch        { site, label }  add one (15 max)
//   DELETE /api/agents/:slug/watch/:id  remove one (and what was seen on it)
//
// #1664 NAMES AND PORTRAITS ARE COSMETIC (Mimi, 10.12.2026): they save at once,
// no exec approval, because they change nothing about what an agent may do.
//
// CHARACTER CARDS: each agent is shown as a character: Does / Traits / Needs
// (agent.json "character"), plus every ask and where it stands. Asks the Box
// sorted as "cant" show under Traits with what the bot does instead.
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
const { displayName } = require('../lib/agent-profile');

const PAGE = path.join(__dirname, '..', 'public', 'agents.html');

function sourceView(src) {
  const label = src.label || src.path || (src.newest ? `newest ${src.newest}*` : src.type);
  return { label, type: src.type, required: !!src.required, pending: src.type === 'pending', why: src.why || null };
}

// Mimi's ruling 10.11.2026: an instruction change from an ask waits for her.
// "Exec" is Dispatch's rung 3 (the #1370 rule), never a name string.
async function isExec(req, identity) {
  const email = personOf(req);
  if (!email || !identity) return false;
  const who = await identity.lookup(email);
  return !!who.active && Number(who.rung) >= 3;
}

function characterOf(d, asks, run) {
  const c = d.character || { role: d.job, does: [], traits: [], needs: [] };
  const applied = asks.filter((a) => a.status === 'applied');
  const cants = asks.filter((a) => a.status === 'cant');
  const missing = ((run && run.unavailable) || []).map((u) => `${u.label}: ${u.why}`);
  return {
    role: c.role,
    does: [...(c.does || []), ...applied.map((a) => `${a.ask} (added from ask #${a.id})`)],
    traits: [...(c.traits || []), ...cants.map((a) => ({ cant: a.ask, instead: (a.triage && a.triage.instead) || '', ask_id: a.id }))],
    needs: [...new Set([...(c.needs || []), ...missing])],
  };
}

// #1666: a watcher with an empty list says so under Waiting on.
function watchNeed(c, list) {
  if (!list || list.length) return c;
  const n = "Katherine's list of competitor websites to watch (add them on this page)";
  return { ...c, needs: [n, ...c.needs.filter((x) => !/^competitor websites Katherine listed:/.test(x))] };
}

function createAgentsRouter({ store, identity }) {
  const r = express.Router();
  const need = (req, res, next) => (personOf(req) ? next() : res.status(403).json({ error: 'Signed-in leadership only.' }));
  const known = (req, res, next) => (listAgents().includes(req.params.slug) ? next() : res.status(404).json({ error: 'no such agent' }));

  r.get(['/agents', '/agents.html'], (req, res) => (personOf(req) ? res.sendFile(PAGE) : res.status(403).send('Signed-in leadership only.')));

  r.get('/api/agents', need, async (req, res) => {
    const current = new Map((await store.allCurrentSettings()).map((s) => [s.agent, s]));
    const runs = new Map((await store.runs()).map((x) => [x.agent, x]));
    const queued = await store.runRequests(50);
    const allAsks = await store.listAsks();
    const exec = await isExec(req, identity);
    const profiles = new Map((store.profiles ? await store.profiles() : []).map((p) => [p.agent, p]));
    const watchers = {};
    for (const slug of listAgents()) {
      if ((loadAgent(slug).sources || []).some((x) => x.type === 'competitor_watch')) watchers[slug] = store.watchlist ? await store.watchlist(slug) : [];
    }
    res.json({ exec, agents: listAgents().map((slug) => {
      const d = loadAgent(slug);
      const s = current.get(slug);
      const asks = allAsks.filter((a) => a.agent === slug);
      const p = profiles.get(slug);
      return { slug, name: displayName(d, p), default_name: d.name, job: d.job,
        portrait: p && p.portrait_at ? `/api/agents/${slug}/portrait?v=${new Date(p.portrait_at).getTime()}` : null,
        named_by: p && p.display_name ? p.updated_by : null, cadence: d.cadence, ask_page: d.ask_page || null, sources: (d.sources || []).map(sourceView),
        default_skill: d.skill, default_max_cards: d.max_cards || 3,
        current: s ? { version: s.version, skill_md: s.skill_md, enabled: s.enabled, max_cards: s.max_cards,
          edited_by: s.edited_by, created_at: s.created_at, note: s.note } : null,
        last_run: runs.get(slug) || null,
        waiting: queued.filter((q) => q.agent === slug && ['queued', 'running'].includes(q.status)).length,
        character: watchNeed(characterOf(d, asks, runs.get(slug)), watchers[slug]),
        watch: watchers[slug] || null,
        asks: asks.map((a) => ({ id: a.id, ask: a.ask, asked_by: a.asked_by, created_at: a.created_at, status: a.status, kind: a.kind,
          reason: a.triage ? a.triage.reason : null, instead: a.triage ? a.triage.instead : null,
          proposed: a.status === 'awaiting_exec' && a.triage ? a.triage.proposed_skill_md : null,
          order_file: a.order_file, decided_by: a.decided_by, note: a.note })) };
    }) });
  });

  // #1664 names and portraits.
  r.post('/api/agents/:slug/name', need, known, async (req, res) => {
    const out = await store.setName(req.params.slug, (req.body || {}).name, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ name: displayName(loadAgent(req.params.slug), out.profile), profile: out.profile });
  });
  const raw = express.raw({ type: () => true, limit: '2mb' });
  r.put('/api/agents/:slug/portrait', need, known, raw, async (req, res) => {
    const out = await store.setPortrait(req.params.slug, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ profile: out.profile });
  });
  r.delete('/api/agents/:slug/portrait', need, known, async (req, res) => {
    const out = await store.setPortrait(req.params.slug, null, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ profile: out.profile });
  });
  r.get('/api/agents/:slug/portrait', need, known, async (req, res) => {
    const p = await store.portrait(req.params.slug);
    if (!p) return res.status(404).json({ error: 'no portrait' });
    res.set({ 'Content-Type': p.portrait_type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.send(p.portrait);
  });
  r.get('/api/agents/:slug/profile-log', need, known, async (req, res) => res.json({ changes: await store.profileLog(req.params.slug) }));

  // #1666 the Scout's watch list.
  const watcher = (req, res, next) => ((loadAgent(req.params.slug).sources || []).some((x) => x.type === 'competitor_watch')
    ? next() : res.status(404).json({ error: 'this team member does not watch websites' }));
  r.get('/api/agents/:slug/watch', need, known, watcher, async (req, res) => res.json({ watch: await store.watchlist(req.params.slug) }));
  r.post('/api/agents/:slug/watch', need, known, watcher, async (req, res) => {
    const b = req.body || {};
    const out = await store.addWatch(req.params.slug, b.site, b.label, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ watch: out.watch });
  });
  r.delete('/api/agents/:slug/watch/:id', need, known, watcher, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad id' });
    const out = await store.removeWatch(req.params.slug, id);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json(out);
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
    // #1688: a team member with his own page (the Collateral Cadet) is asked there, not run here.
    const page = loadAgent(req.params.slug).ask_page;
    if (page) return res.status(409).json({ error: `Ask on his own page: ${page}` });
    const out = await store.queueRun(req.params.slug, String((req.body || {}).ask || '').trim() || null, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ request: out.request });
  });

  r.post('/api/agents/:slug/asks', need, known, async (req, res) => {
    const out = await store.createAsk(req.params.slug, (req.body || {}).ask, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ ask: out.ask });
  });

  r.post('/api/agents/asks/:id/decide', need, async (req, res) => {
    if (!(await isExec(req, identity))) return res.status(403).json({ error: 'Only an exec approves an instruction change from an ask.' });
    const id = Number(req.params.id);
    const a = Number.isInteger(id) ? await store.getAsk(id) : null;
    if (!a) return res.status(404).json({ error: 'no such ask' });
    if (a.status !== 'awaiting_exec' || !a.triage || !a.triage.proposed_skill_md) return res.status(409).json({ error: 'this ask is not waiting for approval' });
    const who = personOf(req);
    const { decision, note } = req.body || {};
    if (decision === 'decline') {
      const d = await store.updateAsk(id, { status: 'declined', decided_by: who, decided_at: new Date(), note: note ? String(note).slice(0, 400) : null });
      return res.json({ ask: d });
    }
    if (decision !== 'apply') return res.status(400).json({ error: "decision must be 'apply' or 'decline'" });
    const cur = await store.currentSettings(a.agent);
    if ((cur ? cur.version : 0) !== a.triage.base_version) {
      await store.updateAsk(id, { status: 'new', note: 'instructions changed after this was sorted; the Box sorts it again' });
      return res.status(409).json({ error: 'The instructions changed since this was proposed. The Box will sort the ask again within 15 minutes.' });
    }
    const d = loadAgent(a.agent);
    const saved = await store.saveSettings(a.agent, { skill_md: a.triage.proposed_skill_md, enabled: cur ? cur.enabled : true,
      max_cards: cur ? cur.max_cards : (d.max_cards || 3), note: `ask #${id} from ${a.asked_by}, approved by ${who}`, who });
    if (saved.error) return res.status(400).json({ error: saved.error });
    const done = await store.updateAsk(id, { status: 'applied', decided_by: who, decided_at: new Date() });
    res.json({ ask: done, settings: saved.settings });
  });

  return r;
}

module.exports = { createAgentsRouter, sourceView, characterOf, isExec, watchNeed };
