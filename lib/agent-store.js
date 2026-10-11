// ORDER #1015 Part 2: the Review queue's tables and store.
//
// agent_cards  one row per DRAFT an agent wrote. Approve never publishes, sends,
//              posts or spends: it moves the card to 'ready' for a human to use.
// agent_runs   one row per run, done or failed, so a dead agent is visible.
//
// Idempotent, db.js style (this Postgres is in the Box's nightly backup set).
// The memory store has the same semantics, for tests and dry runs.
'use strict';

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'running', cards INTEGER NOT NULL DEFAULT 0,
    unavailable JSONB NOT NULL DEFAULT '[]', note TEXT)`,
  `CREATE TABLE IF NOT EXISTS agent_cards (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, agent_name TEXT NOT NULL, job TEXT NOT NULL,
    target TEXT, title TEXT NOT NULL, body TEXT NOT NULL, sources JSONB NOT NULL DEFAULT '[]',
    checks JSONB NOT NULL DEFAULT '{}', run_id INTEGER,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'rejected')),
    edited BOOLEAN NOT NULL DEFAULT false, reason TEXT, decided_by TEXT, decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS idx_agent_cards_status ON agent_cards(status, created_at DESC)',
  // #1658: the structured post a card carries (Bloggy Bob) and what happened
  // when it was handed to WordPress after approval.
  'ALTER TABLE agent_cards ADD COLUMN IF NOT EXISTS payload JSONB',
  'ALTER TABLE agent_cards ADD COLUMN IF NOT EXISTS handoff JSONB',
  // #1658 Agents page: Katherine's edits to a bot, every save a new version
  // (never an update), so any earlier version can be put back.
  `CREATE TABLE IF NOT EXISTS agent_settings (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, version INTEGER NOT NULL, skill_md TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true, max_cards INTEGER NOT NULL DEFAULT 3, note TEXT,
    edited_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (agent, version))`,
  // #1658 character cards: Katherine asks a bot for a new ability; the Box sorts
  // it (instructions / build / cant). An instruction change waits for an exec.
  `CREATE TABLE IF NOT EXISTS agent_asks (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, ask TEXT NOT NULL, asked_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'sorting', 'awaiting_exec', 'applied', 'declined', 'building', 'built', 'cant', 'failed')),
    kind TEXT, triage JSONB, order_file TEXT, decided_by TEXT, decided_at TIMESTAMPTZ, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS agent_run_requests (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, ask TEXT, requested_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), picked_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, note TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_agent_cards_agent ON agent_cards(agent, created_at DESC)',
];

async function ensureAgentTables(pool) {
  if (!pool) return;
  for (const q of SCHEMA_SQL) await pool.query(q);
}

const DECISIONS = new Set(['approve', 'reject', 'edit']);

// The checks on a settings save, shared by both stores.
const MAX_SKILL = 40000;
function checkSettings({ skill_md, enabled, max_cards, who }) {
  if (!who) return { error: 'no person to record' };
  if (typeof skill_md !== 'string' || !skill_md.trim()) return { error: 'the instructions cannot be empty' };
  if (skill_md.length > MAX_SKILL) return { error: `the instructions are over ${MAX_SKILL} characters` };
  const n = Number(max_cards);
  if (!Number.isInteger(n) || n < 1 || n > 10) return { error: 'drafts per run must be 1 to 10' };
  return { row: { skill_md, enabled: enabled !== false, max_cards: n } };
}

// The one rule both stores share. Returns { ok, error } or the new fields.
function decide(card, { action, who, reason, body }, lint) {
  if (!DECISIONS.has(action)) return { error: 'unknown action' };
  if (!who) return { error: 'no person to record' };
  if (action === 'reject') {
    if (!reason || !String(reason).trim()) return { error: 'a reject needs a one-line reason' };
    return { fields: { status: 'rejected', reason: String(reason).trim().slice(0, 500), decided_by: who } };
  }
  const post = card.payload && card.payload.post;
  if (action === 'edit') {
    if (!body || !String(body).trim()) return { error: 'an edit needs the new text' };
    // A card that carries a post (Bloggy Bob): the edit IS the post, so the
    // WordPress draft gets what Katherine wrote, not the original.
    if (post) {
      const payload = { ...card.payload, post: { ...post, content_md: String(body) } };
      const checks = { ...(card.checks || {}), ai_tells: lint(card.body + '\n' + body) };
      return { fields: { payload, edited: true, checks, decided_by: who, status: 'draft' } };
    }
    const checks = { ...(card.checks || {}), ai_tells: lint(body) };
    return { fields: { body: String(body), edited: true, checks, decided_by: who, status: 'draft' } };
  }
  const own = require('./agent-runner').modelText(card.body);
  const tells = lint((card.title || '') + '\n' + own + (post ? '\n' + post.content_md + '\n' + (post.title || '') : ''));
  if (tells.fails.length) return { error: 'this draft has an em dash or spaced en dash; edit it before marking ready' };
  return { fields: { status: 'ready', decided_by: who, reason: reason ? String(reason).slice(0, 500) : null } };
}

function createPgStore(pool, { lint }) {
  return {
    async list({ status = 'draft', agent, limit = 100 } = {}) {
      const args = [status];
      let sql = 'SELECT * FROM agent_cards WHERE status = $1';
      if (agent) { args.push(agent); sql += ` AND agent = $${args.length}`; }
      args.push(Math.min(Number(limit) || 100, 200));
      sql += ` ORDER BY created_at DESC LIMIT $${args.length}`;
      return (await pool.query(sql, args)).rows;
    },
    async get(id) { return (await pool.query('SELECT * FROM agent_cards WHERE id = $1', [id])).rows[0] || null; },
    async decide(id, d) {
      const card = await this.get(id);
      if (!card) return { error: 'no such card', status: 404 };
      const r = decide(card, d, lint);
      if (r.error) return r;
      const f = r.fields;
      const cols = Object.keys(f);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const vals = cols.map((c) => (c === 'checks' || c === 'payload' ? JSON.stringify(f[c]) : f[c]));
      const row = (await pool.query(`UPDATE agent_cards SET ${sets}, decided_at = now() WHERE id = $1 RETURNING *`, [id, ...vals])).rows[0];
      return { card: row };
    },
    async insert(c) {
      return (await pool.query(`INSERT INTO agent_cards (agent, agent_name, job, target, title, body, sources, checks, run_id, payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [c.agent, c.agent_name, c.job, c.target || null, c.title, c.body, JSON.stringify(c.sources || []),
        JSON.stringify(c.checks || {}), c.run_id || null, c.payload ? JSON.stringify(c.payload) : null])).rows[0];
    },
    // Ready cards that carry a post and were never handed off. One card, one post, ever.
    async readyForHandoff(limit = 20) {
      return (await pool.query(`SELECT * FROM agent_cards WHERE status = 'ready' AND payload IS NOT NULL
        AND payload ? 'post' AND handoff IS NULL ORDER BY decided_at LIMIT $1`, [limit])).rows;
    },
    async setHandoff(id, h) {
      await pool.query('UPDATE agent_cards SET handoff = $2 WHERE id = $1 AND handoff IS NULL', [id, JSON.stringify(h)]);
    },
    async lastRejections(agent, n = 10) {
      return (await pool.query(`SELECT title, reason FROM agent_cards WHERE agent = $1 AND status = 'rejected'
        ORDER BY decided_at DESC NULLS LAST LIMIT $2`, [agent, n])).rows;
    },
    async currentSettings(agent) {
      return (await pool.query('SELECT * FROM agent_settings WHERE agent = $1 ORDER BY version DESC LIMIT 1', [agent])).rows[0] || null;
    },
    async allCurrentSettings() {
      return (await pool.query('SELECT DISTINCT ON (agent) * FROM agent_settings ORDER BY agent, version DESC')).rows;
    },
    async settingsHistory(agent, limit = 50) {
      return (await pool.query('SELECT * FROM agent_settings WHERE agent = $1 ORDER BY version DESC LIMIT $2', [agent, limit])).rows;
    },
    async saveSettings(agent, input) {
      const c = checkSettings(input);
      if (c.error) return c;
      const r = c.row;
      const row = (await pool.query(`INSERT INTO agent_settings (agent, version, skill_md, enabled, max_cards, note, edited_by)
        VALUES ($1, COALESCE((SELECT MAX(version) FROM agent_settings WHERE agent = $1), 0) + 1, $2, $3, $4, $5, $6) RETURNING *`,
      [agent, r.skill_md, r.enabled, r.max_cards, input.note ? String(input.note).slice(0, 300) : null, input.who])).rows[0];
      return { settings: row };
    },
    async revertSettings(agent, version, who) {
      const old = (await pool.query('SELECT * FROM agent_settings WHERE agent = $1 AND version = $2', [agent, version])).rows[0];
      if (!old) return { error: 'no such version', status: 404 };
      return this.saveSettings(agent, { skill_md: old.skill_md, enabled: old.enabled, max_cards: old.max_cards,
        note: `put back version ${version}`, who });
    },
    async queueRun(agent, ask, who) {
      if (!who) return { error: 'no person to record' };
      const open = (await pool.query("SELECT id FROM agent_run_requests WHERE agent = $1 AND status IN ('queued','running')", [agent])).rows[0];
      if (open) return { error: 'this agent already has a run waiting', status: 409 };
      return { request: (await pool.query('INSERT INTO agent_run_requests (agent, ask, requested_by) VALUES ($1,$2,$3) RETURNING *',
        [agent, ask ? String(ask).slice(0, 4000) : null, who])).rows[0] };
    },
    async takeRunRequests(limit = 5) {
      return (await pool.query(`UPDATE agent_run_requests SET status = 'running', picked_at = now()
        WHERE id IN (SELECT id FROM agent_run_requests WHERE status = 'queued' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [limit])).rows;
    },
    async finishRunRequest(id, ok, note) {
      await pool.query('UPDATE agent_run_requests SET status = $2, finished_at = now(), note = $3 WHERE id = $1', [id, ok ? 'done' : 'failed', note || null]);
    },
    async runRequests(limit = 20) {
      return (await pool.query('SELECT * FROM agent_run_requests ORDER BY created_at DESC LIMIT $1', [limit])).rows;
    },
    // #1658 Monday digest: the last 7 days, per agent.
    async weekStats() {
      const cards = (await pool.query(`SELECT agent, status, count(*)::int AS n FROM agent_cards
        WHERE created_at > now() - interval '7 days' AND agent <> 'digest' GROUP BY agent, status`)).rows;
      const runs = (await pool.query(`SELECT agent, status, unavailable FROM agent_runs
        WHERE started_at > now() - interval '7 days' AND agent <> 'digest'`)).rows;
      return { cards, runs };
    },
    async createAsk(agent, ask, who) {
      if (!who) return { error: 'no person to record' };
      const t = String(ask || '').trim();
      if (t.length < 5) return { error: 'say what you want it to do' };
      if (t.length > 2000) return { error: 'keep the ask under 2000 characters' };
      return { ask: (await pool.query('INSERT INTO agent_asks (agent, ask, asked_by) VALUES ($1,$2,$3) RETURNING *', [agent, t, who])).rows[0] };
    },
    async listAsks(agent) {
      return (await pool.query('SELECT * FROM agent_asks WHERE ($1::text IS NULL OR agent = $1) ORDER BY created_at DESC LIMIT 200', [agent || null])).rows;
    },
    async getAsk(id) { return (await pool.query('SELECT * FROM agent_asks WHERE id = $1', [id])).rows[0] || null; },
    async takeNewAsks(limit = 5) {
      return (await pool.query(`UPDATE agent_asks SET status = 'sorting' WHERE id IN (SELECT id FROM agent_asks WHERE status = 'new'
        ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`, [limit])).rows;
    },
    async updateAsk(id, f) {
      const cols = Object.keys(f);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const vals = cols.map((c) => (c === 'triage' ? JSON.stringify(f[c]) : f[c]));
      return (await pool.query(`UPDATE agent_asks SET ${sets} WHERE id = $1 RETURNING *`, [id, ...vals])).rows[0];
    },
    async startRun(agent) { return (await pool.query('INSERT INTO agent_runs (agent) VALUES ($1) RETURNING id', [agent])).rows[0].id; },
    async finishRun(id, { status, cards, unavailable, note }) {
      await pool.query(`UPDATE agent_runs SET finished_at = now(), status = $2, cards = $3, unavailable = $4, note = $5 WHERE id = $1`,
        [id, status, cards || 0, JSON.stringify(unavailable || []), note || null]);
    },
    async runs(limit = 30) {
      return (await pool.query(`SELECT DISTINCT ON (agent) * FROM agent_runs ORDER BY agent, started_at DESC LIMIT $1`, [limit])).rows;
    },
  };
}

function createMemoryStore({ lint, now = () => new Date() }) {
  const cards = [];
  const runList = [];
  const settings = [];
  const requests = [];
  const asks = [];
  return {
    cards, runList,
    async list({ status = 'draft', agent } = {}) {
      return cards.filter((c) => c.status === status && (!agent || c.agent === agent)).slice().reverse();
    },
    async get(id) { return cards.find((c) => c.id === Number(id)) || null; },
    async decide(id, d) {
      const card = await this.get(id);
      if (!card) return { error: 'no such card', status: 404 };
      const r = decide(card, d, lint);
      if (r.error) return r;
      Object.assign(card, r.fields, { decided_at: now() });
      return { card };
    },
    async insert(c) {
      const row = { id: cards.length + 1, status: 'draft', edited: false, reason: null, decided_by: null,
        decided_at: null, created_at: now(), target: null, sources: [], checks: {}, run_id: null, payload: null, handoff: null, ...c };
      cards.push(row);
      return row;
    },
    async readyForHandoff() { return cards.filter((c) => c.status === 'ready' && c.payload && c.payload.post && !c.handoff); },
    async setHandoff(id, h) { const c = cards.find((x) => x.id === id); if (c && !c.handoff) c.handoff = h; },
    async lastRejections(agent, n = 10) {
      return cards.filter((c) => c.agent === agent && c.status === 'rejected').slice(-n).map((c) => ({ title: c.title, reason: c.reason }));
    },
    asks,
    async createAsk(agent, ask, who) {
      if (!who) return { error: 'no person to record' };
      const t = String(ask || '').trim();
      if (t.length < 5) return { error: 'say what you want it to do' };
      if (t.length > 2000) return { error: 'keep the ask under 2000 characters' };
      const a = { id: asks.length + 1, agent, ask: t, asked_by: who, created_at: now(), status: 'new', kind: null, triage: null, order_file: null, decided_by: null, decided_at: null, note: null };
      asks.push(a);
      return { ask: a };
    },
    async listAsks(agent) { return asks.filter((a) => !agent || a.agent === agent).slice().reverse(); },
    async getAsk(id) { return asks.find((a) => a.id === Number(id)) || null; },
    async takeNewAsks() { const q = asks.filter((a) => a.status === 'new'); q.forEach((a) => { a.status = 'sorting'; }); return q; },
    async updateAsk(id, f) { const a = asks.find((x) => x.id === id); Object.assign(a, f); return a; },
    settings, requests,
    async weekStats() {
      const m = new Map();
      for (const c of cards.filter((x) => x.agent !== 'digest')) { const k = c.agent + '|' + c.status; m.set(k, (m.get(k) || 0) + 1); }
      return { cards: [...m].map(([k, n]) => ({ agent: k.split('|')[0], status: k.split('|')[1], n })),
        runs: runList.filter((r) => r.agent !== 'digest').map((r) => ({ agent: r.agent, status: r.status, unavailable: r.unavailable || [] })) };
    },
    async currentSettings(agent) { return settings.filter((x) => x.agent === agent).slice(-1)[0] || null; },
    async allCurrentSettings() { const m = new Map(); for (const x of settings) m.set(x.agent, x); return [...m.values()]; },
    async settingsHistory(agent) { return settings.filter((x) => x.agent === agent).slice().reverse(); },
    async saveSettings(agent, input) {
      const c = checkSettings(input);
      if (c.error) return c;
      const version = settings.filter((x) => x.agent === agent).length + 1;
      const row = { id: settings.length + 1, agent, version, ...c.row, note: input.note || null, edited_by: input.who, created_at: now() };
      settings.push(row);
      return { settings: row };
    },
    async revertSettings(agent, version, who) {
      const old = settings.find((x) => x.agent === agent && x.version === Number(version));
      if (!old) return { error: 'no such version', status: 404 };
      return this.saveSettings(agent, { skill_md: old.skill_md, enabled: old.enabled, max_cards: old.max_cards, note: `put back version ${version}`, who });
    },
    async queueRun(agent, ask, who) {
      if (!who) return { error: 'no person to record' };
      if (requests.some((r) => r.agent === agent && ['queued', 'running'].includes(r.status))) return { error: 'this agent already has a run waiting', status: 409 };
      const r = { id: requests.length + 1, agent, ask: ask || null, requested_by: who, status: 'queued', created_at: now() };
      requests.push(r);
      return { request: r };
    },
    async takeRunRequests() { const q = requests.filter((r) => r.status === 'queued'); q.forEach((r) => { r.status = 'running'; r.picked_at = now(); }); return q; },
    async finishRunRequest(id, ok, note) { Object.assign(requests.find((r) => r.id === id), { status: ok ? 'done' : 'failed', note: note || null, finished_at: now() }); },
    async runRequests() { return requests.slice().reverse(); },
    async startRun(agent) { runList.push({ id: runList.length + 1, agent, status: 'running', started_at: now() }); return runList.length; },
    async finishRun(id, f) { Object.assign(runList[id - 1], f, { finished_at: now() }); },
    async runs() {
      const last = new Map();
      for (const r of runList) last.set(r.agent, r);
      return [...last.values()];
    },
  };
}

module.exports = { SCHEMA_SQL, ensureAgentTables, createPgStore, createMemoryStore, decide, checkSettings, MAX_SKILL };
