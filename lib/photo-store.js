// ORDER #1241: the /photos page's reads and its two writes, against the #1239
// tables. Thin on purpose: every decision (search, facets, rights, who may
// edit) is made in routes/photos.js through the #1008 core, so the tests can
// hand the router an in-memory store and exercise the real rules.
//
// The two writes are the only ones the page makes:
//   * a human tag edit -> photo_tags rows with source human_add / human_remove
//   * an editor's "internal only" -> photos.manual_internal
// Neither ever touches an AI row. ORDER #1796 adds the third and fourth:
//   * "Tag this photo" -> a photo_picks row (tag_this), then
//   * that pick's AI rows, replaced, with the model id the API reported
// Staff Photos is never returned, even if a row
// for it somehow exists (the crawl never walks it).
'use strict';

const { pickSql, writePickTags } = require('./photo-picks');

const STAFF = "folder_path NOT ILIKE 'staff photos%'";

const INDEX_SQL = `SELECT drive_id, name, kind, folder_path, brand, venue, space, event_type, event_class,
  setup, guest_band, deal_id, manual_internal, rights_reason, to_char(taken_date, 'YYYY-MM-DD') AS taken_date,
  month, season, year, orientation, width, height, (thumb IS NOT NULL) AS has_thumb
  FROM photos WHERE removed_at IS NULL AND ${STAFF}`;
const TAGS_SQL = 'SELECT drive_id, tag, source, confidence FROM photo_tags';
const THUMB_SQL = `SELECT thumb FROM photos WHERE drive_id = $1 AND removed_at IS NULL AND ${STAFF}`;

// Adding un-removes; removing un-adds (photo-archive.applyTagEdit, as rows).
const EDIT_SQL = {
  add: ['DELETE FROM photo_tags WHERE drive_id = $1 AND lower(tag) = lower($2) AND source = \'human_remove\'',
    `INSERT INTO photo_tags (drive_id, tag, source, who) VALUES ($1, $2, 'human_add', $3)
     ON CONFLICT (drive_id, tag, source) DO UPDATE SET who = EXCLUDED.who, at = now()`],
  remove: ['DELETE FROM photo_tags WHERE drive_id = $1 AND lower(tag) = lower($2) AND source = \'human_add\'',
    `INSERT INTO photo_tags (drive_id, tag, source, who) VALUES ($1, $2, 'human_remove', $3)
     ON CONFLICT (drive_id, tag, source) DO UPDATE SET who = EXCLUDED.who, at = now()`],
};
const RIGHTS_SQL = `UPDATE photos SET manual_internal = $2,
  rights_reason = CASE WHEN $2 THEN 'set to internal only by ' || $3 ELSE NULL END
  WHERE drive_id = $1 AND removed_at IS NULL AND ${STAFF}`;

// ORDER #1796: the search-by-meaning vectors, read in slices newer than the
// last one the page holds, and the picks for big-model tags.
// The cursor is (at as text, drive_id), exact to the microsecond, so a slice
// boundary never drops or repeats a row.
const VECTORS_SQL = `SELECT drive_id, vec, at::text AS at FROM photo_embeddings
  WHERE model = $1 AND (at, drive_id) > ($2::timestamptz, $3)
  ORDER BY at, drive_id LIMIT $4`;
const PICKS_SQL = 'SELECT drive_id, why, tagged_at, tagged_model FROM photo_picks';

function createPgStore(pool) {
  return {
    async loadIndex() {
      const [photos, tags, vocab, syns, picks] = await Promise.all([
        pool.query(INDEX_SQL), pool.query(TAGS_SQL),
        pool.query('SELECT tag, grp FROM photo_vocab'), pool.query('SELECT word, tag FROM photo_synonyms'),
        pool.query(PICKS_SQL).catch(() => ({ rows: [] })),
      ]);
      return { photos: photos.rows, tags: tags.rows, vocabRows: vocab.rows, synonymRows: syns.rows, picks: picks.rows };
    },
    // cursor: { at, drive_id } of the last row already held, or null for all.
    async loadVectors(model, cursor, limit = 20000) {
      const c = cursor || { at: '1970-01-01T00:00:00Z', drive_id: '' };
      return (await pool.query(VECTORS_SQL, [model, c.at, c.drive_id, limit])).rows;
    },
    async pick(id, why, who) {
      await pool.query(pickSql(why), [id, why, who]);
    },
    async savePickTags(id, ai, modelId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await writePickTags(client, id, ai, modelId);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async getThumb(id) {
      const r = await pool.query(THUMB_SQL, [id]);
      return r.rows[0] ? r.rows[0].thumb : null;
    },
    async editTag(id, action, tag, who) {
      const [del, ins] = EDIT_SQL[action];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(del, [id, tag]);
        await client.query(ins, [id, tag, who]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async setInternal(id, internal, who) {
      const r = await pool.query(RIGHTS_SQL, [id, !!internal, who]);
      return r.rowCount > 0;
    },
  };
}

module.exports = { createPgStore, INDEX_SQL, TAGS_SQL, THUMB_SQL, EDIT_SQL, RIGHTS_SQL, VECTORS_SQL, PICKS_SQL };
