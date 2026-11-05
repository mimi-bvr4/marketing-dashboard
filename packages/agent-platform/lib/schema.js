// ORDER #2963 build step 3: storage keeps its table names; every shared agent
// table gains a `department` column so two departments can share one database
// with their rows apart. The default is the app's FIRST department, so rows
// written before the switch keep working with no backfill.
//
// Idempotent and additive only: ADD COLUMN IF NOT EXISTS on ALTER TABLE IF EXISTS,
// plus indexes. Nothing is dropped, renamed or rewritten. A department-only table
// (for example a competitor list) stays in its own app and is not listed here.
//
// The module never opens a connection: the app hands it a db handle (anything
// with an async query(sql) method, a pg Pool or Client).
'use strict';

const SHARED_TABLES = Object.freeze([
  'agent_runs', 'agent_cards', 'agent_settings', 'agent_asks', 'agent_run_requests',
  'agent_profiles', 'agent_profile_log', 'agent_watchlist', 'agent_snapshots', 'agent_chains',
  'producer_calendar', 'producer_calendar_log', 'producer_log', 'reviewer_visits',
]);

// The tables a department's pages filter most; each gets a (department, ...) index.
const DEPARTMENT_INDEXES = Object.freeze([
  ['idx_agent_cards_department', 'agent_cards', 'department, status, created_at DESC'],
  ['idx_agent_runs_department', 'agent_runs', 'department, started_at DESC'],
  ['idx_agent_run_requests_department', 'agent_run_requests', 'department, status'],
]);

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function departmentMigrationSql(defaultDepartmentId) {
  const id = String(defaultDepartmentId || '');
  // The id is written into SQL as a literal, so it must be a plain department id and nothing else.
  if (!ID_RE.test(id)) throw new Error(`department migration: "${id}" is not a department id`);
  return [
    ...SHARED_TABLES.map((t) => `ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT '${id}'`),
    ...DEPARTMENT_INDEXES.map(([name, table, cols]) => `CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${cols})`),
  ];
}

async function ensureDepartmentColumn(db, defaultDepartmentId) {
  if (!db || typeof db.query !== 'function') throw new Error('department migration: needs a db handle with query()');
  const sqls = departmentMigrationSql(defaultDepartmentId);
  for (const sql of sqls) await db.query(sql);
  return sqls.length;
}

module.exports = { SHARED_TABLES, DEPARTMENT_INDEXES, departmentMigrationSql, ensureDepartmentColumn };
