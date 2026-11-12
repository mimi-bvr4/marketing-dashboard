'use strict';
// ORDER #3246: copy the Site Guardian watch's state file into guardian_state so
// the Agents page (on Railway) can read it. Run by brain-core
// box_jobs/site_guardian/run_watch.sh right after every 5-minute watch run:
//   railway run --service Postgres -- sh -c \
//     'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/guardian_publish.js <state.json>'
// It writes ONE row of this dashboard's own table and nothing else: no website,
// no WP Engine, no HubSpot, no message. Exit 0 published, 2 bad or missing
// file (nothing written), 3 no database.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_FILE = path.join(os.homedir(), 'Full_IH_Project', '05_AI_and_Brain', 'site_guardian_state', 'state.json');

async function publish({ store, file = DEFAULT_FILE, log = console.log }) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log(`NOT PUBLISHED: cannot read ${file} (${e.code || e.name})`); return 2; }
  if (!state || !state.generated_at || Number.isNaN(new Date(state.generated_at).getTime())) {
    log('NOT PUBLISHED: the state file has no generated_at'); return 2;
  }
  await store.putGuardianState(state);
  log(`published Site Guardian state of ${state.generated_at_ct || state.generated_at}`);
  return 0;
}

async function main({ env = process.env, argv = process.argv.slice(2), log = console.log } = {}) {
  if (!env.MARKETING_DATABASE_URL) { log('NOT RUN: MARKETING_DATABASE_URL is not set'); return 3; }
  const { Pool } = require('pg');
  const { SCHEMA_SQL, createPgStore } = require('../lib/agent-store');
  const { lint } = require('../lib/ai-tells');
  const pool = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    for (const q of SCHEMA_SQL.filter((s) => /guardian_state/.test(s))) await pool.query(q);
    return await publish({ store: createPgStore(pool, { lint }), file: argv[0] || DEFAULT_FILE, log });
  } finally { await pool.end(); }
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('guardian_publish:', e.message); process.exit(1); });

module.exports = { publish, DEFAULT_FILE };
