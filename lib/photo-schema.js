// ORDER #1239: the photo archive's tables. Idempotent, db.js style: every
// statement is IF NOT EXISTS / ON CONFLICT DO NOTHING, because this Postgres is
// in the Brain Box nightly backup set and the schema runs on every boot/crawl.
//
// Metadata and a ~400px thumbnail only. Originals stay in Drive (#1008 LAW).
'use strict';

const { GROUPS, SYNONYMS } = require('./photo-vocabulary');

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS photos (
    drive_id TEXT PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT NOT NULL, kind TEXT NOT NULL,
    size BIGINT, width INTEGER, height INTEGER, orientation TEXT, md5 TEXT,
    created_time TIMESTAMPTZ, taken_date DATE, taken_source TEXT, month TEXT, season TEXT, year INTEGER,
    folder_path TEXT NOT NULL, brand TEXT, venue TEXT, space TEXT, event_type TEXT, event_class TEXT,
    setup TEXT, guest_band TEXT, deal_id TEXT,
    rights_state TEXT NOT NULL DEFAULT 'unknown', rights_reason TEXT, manual_internal BOOLEAN NOT NULL DEFAULT false,
    thumb BYTEA, thumb_w INTEGER, thumb_h INTEGER,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(), removed_at TIMESTAMPTZ)`,
  'CREATE INDEX IF NOT EXISTS idx_photos_md5 ON photos(md5)',
  'CREATE INDEX IF NOT EXISTS idx_photos_venue ON photos(venue) WHERE removed_at IS NULL',
  `CREATE TABLE IF NOT EXISTS photo_paths (
    id SERIAL PRIMARY KEY, drive_id TEXT NOT NULL, md5 TEXT, path TEXT NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (drive_id, path))`,
  'CREATE INDEX IF NOT EXISTS idx_photo_paths_md5 ON photo_paths(md5)',
  `CREATE TABLE IF NOT EXISTS photo_folders (
    drive_id TEXT PRIMARY KEY, path TEXT NOT NULL, seen_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS photo_tags (
    id SERIAL PRIMARY KEY, drive_id TEXT NOT NULL, tag TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('ai', 'human_add', 'human_remove')),
    confidence REAL, who TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (drive_id, tag, source))`,
  'CREATE INDEX IF NOT EXISTS idx_photo_tags_tag ON photo_tags(tag)',
  `CREATE TABLE IF NOT EXISTS photo_vocab (
    tag TEXT PRIMARY KEY, grp TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), edited_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS photo_synonyms (
    word TEXT PRIMARY KEY, tag TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), edited_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS photo_crawl_runs (
    id SERIAL PRIMARY KEY, mode TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
    seen INTEGER, new INTEGER, moved INTEGER, removed INTEGER, failed INTEGER, images INTEGER, videos INTEGER,
    start_page_token TEXT, detail JSONB)`,
];

// The seed rows for Katherine's table. ON CONFLICT DO NOTHING: once she has
// edited a row, a re-seed never puts the old one back.
function vocabSeed(groups = GROUPS, synonyms = SYNONYMS) {
  const tags = [];
  const syns = [];
  for (const [grp, terms] of Object.entries(groups)) {
    for (const term of terms) {
      const [tag, ...alts] = term.split(' / ').map((s) => s.trim()).filter(Boolean);
      tags.push([tag, grp]);
      alts.forEach((w) => syns.push([w, tag]));
    }
  }
  for (const [w, tag] of Object.entries(synonyms)) syns.push([w, tag]);
  return { tags, syns };
}

async function ensurePhotoTables(pool) {
  if (!pool) return;
  for (const sql of SCHEMA_SQL) await pool.query(sql);
  const { tags, syns } = vocabSeed();
  for (const [tag, grp] of tags) {
    await pool.query('INSERT INTO photo_vocab (tag, grp) VALUES ($1, $2) ON CONFLICT (tag) DO NOTHING', [tag, grp]);
  }
  for (const [word, tag] of syns) {
    await pool.query('INSERT INTO photo_synonyms (word, tag) VALUES ($1, $2) ON CONFLICT (word) DO NOTHING', [word, tag]);
  }
}

module.exports = { SCHEMA_SQL, vocabSeed, ensurePhotoTables };
