// ORDER #3085 step 4: near-identical shots share one answer.
//
// A photographer shoots the same table twelve times. Opus is right on almost
// every photo (#1789: 99%), and its cost is the only reason it is not on every
// photo. So: group the shots of one event whose SigLIP vectors (#1796, already
// stored for every thumbnail) are nearly the same, tag ONE seed per group with
// the pick model, and write the seed's tags to every member, marked as shared.
//
// 🔴 THE RULES THIS FILE CARRIES:
//   1. A group never crosses a folder. Two events in one room look alike and are
//      not the same set; the folder is the event.
//   2. A member joins a seed only at cosine >= threshold to THAT seed (no chains:
//      A~B and B~C never puts A with C through B).
//   3. Shared rows are source 'ai', who 'propagated:<seed drive_id>', confidence
//      = the seed's confidence capped by the cosine. A tag a human removed on the
//      member is never written (and finalTags hides it anyway).
//   4. A member someone picked by hand ("Tag this photo", an agent card) is never
//      overwritten here: it gets its own pick-model answer, and writePickTags
//      deletes every AI row first, so its shared rows go.
//   5. A member that already carries its own model answer keeps it.
//   6. Pure, except writePropagated, which is handed a pool or client.
'use strict';

const A = require('./photo-archive');
const M = require('./photo-meaning');

const THRESHOLD = 0.92;
const PROPAGATED = 'propagated:';
const BANDS = [0.80, 0.85, 0.88, 0.90, 0.92, 0.94, 0.96, 0.98];

// Two decoded int8 vectors ({ v, norm }, photo-meaning.decodeVector) -> cosine.
function cos(a, b) {
  let s = 0;
  for (let i = 0; i < a.v.length; i += 1) s += a.v[i] * b.v[i];
  return s / (a.norm * b.norm);
}

const isPropagated = (who) => String(who || '').startsWith(PROPAGATED);
const seedOf = (who) => (isPropagated(who) ? String(who).slice(PROPAGATED.length) : null);

// photos: [{ drive_id, folder_path }], in the order seeds should be chosen
// (newest first is the caller's choice). vectors: Map drive_id -> decoded.
// -> [{ seed, folder, members: [{ drive_id, cosine }] }] in seed order. A photo
// with no vector is left out (it has nothing to compare).
function clusterPhotos(photos, vectors, { threshold = THRESHOLD } = {}) {
  const byFolder = new Map();
  for (const p of photos) {
    if (!vectors.has(p.drive_id)) continue;
    const f = String(p.folder_path || '');
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f).push(p.drive_id);
  }
  const out = [];
  for (const [folder, ids] of byFolder) {
    const taken = new Set();
    for (const seed of ids) {
      if (taken.has(seed)) continue;
      taken.add(seed);
      const sv = vectors.get(seed);
      const members = [];
      for (const id of ids) {
        if (taken.has(id)) continue;
        const c = cos(sv, vectors.get(id));
        if (c >= threshold) { members.push({ drive_id: id, cosine: Math.round(c * 1000) / 1000 }); taken.add(id); }
      }
      out.push({ seed, folder, members });
    }
  }
  return out;
}

// Each photo's closest neighbour in its own folder, binned. The distribution
// the threshold is chosen from: how many photos have a near-twin at each band.
function nearestDistribution(photos, vectors, { bands = BANDS, maxPerFolder = 2000 } = {}) {
  const byFolder = new Map();
  for (const p of photos) {
    if (!vectors.has(p.drive_id)) continue;
    const f = String(p.folder_path || '');
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f).push(p.drive_id);
  }
  const atLeast = Object.fromEntries(bands.map((b) => [b.toFixed(2), 0]));
  let photosSeen = 0;
  let alone = 0;
  let skippedFolders = 0;
  for (const ids of byFolder.values()) {
    if (ids.length > maxPerFolder) { skippedFolders += 1; continue; }
    for (const id of ids) {
      photosSeen += 1;
      let best = -1;
      for (const other of ids) if (other !== id) best = Math.max(best, cos(vectors.get(id), vectors.get(other)));
      if (best < 0) { alone += 1; continue; }
      for (const b of bands) if (best >= b) atLeast[b.toFixed(2)] += 1;
    }
  }
  return { photos: photosSeen, alone, skippedFolders, atLeast };
}

// What a set of clusters would cost and cover: seeds = model calls.
function coverage(clusters) {
  const seeds = clusters.length;
  const photos = clusters.reduce((n, c) => n + 1 + c.members.length, 0);
  const shared = clusters.filter((c) => c.members.length).length;
  return { seeds, photos, perSeed: seeds ? Math.round((photos / seeds) * 100) / 100 : 0, groupsWithMembers: shared };
}

// The rows one member gets from its seed's AI tags.
// seedAi [{ tag, confidence }]; removed: the member's human-removed tags.
function propagationRows({ seed, seedAi, cosine, removed = [] }) {
  const gone = new Set(removed.map(A.norm));
  return seedAi.filter((t) => !gone.has(A.norm(t.tag))).map((t) => ({
    tag: t.tag,
    confidence: Math.round(Math.min(Number(t.confidence) || 0, cosine) * 1000) / 1000,
    who: `${PROPAGATED}${seed}`,
  }));
}

// May this member take shared rows? Not if it was picked by hand, not if it has
// its own model answer. `own` = its AI rows [{ who }].
function mayPropagate({ picked = false, own = [] }) {
  if (picked) return false;
  return own.every((r) => isPropagated(r.who));
}

// Replace one member's shared rows in one go. Rows from its own model answer
// are never deleted here (mayPropagate keeps such a member out in the first place).
async function writePropagated(q, memberId, rows) {
  await q.query(`DELETE FROM photo_tags WHERE drive_id = $1 AND source = 'ai' AND who LIKE '${PROPAGATED}%'`, [memberId]);
  for (const r of rows) {
    await q.query(`INSERT INTO photo_tags (drive_id, tag, source, confidence, who) VALUES ($1, $2, 'ai', $3, $4)
      ON CONFLICT (drive_id, tag, source) DO NOTHING`, [memberId, r.tag, r.confidence, r.who]);
  }
}

module.exports = {
  THRESHOLD, PROPAGATED, BANDS, cos, isPropagated, seedOf, clusterPhotos, nearestDistribution, coverage,
  propagationRows, mayPropagate, writePropagated, decodeVector: M.decodeVector,
};
