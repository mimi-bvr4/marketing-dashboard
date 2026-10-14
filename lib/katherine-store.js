// ORDER #1717: the last nightly read of Katherine's files, one row per source.
// The Box writes it (jobs/katherine_files.js); Railway only reads it, so Railway
// never holds a Drive credential (#1239 ARCHITECTURE). Idempotent DDL: this
// Postgres is in the Box's nightly backup set.
'use strict';

const SOURCES = ['master', 'followers'];

async function ensureKatherineTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS katherine_reads (
    source TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    source_name TEXT,
    source_modified TIMESTAMPTZ,
    read_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

function createKatherineStore(pool) {
  return {
    async put(source, { payload, sourceName = null, sourceModified = null }) {
      if (!SOURCES.includes(source)) throw new Error(`unknown source ${source}`);
      await pool.query(
        `INSERT INTO katherine_reads (source, payload, source_name, source_modified, read_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (source) DO UPDATE SET payload = EXCLUDED.payload, source_name = EXCLUDED.source_name,
           source_modified = EXCLUDED.source_modified, read_at = now()`,
        [source, JSON.stringify(payload), sourceName, sourceModified]);
    },
    async get(source) {
      const { rows } = await pool.query(
        'SELECT source, payload, source_name, source_modified, read_at FROM katherine_reads WHERE source = $1', [source]);
      return rows[0] || null;
    },
  };
}

module.exports = { ensureKatherineTables, createKatherineStore, SOURCES };
