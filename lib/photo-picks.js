// ORDER #1796 (plan C): big-model tags ONLY on photos someone picked.
//
// A pick is a row in photo_picks. Three ways in:
//   tag_this    an editor pressed "Tag this photo" on the photo view
//   agent_card  a marketing agent card names an archive photo
//   pin_card    a pin (or Canva) card names an archive photo
// The tagger (jobs/photo_tag.js --apply, and the page's "Tag this photo") reads
// photo_picks and nothing else, so a photo nobody picked is never sent to a
// model. There is no mass backfill (ruled out by C).
'use strict';

const WHY = ['tag_this', 'agent_card', 'pin_card', 'canva'];

// The ways a card can name an archive photo: our own thumbnail or photo API
// path, or the Drive file link the photo view hands out.
const REF_PATTERNS = [
  /\/photos\/thumb\/([A-Za-z0-9_-]{10,})/g,
  /\/api\/photos\/([A-Za-z0-9_-]{10,})/g,
  /drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/g,
  /drive\.google\.com\/(?:uc|open)\?[^\s"']*?\bid=([A-Za-z0-9_-]{10,})/g,
];

function photoRefs(text) {
  const out = new Set();
  const s = String(text || '');
  for (const re of REF_PATTERNS) for (const m of s.matchAll(re)) out.add(m[1]);
  return [...out];
}

// A card's kind of pick: a card carrying a pin is a pin card.
function cardWhy(card) {
  const payload = typeof card.payload === 'string' ? card.payload : JSON.stringify(card.payload || {});
  if (/"canva/i.test(payload)) return 'canva';
  return /"pin"\s*:/.test(payload) ? 'pin_card' : 'agent_card';
}

// An explicit "Tag this photo" re-tags a photo already tagged; an automatic
// pick never resets one.
const PICK_SQL = {
  tag_this: `INSERT INTO photo_picks (drive_id, why, who) VALUES ($1, $2, $3)
    ON CONFLICT (drive_id) DO UPDATE SET why = EXCLUDED.why, who = EXCLUDED.who, picked_at = now(), tagged_at = NULL`,
  auto: `INSERT INTO photo_picks (drive_id, why, who) VALUES ($1, $2, $3) ON CONFLICT (drive_id) DO NOTHING`,
};
const pickSql = (why) => (why === 'tag_this' ? PICK_SQL.tag_this : PICK_SQL.auto);

const CARDS_SQL = 'SELECT id, agent, body, payload::text AS payload FROM agent_cards';
const KNOWN_SQL = `SELECT drive_id FROM photos WHERE drive_id = ANY($1) AND removed_at IS NULL
  AND folder_path NOT ILIKE 'staff photos%'`;

// Every archive photo an agent card names becomes a pick. Returns the count.
async function sweepCardPicks(pool, { log = console.log } = {}) {
  let cards;
  try { cards = (await pool.query(CARDS_SQL)).rows; } catch (e) {
    log(`PICKS: agent cards not read (${e.message})`);
    return 0;
  }
  const wanted = new Map();
  for (const c of cards) {
    for (const id of photoRefs(`${c.body || ''}\n${c.payload || ''}`)) {
      if (!wanted.has(id)) wanted.set(id, { why: cardWhy(c), who: `agent:${c.agent} card ${c.id}` });
    }
  }
  if (!wanted.size) return 0;
  const known = (await pool.query(KNOWN_SQL, [[...wanted.keys()]])).rows.map((r) => r.drive_id);
  let n = 0;
  for (const id of known) {
    const w = wanted.get(id);
    const r = await pool.query(pickSql(w.why), [id, w.why, w.who]);
    n += r && r.rowCount ? r.rowCount : 0;
  }
  log(`PICKS: ${n} new from agent cards (${known.length} archive photos named on cards)`);
  return n;
}

// The AI rows for one picked photo, replaced in one go, and the pick marked
// done with the model id the API reported. `q` is a pool or a client.
async function writePickTags(q, id, ai, modelId) {
  await q.query("DELETE FROM photo_tags WHERE drive_id = $1 AND source = 'ai'", [id]);
  for (const t of ai) {
    await q.query(`INSERT INTO photo_tags (drive_id, tag, source, confidence, who) VALUES ($1, $2, 'ai', $3, $4)
      ON CONFLICT (drive_id, tag, source) DO UPDATE SET confidence = EXCLUDED.confidence, who = EXCLUDED.who, at = now()`,
    [id, t.tag, t.confidence, modelId]);
  }
  await q.query('UPDATE photo_picks SET tagged_at = now(), tagged_model = $2 WHERE drive_id = $1', [id, modelId]);
}

module.exports = { WHY, photoRefs, cardWhy, PICK_SQL, pickSql, CARDS_SQL, KNOWN_SQL, sweepCardPicks, writePickTags };
