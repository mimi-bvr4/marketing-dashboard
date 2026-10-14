#!/usr/bin/env node
// ORDER #1717: read Katherine's Master Marketing Dashboard (.xlsx) and her IG
// Monthly Follower Counts sheet, nightly on the Box, into katherine_reads.
// Read-only on her files (drive.readonly client); writes only katherine_reads.
// A file that cannot be read keeps its last good read and is named in the log.
//   --dry   read and parse both files, print the shape, write nothing
'use strict';

const K = require('../lib/katherine-files');

async function runOnce({ store, drive, log = console.log, dry = false }) {
  let failed = 0;
  try {
    const { file, bytes } = await drive.downloadXlsx(K.MASTER_XLSX_ID);
    const parsed = K.readMasterWorkbook(bytes);
    const shape = Object.entries(parsed.blocks)
      .map(([k, b]) => `${k} ${b.months.filter((m) => m.entered).length} month(s) entered, ${b.columns.length} column(s)`).join('; ');
    if (!dry) await store.put('master', { payload: parsed, sourceName: file.name, sourceModified: file.modifiedTime || null });
    log(`master: ${file.name} (edited ${file.modifiedTime}): ${shape}`);
  } catch (e) { failed += 1; log(`master: NOT READ (${e.message}); the last read stays`); }
  try {
    const f = await drive.getFile(K.FOLLOWERS_SHEET_ID, 'id, name, modifiedTime');
    const parsed = K.parseFollowers(await K.readFollowerSheet(drive));
    const none = parsed.months.filter((m) => m.missing).map((m) => m.month);
    if (!dry) await store.put('followers', { payload: parsed, sourceName: f.name, sourceModified: f.modifiedTime || null });
    log(`followers: ${f.name}: ${parsed.months.length} month(s), ${parsed.accounts.length} account(s)${none.length ? `, no reading for ${none.join(' ')}` : ''}`);
  } catch (e) { failed += 1; log(`followers: NOT READ (${e.message}); the last read stays`); }
  return failed;
}

async function main({ env = process.env, argv = process.argv.slice(2), log = console.log } = {}) {
  const dry = argv.includes('--dry');
  const { createDriveClient } = require('../lib/drive-client');
  if (dry) return (await runOnce({ store: null, drive: createDriveClient(), log, dry })) ? 1 : 0;
  if (!env.MARKETING_DATABASE_URL) { log('NOT RUN: MARKETING_DATABASE_URL is not set (use --dry to preview)'); return 3; }
  const { Pool } = require('pg');
  const { ensureKatherineTables, createKatherineStore } = require('../lib/katherine-store');
  const pool = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await ensureKatherineTables(pool);
    return (await runOnce({ store: createKatherineStore(pool), drive: createDriveClient(), log })) ? 1 : 0;
  } finally { await pool.end(); }
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('katherine_files:', e.message); process.exit(1); });

module.exports = { runOnce, main };
