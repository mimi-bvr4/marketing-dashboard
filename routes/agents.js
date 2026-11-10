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
//   POST /api/agents/:slug/cards/:id/redo { words } -> #2914 one revised draft of that card, queued
//   POST /api/agents/keyword-queen/cards/:id/topics/:n/approve -> #3163 one Bloggy Bob request for that topic
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
//   GET  /api/producer                  #2900 the Producer's card: the week, the brakes, the board
//                                       (#2918 .health: this morning's team health check)
//   POST /api/producer/calendar/:slug   { days: ['tue'] }  move a weekly team member (logged)
//   POST /api/producer/name             { name }  Katherine names the Producer ('' = default)
//   GET  /api/agent-voices              #2955 { on: false } unless AGENT_VOICES is on; then
//                                       { on: true, voices: { slug: [{ src, line }] } }
//   POST /api/team/question             { question }  #2915 a plain answer from her team's own
//                                       cards and runs, with links to the cards. Read only.
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
const { sourceLabel, scoutWatchList } = require('../lib/agent-sources');
const { personOf } = require('./review');
const { displayName } = require('../lib/agent-profile');
const { pausedFor, cardOnly, switchOff } = require('../lib/producer');
const agentVoices = require('../lib/agent-voices');

const PAGE = path.join(__dirname, '..', 'public', 'agents.html');
// #2914: what the card says once a redo is asked (the request job runs every 15 minutes).
const REDO_MESSAGE = 'Redo asked. The new version lands here within about 15 minutes.';
// #2900: the Producer's profile key in agent_profiles.
const PRODUCER = 'producer';

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

// #2958: a run's "unavailable" reasons are a snapshot of that run, so they go
// stale (Concierge kept a 10.20 re-probe date after the 11.04 re-probe).
// Waiting on shows a run reason only if it is still true:
//   - a source still pending in agent.json: its LIVE `why` wins over the run's;
//   - a pending source that is no longer pending (connected since): dropped;
//   - any other read failure: shown only while the run is under STALE_RUN_DAYS
//     old; older, it describes a past run, not a wait (last_run keeps it).
const STALE_RUN_DAYS = 7;
function liveMissing(d, run, now) {
  if (!run) return [];
  const pending = new Map((d.sources || []).filter((s) => s.type === 'pending').map((s) => [sourceLabel(s), s.why || 'not connected yet']));
  const at = run.started_at ? new Date(run.started_at).getTime() : NaN;
  const fresh = Number.isFinite(at) && (now.getTime() - at) < STALE_RUN_DAYS * 86400000;
  const out = [];
  for (const u of run.unavailable || []) {
    if (pending.has(u.label)) out.push(`${u.label}: ${pending.get(u.label)}`);
    else if (u.type !== 'pending' && fresh) out.push(`${u.label}: ${u.why}`);
  }
  return out;
}

function characterOf(d, asks, run, now = new Date()) {
  const c = d.character || { role: d.job, does: [], traits: [], needs: [] };
  const applied = asks.filter((a) => a.status === 'applied');
  const cants = asks.filter((a) => a.status === 'cant');
  const missing = liveMissing(d, run, now);
  return {
    role: c.role,
    does: [...(c.does || []), ...applied.map((a) => `${a.ask} (added from ask #${a.id})`)],
    traits: [...(c.traits || []), ...cants.map((a) => ({ cant: a.ask, instead: (a.triage && a.triage.instead) || '', ask_id: a.id }))],
    needs: [...new Set([...(c.needs || []), ...missing])],
  };
}

// #1666: a watcher with an empty list says so under Waiting on.
// #3047: the IHG Competitors sheet's top competitors count, so a Scout that
// watches the sheet is never shown as waiting on a list.
function watchNeed(c, list, fromSheet = 0) {
  if (!list || list.length || fromSheet > 0) return c;
  const n = 'competitor websites to watch: none read from the IHG Competitors sheet yet, and none added on this page';
  return { ...c, needs: [n, ...c.needs.filter((x) => !/^competitor websites (Katherine listed|\(IHG Competitors sheet)/.test(x))] };
}

function createAgentsRouter({ store, identity, clock = () => new Date() }) {
  const r = express.Router();
  const need = (req, res, next) => (personOf(req) ? next() : res.status(403).json({ error: 'Signed-in leadership only.' }));
  const known = (req, res, next) => (listAgents().includes(req.params.slug) ? next() : res.status(404).json({ error: 'no such agent' }));
  // #2953: the Producer has no agents/ folder but has a profile (key 'producer', #2900),
  // so its portrait is stored and served through the same routes as every card's.
  const hasFace = (req, res, next) => (req.params.slug === PRODUCER || listAgents().includes(req.params.slug)
    ? next() : res.status(404).json({ error: 'no such agent' }));

  r.get(['/agents', '/agents.html'], (req, res) => (personOf(req) ? res.sendFile(PAGE) : res.status(403).send('Signed-in leadership only.')));

  // #2955 the "say something" clips. AGENT_VOICES off: { on: false }, no button.
  r.get('/api/agent-voices', need, (req, res) => {
    try { res.json(agentVoices.apiBody(process.env)); }
    catch (e) { res.json({ on: false }); }
  });

  r.get('/api/agents', need, async (req, res) => {
    const current = new Map((await store.allCurrentSettings()).map((s) => [s.agent, s]));
    const runs = new Map((await store.runs()).map((x) => [x.agent, x]));
    const queued = await store.runRequests(50);
    const allAsks = await store.listAsks();
    const exec = await isExec(req, identity);
    const profiles = new Map((store.profiles ? await store.profiles() : []).map((p) => [p.agent, p]));
    const watchers = {};
    const sheetWatch = {};
    for (const slug of listAgents()) {
      if ((loadAgent(slug).sources || []).some((x) => x.type === 'competitor_watch')) {
        watchers[slug] = store.watchlist ? await store.watchlist(slug) : [];
        // #3047: how many sheet competitors the Scout adds on top of this page's list.
        try { sheetWatch[slug] = (await scoutWatchList(store, slug)).fromSheet; } catch (e) { sheetWatch[slug] = 0; }
      }
    }
    res.json({ exec, agents: listAgents().map((slug) => {
      const d = loadAgent(slug);
      const s = current.get(slug);
      const asks = allAsks.filter((a) => a.agent === slug);
      const p = profiles.get(slug);
      return { slug, name: displayName(d, p), default_name: d.name, job: d.job,
        portrait: p && p.portrait_at ? `/api/agents/${slug}/portrait?v=${new Date(p.portrait_at).getTime()}` : null,
        named_by: p && p.display_name ? p.updated_by : null, cadence: d.cadence, ask_page: d.ask_page || null, ask_note: d.ask_note || null, sources: (d.sources || []).map(sourceView),
        // #2903: paused until a source exists (Paid Ads), or a card only (Web Agent, Site Guardian).
        // #3000: a new member that ships OFF shows the same "Paused:" line, naming its switch.
        paused: switchOff(d) || pausedFor(d), card_only: cardOnly(d),
        default_skill: d.skill, default_max_cards: d.max_cards || 3,
        current: s ? { version: s.version, skill_md: s.skill_md, enabled: s.enabled, max_cards: s.max_cards,
          edited_by: s.edited_by, created_at: s.created_at, note: s.note } : null,
        last_run: runs.get(slug) || null,
        waiting: queued.filter((q) => q.agent === slug && ['queued', 'running'].includes(q.status)).length,
        character: watchNeed(characterOf(d, asks, runs.get(slug), clock()), watchers[slug], sheetWatch[slug] || 0),
        watch: watchers[slug] || null,
        watch_sheet: watchers[slug] ? (sheetWatch[slug] || 0) : null,
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
  r.put('/api/agents/:slug/portrait', need, hasFace, raw, async (req, res) => {
    const out = await store.setPortrait(req.params.slug, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ profile: out.profile });
  });
  r.delete('/api/agents/:slug/portrait', need, hasFace, async (req, res) => {
    const out = await store.setPortrait(req.params.slug, null, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ profile: out.profile });
  });
  r.get('/api/agents/:slug/portrait', need, hasFace, async (req, res) => {
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
    const def = loadAgent(req.params.slug);
    const page = def.ask_page;
    if (page) return res.status(409).json({ error: `Ask on his own page: ${page}` });
    // #2903: a card-only team member is not run from here.
    if (cardOnly(def)) return res.status(409).json({ error: `Not run from this page: ${cardOnly(def)}` });
    const out = await store.queueRun(req.params.slug, String((req.body || {}).ask || '').trim() || null, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ request: out.request });
  });

  // #2914: "this missed X" / "redo it this way" on one draft card. Same queue as
  // Run now; the card must be this agent's own. Drafts only, nothing publishes.
  r.post('/api/agents/:slug/cards/:id/redo', need, known, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad id' });
    const out = await store.queueRedo(id, { agent: req.params.slug, words: (req.body || {}).words, who: personOf(req) });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ request: out.request, card: out.card, message: REDO_MESSAGE });
  });

  // #3163: approve ONE topic on a Keyword Queen card: one queued Bloggy Bob
  // request for it, ever. Off (AGENT_KEYWORD_QUEEN unset) this answers 404.
  r.post('/api/agents/keyword-queen/cards/:id/topics/:n/approve', need, async (req, res) => {
    const kq = require('../lib/keyword-queen');
    const id = Number(req.params.id);
    const n = Number(req.params.n);
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'bad id' });
    const out = await kq.approveTopic({ card: await store.get(id), n, who: personOf(req), store, env: process.env });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json(out.request ? { request: out.request, message: 'Queued for Bloggy Bob. His draft lands on the Review tab within about 15 minutes.' }
      : { already: true, message: 'Already queued for Bloggy Bob.' });
  });

  r.post('/api/agents/:slug/asks', need, known, async (req, res) => {
    // #2961: "Make this permanent" under the Run-now box files the request as a
    // standing-change Ask; the Box sorts it and an instruction change waits for Mimi.
    const body = req.body || {};
    const typed = String(body.ask || '').trim();
    const text = body.permanent === true && typed.length >= 5 ? require('../lib/run-now-note').permanentAsk(typed) : body.ask;
    const out = await store.createAsk(req.params.slug, text, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ ask: out.ask });
  });

  // #2900 the Producer: its card, the week, and the board. Read-only except a
  // day move (a schedule change Katherine may make herself, ruling 2) and its name.
  r.get('/api/producer', need, async (req, res) => {
    const P = require('../lib/producer');
    const now = clock();
    const ymd = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const cal = P.calendar(store.calendarRows ? await store.calendarRows() : []);
    const profiles = new Map((store.profiles ? await store.profiles() : []).map((p) => [p.agent, p]));
    const defs = listAgents().map((slug) => { const d = loadAgent(slug); return { ...d, name: displayName(d, profiles.get(slug)) }; });
    const settings = new Map((await store.allCurrentSettings()).map((s) => [s.agent, s]));
    const history = new Map();
    for (const h of (store.runHistory ? await store.runHistory(20) : [])) { const a = history.get(h.agent) || []; a.push(h); history.set(h.agent, a); }
    const today = store.producerDay ? await store.producerDay(ymd) : [];
    const me = profiles.get('producer');
    // #2918: this morning's team health check (read only; agent, status and time columns only).
    let health = null;
    if (store.draftAges && store.listAsks && store.runHistory) {
      try { health = await require('../lib/team-health').teamHealth({ ymd, store, defs, now }); } catch (e) { health = null; }
    }
    res.json({
      health,
      on: P.producerOn(), name: me && me.display_name ? me.display_name : 'The Producer', named_by: me && me.display_name ? me.updated_by : null,
      portrait: me && me.portrait_at ? `/api/agents/${PRODUCER}/portrait?v=${new Date(me.portrait_at).getTime()}` : null,
      waiting: store.draftsWaiting ? await store.draftsWaiting() : null, hold_at: P.holdOn(ymd),
      week_cards: store.producerWeekCards ? await store.producerWeekCards(P.weekStart(ymd)) : 0, cap: P.WEEKLY_CAP,
      exempt: Object.keys(P.EXEMPT),
      calendar: cal.map((e) => ({ ...e, name: (defs.find((d) => d.slug === e.agent) || {}).name || e.agent, movable: P.movable(e) })),
      board: P.board({ ymd, defs, settings, history, today, cal }),
      today,
    });
  });
  r.post('/api/producer/calendar/:slug', need, async (req, res) => {
    const P = require('../lib/producer');
    const c = P.checkMove(req.params.slug, (req.body || {}).days);
    if (c.error) return res.status(400).json({ error: c.error });
    const out = await store.setCalendarDays(req.params.slug, c.days, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ calendar: out.calendar });
  });
  r.post('/api/producer/name', need, async (req, res) => {
    const out = await store.setName('producer', (req.body || {}).name, personOf(req));
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ name: out.profile && out.profile.display_name ? out.profile.display_name : 'The Producer' });
  });

  // #2915: a question about her own team's data. Read only: it reads the cards
  // and runs through the store and writes nothing (lib/ask-data.js).
  r.post('/api/team/question', need, async (req, res) => {
    const { answer } = require('../lib/ask-data');
    const profiles = new Map((store.profiles ? await store.profiles() : []).map((p) => [p.agent, p]));
    const members = listAgents().map((slug) => { const d = loadAgent(slug); return { slug, name: displayName(d, profiles.get(slug)), default_name: d.name }; });
    const out = await answer({ question: (req.body || {}).question, store, members, who: personOf(req), now: clock() });
    res.json(out);
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

module.exports = { createAgentsRouter, sourceView, characterOf, liveMissing, STALE_RUN_DAYS, isExec, watchNeed, REDO_MESSAGE };
