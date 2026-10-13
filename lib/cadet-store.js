// ORDER #1688: the Collateral Cadet's two tables. Katherine's searches wait in
// cadet_asks until the Box runs them (Railway never holds a Drive credential,
// #1239); the Box also keeps its latest read of the Collateral Map in cadet_map
// so the page can show what has a link and what does not.
//
// Idempotent DDL (this database is in the Box's nightly backup set). A memory
// store with the same methods backs the tests.
'use strict';

const MAX_OPEN_PER_PERSON = 3;

const DDL = [
  `CREATE TABLE IF NOT EXISTS cadet_asks (
     id SERIAL PRIMARY KEY,
     phrase TEXT NOT NULL,
     asked_by TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'queued',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     started_at TIMESTAMPTZ,
     finished_at TIMESTAMPTZ,
     result JSONB,
     error TEXT)`,
  'CREATE INDEX IF NOT EXISTS cadet_asks_status ON cadet_asks (status, id)',
  `CREATE TABLE IF NOT EXISTS cadet_map (
     id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
     read_at TIMESTAMPTZ NOT NULL,
     materials JSONB NOT NULL,
     summary JSONB NOT NULL)`,
];

async function ensureCadetTables(pool) { for (const s of DDL) await pool.query(s); }

const tooMany = { error: `You have ${MAX_OPEN_PER_PERSON} searches waiting already. The Box runs them every 15 minutes.`, status: 429 };

function createPgStore(pool) {
  return {
    async queueAsk(phrase, who) {
      const open = await pool.query("SELECT count(*)::int AS n FROM cadet_asks WHERE asked_by = $1 AND status IN ('queued', 'running')", [who]);
      if (open.rows[0].n >= MAX_OPEN_PER_PERSON) return tooMany;
      const r = await pool.query('INSERT INTO cadet_asks (phrase, asked_by) VALUES ($1, $2) RETURNING id, phrase, asked_by, status, created_at', [phrase, who]);
      return { ask: r.rows[0] };
    },
    async asks(limit = 30) {
      const r = await pool.query(`SELECT id, phrase, asked_by, status, created_at, started_at, finished_at, error, result->'tally' AS tally
        FROM cadet_asks ORDER BY id DESC LIMIT $1`, [limit]);
      return r.rows;
    },
    async ask(id) { return (await pool.query('SELECT * FROM cadet_asks WHERE id = $1', [id])).rows[0] || null; },
    // FOR UPDATE SKIP LOCKED: two Box runs never take the same search.
    async takeAsks(n = 3) {
      const r = await pool.query(`UPDATE cadet_asks SET status = 'running', started_at = now()
        WHERE id IN (SELECT id FROM cadet_asks WHERE status = 'queued' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, phrase, asked_by`, [n]);
      return r.rows;
    },
    async finishAsk(id, { result, error }) {
      await pool.query("UPDATE cadet_asks SET status = $2, finished_at = now(), result = $3, error = $4 WHERE id = $1",
        [id, error ? 'failed' : 'done', result ? JSON.stringify(result) : null, error || null]);
    },
    async saveMap({ materials, summary, read_at = new Date() }) {
      await pool.query(`INSERT INTO cadet_map (id, read_at, materials, summary) VALUES (1, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET read_at = EXCLUDED.read_at, materials = EXCLUDED.materials, summary = EXCLUDED.summary`,
      [read_at, JSON.stringify(materials), JSON.stringify(summary)]);
    },
    async map() { return (await pool.query('SELECT read_at, materials, summary FROM cadet_map WHERE id = 1')).rows[0] || null; },
  };
}

function createMemoryStore() {
  const rows = [];
  let mapRow = null;
  let next = 1;
  const view = (a) => ({ id: a.id, phrase: a.phrase, asked_by: a.asked_by, status: a.status, created_at: a.created_at,
    started_at: a.started_at, finished_at: a.finished_at, error: a.error, tally: a.result ? a.result.tally : null });
  return {
    rows,
    async queueAsk(phrase, who) {
      if (rows.filter((a) => a.asked_by === who && ['queued', 'running'].includes(a.status)).length >= MAX_OPEN_PER_PERSON) return tooMany;
      const a = { id: next++, phrase, asked_by: who, status: 'queued', created_at: new Date(), started_at: null, finished_at: null, result: null, error: null };
      rows.push(a);
      return { ask: { id: a.id, phrase, asked_by: who, status: a.status, created_at: a.created_at } };
    },
    async asks(limit = 30) { return rows.slice().reverse().slice(0, limit).map(view); },
    async ask(id) { return rows.find((a) => a.id === id) || null; },
    async takeAsks(n = 3) {
      return rows.filter((a) => a.status === 'queued').slice(0, n).map((a) => { a.status = 'running'; a.started_at = new Date(); return { id: a.id, phrase: a.phrase, asked_by: a.asked_by }; });
    },
    async finishAsk(id, { result, error }) {
      const a = rows.find((x) => x.id === id);
      Object.assign(a, { status: error ? 'failed' : 'done', finished_at: new Date(), result: result || null, error: error || null });
    },
    async saveMap({ materials, summary, read_at = new Date() }) { mapRow = { read_at, materials, summary }; },
    async map() { return mapRow; },
  };
}

module.exports = { createPgStore, createMemoryStore, ensureCadetTables, MAX_OPEN_PER_PERSON };
