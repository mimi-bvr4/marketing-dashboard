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
  'CREATE INDEX IF NOT EXISTS idx_agent_cards_agent ON agent_cards(agent, created_at DESC)',
];

async function ensureAgentTables(pool) {
  if (!pool) return;
  for (const q of SCHEMA_SQL) await pool.query(q);
}

const DECISIONS = new Set(['approve', 'reject', 'edit']);

// The one rule both stores share. Returns { ok, error } or the new fields.
function decide(card, { action, who, reason, body }, lint) {
  if (!DECISIONS.has(action)) return { error: 'unknown action' };
  if (!who) return { error: 'no person to record' };
  if (action === 'reject') {
    if (!reason || !String(reason).trim()) return { error: 'a reject needs a one-line reason' };
    return { fields: { status: 'rejected', reason: String(reason).trim().slice(0, 500), decided_by: who } };
  }
  if (action === 'edit') {
    if (!body || !String(body).trim()) return { error: 'an edit needs the new text' };
    const checks = { ...(card.checks || {}), ai_tells: lint(body) };
    return { fields: { body: String(body), edited: true, checks, decided_by: who, status: 'draft' } };
  }
  const tells = lint(card.body);
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
      const vals = cols.map((c) => (c === 'checks' ? JSON.stringify(f[c]) : f[c]));
      const row = (await pool.query(`UPDATE agent_cards SET ${sets}, decided_at = now() WHERE id = $1 RETURNING *`, [id, ...vals])).rows[0];
      return { card: row };
    },
    async insert(c) {
      return (await pool.query(`INSERT INTO agent_cards (agent, agent_name, job, target, title, body, sources, checks, run_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [c.agent, c.agent_name, c.job, c.target || null, c.title, c.body, JSON.stringify(c.sources || []),
        JSON.stringify(c.checks || {}), c.run_id || null])).rows[0];
    },
    async lastRejections(agent, n = 10) {
      return (await pool.query(`SELECT title, reason FROM agent_cards WHERE agent = $1 AND status = 'rejected'
        ORDER BY decided_at DESC NULLS LAST LIMIT $2`, [agent, n])).rows;
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
        decided_at: null, created_at: now(), target: null, sources: [], checks: {}, run_id: null, ...c };
      cards.push(row);
      return row;
    },
    async lastRejections(agent, n = 10) {
      return cards.filter((c) => c.agent === agent && c.status === 'rejected').slice(-n).map((c) => ({ title: c.title, reason: c.reason }));
    },
    async startRun(agent) { runList.push({ id: runList.length + 1, agent, status: 'running', started_at: now() }); return runList.length; },
    async finishRun(id, f) { Object.assign(runList[id - 1], f, { finished_at: now() }); },
    async runs() {
      const last = new Map();
      for (const r of runList) last.set(r.agent, r);
      return [...last.values()];
    },
  };
}

module.exports = { SCHEMA_SQL, ensureAgentTables, createPgStore, createMemoryStore, decide };
