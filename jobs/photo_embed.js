#!/usr/bin/env node
// ORDER #1796: the photo archive's search-by-meaning step. RUNS ON THE BOX.
//
//   node jobs/photo_embed.js [--budget-min 90] [--batch 100]
//        computes the local SigLIP vector (#1790's model) for every photo with a
//        stored thumbnail and no vector yet, newest first, until the budget is
//        spent, and stores it in photo_embeddings. Resumable: the next run picks
//        up where this one stopped. Needs MARKETING_DATABASE_URL.
//
// No photo leaves the Box: the thumbnail is read from the marketing database
// and embedded in this process. Prints one `EMBED:` line for the job board.
// Exit 4 = the model package is not installed: nothing was embedded.
'use strict';

const M = require('../lib/photo-meaning');
const { loadTransformers, createLocalEmbedder } = require('../lib/photo-embed');
const { ensurePhotoTables } = require('../lib/photo-schema');

function parseArgs(argv) {
  const val = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
  const budgetMin = Number(val('--budget-min', 90));
  const batch = Number(val('--batch', 100));
  if (!(budgetMin > 0) || !(batch >= 1)) throw new Error('--budget-min must be above 0 and --batch 1 or more');
  return { budgetMin, batch };
}

async function main({ argv = process.argv.slice(2), pool, makePool, embedder, makeEmbedder, log = console.log, now,
  gate } = {}) {
  const args = parseArgs(argv);
  const e = embedder || (makeEmbedder && makeEmbedder());
  if (!e) {
    const err = new Error('EMBED SKIPPED: @huggingface/transformers is not installed (npm install in ~/repos/marketing-dashboard). Nothing embedded.');
    err.exitCode = 4;
    throw err;
  }
  const db = pool || (makePool && makePool());
  if (!db) throw new Error('needs MARKETING_DATABASE_URL');
  await ensurePhotoTables(db);
  return M.embedPending({ pool: db, embedder: e, model: e.model || M.MODEL_ID,
    budgetMs: args.budgetMin * 60 * 1000, batch: args.batch, log, ...(now ? { now } : {}), ...(gate ? { gate } : {}) });
}

// ORDER #1797's bonus window and usage guard (lib/photo-window.js), asked before
// each batch, once that order is on main. Until then there is no gate to ask.
function windowGate() {
  try { return require('../lib/photo-window').photoGate(); } catch (_) { return undefined; }
}

if (require.main === module) {
  const makeEmbedder = () => createLocalEmbedder({ tf: loadTransformers(), side: 'image' });
  const makePool = () => {
    if (!process.env.MARKETING_DATABASE_URL) return null;
    const { Pool } = require('pg');
    return new Pool({ connectionString: process.env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  };
  let pool = null;
  main({ makeEmbedder, makePool: () => (pool = makePool()), gate: windowGate() })
    .then(() => (pool ? pool.end() : null))
    .catch((e) => { console.error(`photo_embed FAILED: ${e.message}`); process.exitCode = e.exitCode || 1; if (pool) pool.end(); });
}

module.exports = { main, parseArgs, windowGate };
