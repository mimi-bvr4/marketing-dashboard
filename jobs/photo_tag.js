#!/usr/bin/env node
// ORDER #1240: the photo archive's AI tagger. RUNS ON THE BOX, never on Railway.
//
//   node jobs/photo_tag.js --sample --listing <files.json> --out <dir>
//        tags a 20-photo sample IN MEMORY, writes NOTHING to any database. The
//        listing is `photo_crawl.js --dry-run --listing-out <files.json>`. Writes
//        each thumbnail and a grading sheet to <dir> for grading by eye.
//   node jobs/photo_tag.js --apply [--cap 500] [--batch 10]
//        tags up to --cap indexed photos that have a thumbnail and no AI tags
//        yet, and writes their AI rows to photo_tags. Needs MARKETING_DATABASE_URL.
//
// The key is found by name (env, Keychain, brain config) and never printed.
// Exit 4 = no key: nothing was sent.
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('../lib/photo-archive');
const T = require('../lib/photo-tagger');
const { ensurePhotoTables } = require('../lib/photo-schema');

function parseArgs(argv) {
  const modes = ['--sample', '--apply'].filter((m) => argv.includes(m));
  if (modes.length > 1) throw new Error('pick one of --sample, --apply');
  const val = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
  const cap = Number(val('--cap', 500));
  const batch = Number(val('--batch', 10));
  if (!(cap >= 0) || !(batch >= 1)) throw new Error('--cap must be 0 or more and --batch 1 or more');
  return { mode: (modes[0] || '--sample').slice(2), cap, batch, listing: val('--listing'), out: val('--out') };
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
    `Skipped: ${run.skipped.map((s) => `${s.drive_id}: ${s.why}`).join('; ') || 'none'}`].join('\n');
  fs.writeFileSync(path.join(args.out, 'grading.md'), sheet);
  log(`WROTE ${path.join(args.out, 'grading.md')} and ${thumbs.size} thumbnails. No database was opened.`);
  return run;
}

// ------------------------------------------------------------- --apply

const TODO_SQL = `SELECT p.drive_id FROM photos p
  WHERE p.removed_at IS NULL AND p.thumb IS NOT NULL AND p.kind = 'image'
  AND NOT EXISTS (SELECT 1 FROM photo_tags t WHERE t.drive_id = p.drive_id AND t.source = 'ai')
  ORDER BY p.indexed_at, p.drive_id`;

async function apply({ args, pool, model, log }) {
  await ensurePhotoTables(pool);
  const vocabSrc = await loadVocab(pool);
  const vocab = A.buildVocabulary(vocabSrc);
  const prompt = T.buildPrompt(vocabSrc);
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
    photos: todo, model, vocab, prompt, cap: args.cap, batchSize: args.batch, log,
    removedFor: (p) => (human.get(p.drive_id) || {}).removed || [],
    addedFor: (p) => (human.get(p.drive_id) || {}).added || [],
    getThumb: async (p) => (await pool.query('SELECT thumb FROM photos WHERE drive_id = $1', [p.drive_id])).rows[0].thumb,
    onTagged: async (p, r) => {
      await pool.query("DELETE FROM photo_tags WHERE drive_id = $1 AND source = 'ai'", [p.drive_id]);
      for (const t of r.ai) {
        await pool.query(`INSERT INTO photo_tags (drive_id, tag, source, confidence, who) VALUES ($1, $2, 'ai', $3, $4)
          ON CONFLICT (drive_id, tag, source) DO UPDATE SET confidence = EXCLUDED.confidence, at = now()`,
        [p.drive_id, t.tag, t.confidence, model.model || T.MODEL]);
      }
    },
  });
  log(`DONE: ${run.results.length} of ${todo.length} tagged, ${run.skipped.length} skipped${run.capped ? `, cap ${args.cap} reached` : ''}`);
  return run;
}

// `drive`, `pool` and `model` are handed in so a test can run both modes with mocks.
async function main({ argv = process.argv.slice(2), drive, pool, makePool, model, makeModel, log = console.log,
  vocabSrc } = {}) {
  const args = parseArgs(argv);
  const m = model || (makeModel && makeModel());
  if (!m) { const e = new Error('KEY MISSING: no Anthropic API key by name (env, Keychain, brain config). Nothing sent.'); e.exitCode = 4; throw e; }
  if (args.mode === 'sample') {
    const { GROUPS, SYNONYMS } = require('../lib/photo-vocabulary');
    return sample({ args, drive, model: m, log, vocabSrc: vocabSrc || { groups: GROUPS, synonyms: SYNONYMS } });
  }
  const db = pool || (makePool && makePool());
  if (!db) throw new Error('--apply needs MARKETING_DATABASE_URL');
  return apply({ args, pool: db, model: m, log });
}

if (require.main === module) {
  const makeModel = () => {
    const k = T.findApiKey();
    if (!k) return null;
    console.log(`model ${T.MODEL}; key from ${k.source}`);
    return T.createClaudeClient({ apiKey: k.key });
  };
  const makePool = () => {
    if (!process.env.MARKETING_DATABASE_URL) return null;
    const { Pool } = require('pg');
    return new Pool({ connectionString: process.env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  };
  let pool = null;
  const argv = process.argv.slice(2);
  const drive = argv.includes('--apply') ? null : require('../lib/drive-client').createDriveClient();
  main({ argv, drive, makeModel, makePool: () => (pool = makePool()) })
    .then(() => (pool ? pool.end() : null))
    .catch((e) => { console.error(`photo_tag FAILED: ${e.message}`); process.exitCode = e.exitCode || 1; if (pool) pool.end(); });
}

module.exports = { main, parseArgs, TODO_SQL };
