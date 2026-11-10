#!/usr/bin/env node
// ORDER #1240: the photo archive's AI tagger. RUNS ON THE BOX, never on Railway.
//
//   node jobs/photo_tag.js --sample --listing <files.json> --out <dir>
//        tags a 20-photo sample IN MEMORY, writes NOTHING to any database. The
//        listing is `photo_crawl.js --dry-run --listing-out <files.json>`. Writes
//        each thumbnail and a grading sheet to <dir> for grading by eye.
//   node jobs/photo_tag.js --apply [--cap 500] [--batch 10]
//        ORDER #1796: tags up to --cap PICKED photos (photo_picks, after a sweep
//        of the agent cards for archive photos they name) with the Opus-class
//        model, and writes their AI rows to photo_tags. Nothing unpicked is
//        ever sent. Needs MARKETING_DATABASE_URL.
//
// The key is found by name (env, Keychain, brain config) and never printed.
// Exit 4 = no key: nothing was sent.
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('../lib/photo-archive');
const T = require('../lib/photo-tagger');
const { ensurePhotoTables } = require('../lib/photo-schema');
const { sweepCardPicks, writePickTags } = require('../lib/photo-picks');
const C = require('../lib/photo-clusters');
const { MODEL_ID: VECTOR_MODEL } = require('../lib/photo-meaning');

function parseArgs(argv) {
  const modes = ['--sample', '--apply', '--clusters'].filter((m) => argv.includes(m));
  if (modes.length > 1) throw new Error('pick one of --sample, --apply, --clusters');
  const val = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
  const mode = (modes[0] || '--sample').slice(2);
  // ORDER #3085: in --clusters the cap counts SEEDS (model calls), not photos.
  const cap = Number(val('--cap', mode === 'clusters' ? 300 : 500));
  const batch = Number(val('--batch', 10));
  const threshold = Number(val('--threshold', C.THRESHOLD));
  if (!(cap >= 0) || !(batch >= 1)) throw new Error('--cap must be 0 or more and --batch 1 or more');
  if (!(threshold > 0 && threshold < 1)) throw new Error('--threshold is a cosine between 0 and 1');
  const dryRun = argv.includes('--dry-run');
  if (dryRun && mode !== 'clusters') throw new Error('--dry-run goes with --clusters');
  return { mode, cap, batch, threshold, dryRun, listing: val('--listing'), out: val('--out') };
}

async function loadVocab(pool) {
  const v = (await pool.query('SELECT tag, grp FROM photo_vocab')).rows;
  const s = (await pool.query('SELECT word, tag FROM photo_synonyms')).rows;
  return T.vocabFromRows(v, s);
}

// ------------------------------------------------------------- --sample

async function sample({ args, drive, model, log, vocabSrc }) {
  if (!args.listing || !args.out) throw new Error('--sample needs --listing <files.json> and --out <dir>');
  const files = JSON.parse(fs.readFileSync(args.listing, 'utf8'));
  const { sample: picked, corporate, venues } = T.pickSample(files);
  log(`SAMPLE: ${picked.length} photos, ${corporate} corporate or NLP, venues ${venues.join(', ') || '(none)'}`);
  const vocab = A.buildVocabulary(vocabSrc);
  const prompt = T.buildPrompt(vocabSrc);
  fs.mkdirSync(args.out, { recursive: true });
  const photos = picked.map((f, i) => ({ drive_id: f.id, n: i + 1, file: f }));
  const thumbs = new Map();
  const run = await T.tagBatch({
    photos, model, vocab, prompt, cap: photos.length, batchSize: args.batch, log,
    getThumb: async (p) => {
      const t = await drive.thumbnail(p.file);
      if (!t) throw new Error('no thumbnail link');
      thumbs.set(p.drive_id, `photo_${String(p.n).padStart(2, '0')}.jpg`);
      fs.writeFileSync(path.join(args.out, thumbs.get(p.drive_id)), t.bytes);
      return t.bytes;
    },
  });
  const rows = run.results.sort((a, b) => a.photo.n - b.photo.n).map((r) => [
    `| ${r.photo.n} | ${thumbs.get(r.photo.drive_id)} | ${r.photo.file.path.join(' / ')} |`,
    ` ${r.ai.map((t) => `${t.tag} (${t.confidence})`).join(', ')} | ${r.event_type_guess || ''} |`,
    ` ${r.dropped.map((d) => `${d.tag}: ${d.why}`).join('; ')} | | | |`].join(''));
  const sheet = [`# #1240 sample, model ${model.model || T.MODEL}`, '',
    '| # | thumb | folder path | AI tags | event guess | dropped | right | wrong | missing |',
    '|---|---|---|---|---|---|---|---|---|', ...rows, '',
    `Skipped: ${run.skipped.map((s) => `${s.drive_id}: ${s.why}`).join('; ') || 'none'}`,
    `Cut off (answer hit the limit, ORDER #1795): ${run.cutOff.length}`].join('\n');
  fs.writeFileSync(path.join(args.out, 'grading.md'), sheet);
  log(`WROTE ${path.join(args.out, 'grading.md')} and ${thumbs.size} thumbnails. No database was opened.`);
  return run;
}

// ------------------------------------------------------------- --apply

// ORDER #1796 (plan C): ONLY picked photos (lib/photo-picks.js) not yet tagged
// since their pick. A photo nobody picked is never sent; no mass backfill.
const TODO_SQL = `SELECT p.drive_id FROM photos p JOIN photo_picks k ON k.drive_id = p.drive_id
  WHERE p.removed_at IS NULL AND p.thumb IS NOT NULL AND p.kind = 'image' AND k.tagged_at IS NULL
  AND p.folder_path NOT ILIKE 'staff photos%'
  ORDER BY k.picked_at, p.drive_id`;
// The apply paste's read-only "how many are waiting" count: the same WHERE.
const COUNT_SQL = TODO_SQL.replace('SELECT p.drive_id', 'SELECT count(*)::int AS n').replace(/\s*ORDER BY[\s\S]*$/, '');

async function apply({ args, pool, model, log, gate }) {
  await ensurePhotoTables(pool);
  const vocabSrc = await loadVocab(pool);
  const vocab = A.buildVocabulary(vocabSrc);
  const prompt = T.buildPrompt(vocabSrc);
  await sweepCardPicks(pool, { log });
  const todo = (await pool.query(TODO_SQL)).rows;
  const human = new Map();
  for (const r of (await pool.query(`SELECT drive_id, tag, source FROM photo_tags
    WHERE source IN ('human_add', 'human_remove')`)).rows) {
    const h = human.get(r.drive_id) || { added: [], removed: [] };
    (r.source === 'human_add' ? h.added : h.removed).push(r.tag);
    human.set(r.drive_id, h);
  }
  log(`TAGGING up to ${args.cap} of ${todo.length} untagged photos, ${args.batch} at a time, model ${model.model || T.MODEL}`);
  const run = await T.tagBatch({
    photos: todo, model, vocab, prompt, cap: args.cap, batchSize: args.batch, log, gate,
    removedFor: (p) => (human.get(p.drive_id) || {}).removed || [],
    addedFor: (p) => (human.get(p.drive_id) || {}).added || [],
    getThumb: async (p) => (await pool.query('SELECT thumb FROM photos WHERE drive_id = $1', [p.drive_id])).rows[0].thumb,
    onTagged: (p, r) => writePickTags(pool, p.drive_id, r.ai, r.model_id || model.model || T.MODEL),
  });
  const ids = [...new Set(run.results.map((r) => r.model_id).filter(Boolean))];
  log(`DONE: ${run.results.length} of ${todo.length} tagged, ${run.skipped.length} skipped, ${run.cutOff.length} cut off${run.capped ? `, cap ${args.cap} reached` : ''}${ids.length ? `; answered by ${ids.join(', ')}` : ''}`);
  return run;
}

// ------------------------------------------------------------- --clusters

// ORDER #3085 step 5: one pick-model call per group of near-identical shots.
// Every photo with a thumbnail and a vector, grouped within its own folder
// (lib/photo-clusters.js); the biggest groups are tagged first, so the cap buys
// the most photos. A seed that already carries its own model answer (a hand
// pick tagged earlier) is shared for free, with no call.
const CLUSTER_PHOTOS_SQL = `SELECT p.drive_id, p.folder_path, e.vec FROM photos p
  JOIN photo_embeddings e ON e.drive_id = p.drive_id AND e.model = $1
  WHERE p.removed_at IS NULL AND p.thumb IS NOT NULL AND p.kind = 'image'
  AND p.folder_path NOT ILIKE 'staff photos%'
  ORDER BY p.folder_path, p.taken_date DESC NULLS LAST, p.taken_time DESC NULLS LAST, p.drive_id`;
const AI_ROWS_SQL = "SELECT drive_id, tag, confidence, who FROM photo_tags WHERE source = 'ai'";
const HUMAN_SQL = "SELECT drive_id, tag, source FROM photo_tags WHERE source IN ('human_add', 'human_remove')";
const PICKED_SQL = 'SELECT drive_id FROM photo_picks';
const DRY_BANDS = [0.88, 0.90, 0.92, 0.94, 0.96];

// A seed's own (not shared) model answer replaces any rows it had.
async function writeSeedTags(pool, id, ai, modelId, picked) {
  if (picked) return writePickTags(pool, id, ai, modelId);
  await pool.query("DELETE FROM photo_tags WHERE drive_id = $1 AND source = 'ai'", [id]);
  for (const t of ai) {
    await pool.query(`INSERT INTO photo_tags (drive_id, tag, source, confidence, who) VALUES ($1, $2, 'ai', $3, $4)
      ON CONFLICT (drive_id, tag, source) DO UPDATE SET confidence = EXCLUDED.confidence, who = EXCLUDED.who, at = now()`,
    [id, t.tag, t.confidence, modelId]);
  }
}

async function clusters({ args, pool, model, log, gate }) {
  await ensurePhotoTables(pool);
  const rows = (await pool.query(CLUSTER_PHOTOS_SQL, [VECTOR_MODEL])).rows;
  const vectors = new Map(rows.map((r) => [r.drive_id, C.decodeVector(r.vec)]));
  const photos = rows.map((r) => ({ drive_id: r.drive_id, folder_path: r.folder_path }));
  log(`CLUSTERS: ${photos.length} photos with a thumbnail and a ${VECTOR_MODEL} vector`);

  if (args.dryRun) {
    // No model, no key, no writes: the distribution the threshold is chosen from.
    const d = C.nearestDistribution(photos, vectors);
    log(`NEAREST TWIN in the same folder: ${d.photos} photos, ${d.alone} alone in their folder, `
      + `${d.skippedFolders} folder(s) over 2000 photos not measured`);
    for (const [b, n] of Object.entries(d.atLeast)) log(`  cosine >= ${b}: ${n} photos (${d.photos ? Math.round((n / d.photos) * 1000) / 10 : 0}%)`);
    const bands = {};
    for (const t of DRY_BANDS) {
      const cov = C.coverage(C.clusterPhotos(photos, vectors, { threshold: t }));
      bands[t.toFixed(2)] = cov;
      log(`  threshold ${t.toFixed(2)}: ${cov.seeds} seeds (model calls) for ${cov.photos} photos, ${cov.perSeed} photos per seed`);
    }
    return { dryRun: true, distribution: d, bands };
  }

  const vocabSrc = await loadVocab(pool);
  const vocab = A.buildVocabulary(vocabSrc);
  const prompt = T.buildPrompt(vocabSrc);
  const ai = new Map();
  for (const r of (await pool.query(AI_ROWS_SQL)).rows) {
    if (!ai.has(r.drive_id)) ai.set(r.drive_id, []);
    ai.get(r.drive_id).push(r);
  }
  const human = new Map();
  for (const r of (await pool.query(HUMAN_SQL)).rows) {
    const h = human.get(r.drive_id) || { added: [], removed: [] };
    (r.source === 'human_add' ? h.added : h.removed).push(r.tag);
    human.set(r.drive_id, h);
  }
  const picked = new Set((await pool.query(PICKED_SQL)).rows.map((r) => r.drive_id));
  const removedOf = (id) => (human.get(id) || {}).removed || [];
  const ownOf = (id) => (ai.get(id) || []).filter((r) => !C.isPropagated(r.who));

  const groups = C.clusterPhotos(photos, vectors, { threshold: args.threshold })
    .sort((a, b) => b.members.length - a.members.length);
  const c = { free: 0, members: 0, membersKept: 0 };
  const share = async (g, seedAi) => {
    for (const m of g.members) {
      if (!C.mayPropagate({ picked: picked.has(m.drive_id), own: ai.get(m.drive_id) || [] })) { c.membersKept += 1; continue; }
      await C.writePropagated(pool, m.drive_id,
        C.propagationRows({ seed: g.seed, seedAi, cosine: m.cosine, removed: removedOf(m.drive_id) }));
      c.members += 1;
    }
  };
  const needCall = [];
  for (const g of groups) {
    const own = ownOf(g.seed);
    if (own.length) {
      if (g.members.length) { await share(g, own.map((r) => ({ tag: r.tag, confidence: Number(r.confidence) || 0 }))); c.free += 1; }
    } else needCall.push({ drive_id: g.seed, group: g });
  }
  log(`CLUSTERS at ${args.threshold}: ${groups.length} groups; ${c.free} seeds shared from an answer already held; `
    + `${needCall.length} seeds need a call; tagging up to ${args.cap}, model ${model.model || T.PICK_MODEL}`);
  const run = await T.tagBatch({
    photos: needCall, model, vocab, prompt, cap: args.cap, batchSize: args.batch, log, gate,
    removedFor: (p) => removedOf(p.drive_id),
    addedFor: (p) => (human.get(p.drive_id) || {}).added || [],
    getThumb: async (p) => (await pool.query('SELECT thumb FROM photos WHERE drive_id = $1', [p.drive_id])).rows[0].thumb,
    onTagged: async (p, r) => {
      await writeSeedTags(pool, p.drive_id, r.ai, r.model_id || model.model || T.PICK_MODEL, picked.has(p.drive_id));
      await share(p.group, r.ai);
    },
  });
  const seeds = run.results.length;
  const covered = seeds + run.results.reduce((n, r) => n + r.photo.group.members.length, 0);
  const ids = [...new Set(run.results.map((r) => r.model_id).filter(Boolean))];
  log(`CLUSTERS DONE: ${seeds} seeds tagged, ${covered} photos covered (${seeds ? Math.round((covered / seeds) * 100) / 100 : 0} per seed), `
    + `${c.members} members given shared tags, ${c.membersKept} members kept their own, `
    + `${run.skipped.length} skipped, ${run.cutOff.length} cut off${run.capped ? `, cap ${args.cap} reached` : ''}`
    + `${ids.length ? `; answered by ${ids.join(', ')}` : ''}`);
  return { ...run, seeds, covered, free: c.free, members: c.members, membersKept: c.membersKept, groups: groups.length };
}

// `drive`, `pool` and `model` are handed in so a test can run both modes with mocks.
async function main({ argv = process.argv.slice(2), drive, pool, makePool, model, makeModel, log = console.log,
  vocabSrc, gate } = {}) {
  const args = parseArgs(argv);
  // ORDER #3085: the cluster dry run measures; it sends nothing and needs no key.
  if (args.mode === 'clusters' && args.dryRun) {
    const db = pool || (makePool && makePool());
    if (!db) throw new Error('--clusters needs MARKETING_DATABASE_URL');
    return clusters({ args, pool: db, model: null, log, gate });
  }
  const m = model || (makeModel && makeModel());
  if (!m) { const e = new Error('KEY MISSING: no Anthropic API key by name (env, Keychain, brain config). Nothing sent.'); e.exitCode = 4; throw e; }
  if (args.mode === 'sample') {
    const { GROUPS, SYNONYMS } = require('../lib/photo-vocabulary');
    return sample({ args, drive, model: m, log, vocabSrc: vocabSrc || { groups: GROUPS, synonyms: SYNONYMS } });
  }
  const db = pool || (makePool && makePool());
  if (!db) throw new Error(`--${args.mode} needs MARKETING_DATABASE_URL`);
  if (args.mode === 'clusters') return clusters({ args, pool: db, model: m, log, gate });
  return apply({ args, pool: db, model: m, log, gate });
}

if (require.main === module) {
  // --apply tags picks with the Opus-class model (ORDER #1796); --sample keeps
  // the model it has always graded.
  const makeModel = () => {
    const k = T.findApiKey();
    if (!k) return null;
    const model = process.argv.includes('--apply') || process.argv.includes('--clusters') ? T.PICK_MODEL : T.MODEL;
    console.log(`model ${model}; key from ${k.source}`);
    return T.createClaudeClient({ apiKey: k.key, model });
  };
  const makePool = () => {
    if (!process.env.MARKETING_DATABASE_URL) return null;
    const { Pool } = require('pg');
    return new Pool({ connectionString: process.env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  };
  let pool = null;
  const argv = process.argv.slice(2);
  const dbMode = argv.includes('--apply') || argv.includes('--clusters');
  const drive = dbMode ? null : require('../lib/drive-client').createDriveClient();
  // ORDER #1797: the nightly's --apply (and #3085's --clusters) re-ask the bonus window and usage state before each batch.
  const gate = dbMode ? require('../lib/photo-window').photoGate() : undefined;
  main({ argv, drive, makeModel, makePool: () => (pool = makePool()), gate })
    .then(() => (pool ? pool.end() : null))
    .catch((e) => { console.error(`photo_tag FAILED: ${e.message}`); process.exitCode = e.exitCode || 1; if (pool) pool.end(); });
}

module.exports = { main, parseArgs, TODO_SQL, COUNT_SQL, CLUSTER_PHOTOS_SQL, writeSeedTags };
