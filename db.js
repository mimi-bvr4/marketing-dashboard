// Fleet Contract v0 (ORDER #192): optional Postgres for the api_tokens store.
// The app boots + is discoverable WITHOUT a DB; token features light up when
// DATABASE_URL is set (add a Railway Postgres, set DATABASE_URL).
const { Pool } = require('pg');
const hasDb = !!process.env.DATABASE_URL;
const pool = hasDb
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false })
  : null;
async function ensureTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS api_tokens (
    id SERIAL PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
    label TEXT, user_id INTEGER, created_by TEXT, scope TEXT NOT NULL DEFAULT 'read',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)`);
  console.log('  [fleet] api_tokens ready');
}
module.exports = { pool, hasDb, ensureTables };
