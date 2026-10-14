// ORDER #1796 (plan C, ruled 10.14.2026): search by meaning for every photo.
//
// The Box computes one SigLIP vector per stored thumbnail (#1790's model,
// apache-2.0, 49 ms a photo, no photo leaves the Box) and stores it beside the
// photo. A search embeds the typed words with the same model and ranks the
// photos by how close their vectors are. Every rule here is pure, so the tests
// run it with hand-made vectors and no model.
//
// 🔴 THE RULES THIS FILE CARRIES:
//   1. A vector is stored as int8 (768 bytes), scaled per photo. Cosine does not
//      care about the scale, so nothing else is stored and the server holds
//      ~106k vectors in under 100 MB.
//   2. A search still honours every filter (venue, season, folder ...) and
//      still finds every tag match; meaning only decides the ORDER, and adds the
//      closest photos that carry no matching tag.
//   3. The night step is incremental and resumable: it only embeds photos with
//      a thumbnail and no vector for this model, newest first, on a time budget.
//      Staff Photos is never read.
'use strict';

const A = require('./photo-archive');

const MODEL_ID = 'Xenova/siglip-base-patch16-224';
const DIMS = 768;
// How many photos with no matching tag a meaning search adds, closest first.
const MEANING_TOP = 300;

// ---------------------------------------------------------------- vectors

function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / s);
}

// Float vector -> int8 bytes, scaled so the largest value is 127.
function encodeVector(v) {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const k = max ? 127 / max : 0;
  return Buffer.from(Int8Array.from(v, (x) => Math.round(x * k)).buffer);
}

// Stored bytes -> { v: Int8Array, norm }. Copies, so a pg Buffer can be freed.
function decodeVector(buf) {
  const v = new Int8Array(buf.length);
  for (let i = 0; i < buf.length; i += 1) v[i] = buf[i] > 127 ? buf[i] - 256 : buf[i];
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i] * v[i];
  return { v, norm: Math.sqrt(s) || 1 };
}

// q: a normalized float query vector. Returns the cosine, -1 .. 1.
function cosine(q, entry) {
  const { v, norm } = entry;
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += q[i] * v[i];
  return s / norm;
}

// What the text side of the model is asked, the #1790 wording.
const textPrompt = (q) => `a photo of ${String(q || '').trim()}.`;

// ---------------------------------------------------------------- search

// photos: the page's index rows; vectors: Map drive_id -> decoded entry;
// qvec: the typed words' normalized vector. Same shape as photo-archive.search.
function meaningSearch(vocab, photos, { q, filters = {}, qvec, vectors, top = MEANING_TOP } = {}) {
  const scored = [];
  for (const p of photos) {
    const e = vectors.get(p.drive_id || p.id);
    const tagHit = A.matches(vocab, p, q);
    scored.push({ p, tagHit, score: e ? cosine(qvec, e) : null });
  }
  const byMeaning = scored.filter((s) => s.score !== null && !s.tagHit)
    .sort((a, b) => b.score - a.score).slice(0, Math.max(0, top));
  const pool = [...scored.filter((s) => s.tagHit), ...byMeaning];
  // Closest first; a tag match with no vector yet keeps its place after them.
  pool.sort((a, b) => (b.score === null ? -2 : b.score) - (a.score === null ? -2 : a.score));
  const hits = pool.map((s) => s.p);
  const { results, facets } = A.search(vocab, hits, { q: '', filters });
  const scoreOf = new Map(pool.map((s) => [s.p, s.score]));
  return { results, facets, scoreOf };
}

// ---------------------------------------------------------------- the night step

const STAFF = "p.folder_path NOT ILIKE 'staff photos%'";
const TODO_SQL = `SELECT p.drive_id FROM photos p
  WHERE p.removed_at IS NULL AND p.thumb IS NOT NULL AND ${STAFF}
  AND NOT EXISTS (SELECT 1 FROM photo_embeddings e WHERE e.drive_id = p.drive_id AND e.model = $1)
  ORDER BY p.taken_date DESC NULLS LAST, p.created_time DESC NULLS LAST, p.drive_id
  LIMIT $2`;
const COUNT_SQL = `SELECT
  (SELECT count(*)::int FROM photo_embeddings e JOIN photos p ON p.drive_id = e.drive_id
     WHERE e.model = $1 AND p.removed_at IS NULL AND ${STAFF}) AS searchable,
  (SELECT count(*)::int FROM photos p WHERE p.removed_at IS NULL AND p.thumb IS NOT NULL AND ${STAFF}
     AND NOT EXISTS (SELECT 1 FROM photo_embeddings e WHERE e.drive_id = p.drive_id AND e.model = $1)) AS left`;
const SAVE_SQL = `INSERT INTO photo_embeddings (drive_id, model, vec) VALUES ($1, $2, $3)
  ON CONFLICT (drive_id) DO UPDATE SET model = EXCLUDED.model, vec = EXCLUDED.vec, at = now()`;

// embedder.embedImage(bytes) -> float vector. One photo that fails is logged
// and skipped; it is tried again next night. Returns the counts it printed.
async function embedPending({ pool, embedder, model = MODEL_ID, budgetMs = 60 * 60 * 1000, batch = 100,
  now = () => Date.now(), log = console.log }) {
  const start = now();
  let embedded = 0;
  let failed = 0;
  const failedIds = new Set();
  for (;;) {
    if (now() - start >= budgetMs) break;
    const ids = (await pool.query(TODO_SQL, [model, batch + failedIds.size])).rows
      .map((r) => r.drive_id).filter((id) => !failedIds.has(id));
    if (!ids.length) break;
    for (const id of ids) {
      if (now() - start >= budgetMs) break;
      try {
        const r = (await pool.query('SELECT thumb FROM photos WHERE drive_id = $1', [id])).rows[0];
        if (!r || !r.thumb) throw new Error('no thumbnail');
        const vec = normalize(await embedder.embedImage(r.thumb));
        if (vec.length !== DIMS) throw new Error(`vector has ${vec.length} values, not ${DIMS}`);
        await pool.query(SAVE_SQL, [id, model, encodeVector(vec)]);
        embedded += 1;
      } catch (e) {
        failed += 1;
        failedIds.add(id);
        log(`EMBED SKIPPED ${id}: ${e.message || e}`);
      }
    }
  }
  const c = (await pool.query(COUNT_SQL, [model])).rows[0] || {};
  const line = `EMBED: ${embedded} embedded, ${failed} failed, ${c.searchable} searchable, ${c.left} still to do, `
    + `${Math.round((now() - start) / 1000)} s, model ${model}`;
  log(line);
  return { embedded, failed, searchable: c.searchable, left: c.left, line };
}

module.exports = {
  MODEL_ID, DIMS, MEANING_TOP, normalize, encodeVector, decodeVector, cosine, textPrompt,
  meaningSearch, embedPending, TODO_SQL, COUNT_SQL, SAVE_SQL,
};
