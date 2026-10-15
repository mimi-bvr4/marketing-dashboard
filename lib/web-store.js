// ORDER #1873: the Web Agent's two tables. Katherine's uploads wait in
// web_requests until the Box builds the draft (Railway never holds a WordPress
// credential); every WordPress write, and every refused publish, is a row in
// web_log with its post id. Idempotent DDL; a memory store with the same
// methods backs the tests.
'use strict';

const MAX_OPEN_PER_PERSON = 3;

const DDL = [
  `CREATE TABLE IF NOT EXISTS web_requests (
     id SERIAL PRIMARY KEY,
     site TEXT NOT NULL,
     page_id INTEGER,
     new_title TEXT,
     html TEXT NOT NULL,
     assets JSONB NOT NULL DEFAULT '[]',
     asked_by TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'queued',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     started_at TIMESTAMPTZ,
     finished_at TIMESTAMPTZ,
     result JSONB,
     error TEXT,
     card_id INTEGER)`,
  'CREATE INDEX IF NOT EXISTS web_requests_status ON web_requests (status, id)',
  `CREATE TABLE IF NOT EXISTS web_log (
     id SERIAL PRIMARY KEY,
     request_id INTEGER,
     site TEXT,
     action TEXT NOT NULL,
     post_id INTEGER,
     detail TEXT,
     who TEXT,
     at TIMESTAMPTZ NOT NULL DEFAULT now())`,
];

async function ensureWebTables(pool) { for (const s of DDL) await pool.query(s); }

const tooMany = { error: `You have ${MAX_OPEN_PER_PERSON} pages waiting already. The Box builds them every 15 minutes.`, status: 429 };
const LIST_COLS = "id, site, page_id, new_title, asked_by, status, created_at, finished_at, error, card_id, result - 'shots' AS result";

function createPgStore(pool) {
  return {
    async queue(r, who) {
      const open = await pool.query("SELECT count(*)::int AS n FROM web_requests WHERE asked_by = $1 AND status IN ('queued', 'running')", [who]);
      if (open.rows[0].n >= MAX_OPEN_PER_PERSON) return tooMany;
      const q = await pool.query(`INSERT INTO web_requests (site, page_id, new_title, html, assets, asked_by) VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id, site, page_id, new_title, asked_by, status, created_at`, [r.site, r.page_id || null, r.new_title || null, r.html, JSON.stringify(r.assets || []), who]);
      return { request: q.rows[0] };
    },
    async list(limit = 30) { return (await pool.query(`SELECT ${LIST_COLS} FROM web_requests ORDER BY id DESC LIMIT $1`, [limit])).rows; },
    async get(id) { return (await pool.query('SELECT * FROM web_requests WHERE id = $1', [id])).rows[0] || null; },
    // FOR UPDATE SKIP LOCKED: two Box runs never build the same page.
    async take(n = 2) {
      return (await pool.query(`UPDATE web_requests SET status = 'running', started_at = now()
        WHERE id IN (SELECT id FROM web_requests WHERE status = 'queued' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [n])).rows;
    },
    async finish(id, { result, error, card_id }) {
      await pool.query('UPDATE web_requests SET status = $2, finished_at = now(), result = $3, error = $4, card_id = $5 WHERE id = $1',
        [id, error ? 'failed' : 'done', result ? JSON.stringify(result) : null, error || null, card_id || null]);
    },
    // Publish (only ever reached with the switch ON): the Box takes these next run.
    async requestPublish(id, who) {
      return (await pool.query("UPDATE web_requests SET status = 'publish_queued', result = result || jsonb_build_object('publish_requested_by', $2::text) WHERE id = $1 AND status = 'done' RETURNING id", [id, who])).rows[0] || null;
    },
    async takePublish(n = 2) {
      return (await pool.query(`UPDATE web_requests SET status = 'publishing'
        WHERE id IN (SELECT id FROM web_requests WHERE status = 'publish_queued' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`, [n])).rows;
    },
    async setStatus(id, status, extra = {}) {
      await pool.query('UPDATE web_requests SET status = $2, result = result || $3::jsonb WHERE id = $1', [id, status, JSON.stringify(extra)]);
    },
    async log(e) {
      await pool.query('INSERT INTO web_log (request_id, site, action, post_id, detail, who) VALUES ($1,$2,$3,$4,$5,$6)',
        [e.request_id || null, e.site || null, e.action, e.post_id || null, e.detail ? String(e.detail).slice(0, 20000) : null, e.who || 'box']);
    },
    async logs(requestId) { return (await pool.query('SELECT id, action, post_id, detail, who, at FROM web_log WHERE request_id = $1 ORDER BY id', [requestId])).rows; },
  };
}

function createMemoryStore() {
  const rows = []; const logRows = []; let next = 1;
  const view = (r) => { const { html, assets, ...v } = r; return { ...v, result: r.result ? (({ shots, ...x }) => x)(r.result) : null }; };
  return {
    rows, logRows,
    async queue(r, who) {
      if (rows.filter((x) => x.asked_by === who && ['queued', 'running'].includes(x.status)).length >= MAX_OPEN_PER_PERSON) return tooMany;
      const x = { id: next++, site: r.site, page_id: r.page_id || null, new_title: r.new_title || null, html: r.html, assets: r.assets || [], asked_by: who,
        status: 'queued', created_at: new Date(), started_at: null, finished_at: null, result: null, error: null, card_id: null };
      rows.push(x);
      return { request: { id: x.id, site: x.site, page_id: x.page_id, new_title: x.new_title, asked_by: who, status: x.status, created_at: x.created_at } };
    },
    async list(limit = 30) { return rows.slice().reverse().slice(0, limit).map(view); },
    async get(id) { return rows.find((x) => x.id === Number(id)) || null; },
    async take(n = 2) { return rows.filter((x) => x.status === 'queued').slice(0, n).map((x) => { x.status = 'running'; x.started_at = new Date(); return x; }); },
    async finish(id, { result, error, card_id }) {
      Object.assign(rows.find((x) => x.id === id), { status: error ? 'failed' : 'done', finished_at: new Date(), result: result || null, error: error || null, card_id: card_id || null });
    },
    async requestPublish(id, who) {
      const x = rows.find((y) => y.id === Number(id) && y.status === 'done'); if (!x) return null;
      x.status = 'publish_queued'; x.result = { ...(x.result || {}), publish_requested_by: who }; return { id: x.id };
    },
    async takePublish(n = 2) { return rows.filter((x) => x.status === 'publish_queued').slice(0, n).map((x) => { x.status = 'publishing'; return x; }); },
    async setStatus(id, status, extra = {}) { const x = rows.find((y) => y.id === id); x.status = status; x.result = { ...(x.result || {}), ...extra }; },
    async log(e) { logRows.push({ id: logRows.length + 1, at: new Date(), who: 'box', ...e }); },
    async logs(requestId) { return logRows.filter((l) => l.request_id === requestId); },
  };
}

module.exports = { createPgStore, createMemoryStore, ensureWebTables, MAX_OPEN_PER_PERSON };
