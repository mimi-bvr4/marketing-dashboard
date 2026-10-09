// ORDER #1240: the photo archive's AI vision tagger.
//
// One photo in: its ~400px thumbnail (never the original) and the controlled
// vocabulary from photo_vocab / photo_synonyms. One answer out: the tags the
// #1008 core lets it keep. The model client is handed in, so every rule here is
// tested with a mock and no key is read by a test.
//
// 🔴 THE RULES THIS FILE CARRIES:
//   1. Only the thumbnail is sent. Bytes over MAX_THUMB_BYTES are refused, so an
//      original that slipped through cannot be uploaded by accident.
//   2. Every model tag goes through photo-archive.screenAiTags: synonyms land on
//      their head tag, person-identifying words and consumables are dropped.
//   3. A tag a human removed never comes back (photo-archive.finalTags), and the
//      AI rows written for a photo leave out every human-removed tag.
//   4. Malformed model JSON skips that photo and is logged. It never ends a batch.
//   5. The API key is read by NAME inside this process and never printed.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./photo-archive');
const { EVENT_CLASSES } = require('./photo-vocabulary');

// Cost-sensible, vision-capable, and already the model this repo calls (server.js).
const MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_THUMB_BYTES = 400 * 1024;
const KEY_ENV = 'ANTHROPIC_API_KEY';
const KEYCHAIN_SERVICE = 'anthropic-api-key';
const CONFIG_FILE = path.join(os.homedir(), '.config', 'brain', 'anthropic_api_key');

// ---------------------------------------------------------------- the key

// Where a key is, by name, in the order #1240 step 1 names: env, Keychain, brain
// config. Returns { source, key } or null. Callers print `source` only.
function findApiKey({ env = process.env, keychain = readKeychain, configFile = CONFIG_FILE } = {}) {
  if (env[KEY_ENV]) return { source: `env ${KEY_ENV}`, key: env[KEY_ENV] };
  const k = keychain(KEYCHAIN_SERVICE);
  if (k) return { source: `Keychain item ${KEYCHAIN_SERVICE}`, key: k };
  try {
    const v = fs.readFileSync(configFile, 'utf8').trim();
    if (v) return { source: `brain config ${path.basename(configFile)}`, key: v };
  } catch (_) { /* absent */ }
  return null;
}

function readKeychain(service) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim() || null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- vocabulary

// photo_vocab rows [{tag, grp}] and photo_synonyms rows [{word, tag}] -> the
// shape photo-archive.buildVocabulary takes. The table wins over the seed file.
function vocabFromRows(vocabRows, synonymRows) {
  const groups = {};
  for (const r of vocabRows) (groups[r.grp] = groups[r.grp] || []).push(r.tag);
  const synonyms = {};
  for (const r of synonymRows) synonyms[r.word] = r.tag;
  return { groups, synonyms };
}

function buildPrompt({ groups, synonyms }) {
  const lines = [];
  for (const [grp, tags] of Object.entries(groups)) lines.push(`${grp}: ${tags.join('; ')}`);
  const syn = Object.entries(synonyms).map(([w, t]) => `${w} -> ${t}`);
  return [
    'You tag event photos for an events company\'s internal photo search.',
    'Use ONLY these tags where they fit (group: tags):',
    ...lines,
    syn.length ? `These words mean the tag after the arrow: ${syn.join('; ')}` : '',
    // ORDER #1611: the four miss classes #1278's graded sample found (71% right).
    'Tag only what is plainly visible. Fewer right tags beat many guesses: leave a tag out when unsure.',
    'day or night: ONLY when sky, sunlight or windows show it. A dark room, stage lighting or a studio backdrop is neither.',
    'exterior: ONLY when the photo is taken outdoors.',
    'rounds / banquet rounds: ONLY round guest tables. A sweetheart table (two seats for the couple) or a head table '
      + '(one long table facing the room) is not rounds: write "sweetheart table" or "head table" in free.',
    'lounge furniture / soft seating: ONLY sofas, armchairs or ottomans. Dining or ceremony chairs are not lounge furniture.',
    'classroom, theater, boardroom, breakout room: ONLY a meeting set. Chairs in rows facing an aisle or altar are a ceremony.',
    'Never tag who a person is: no names, faces, ages, ethnicity, religion or any identity.',
    'Never tag liquor, wine, disposables or other consumables.',
    `event_type_guess is one of: ${EVENT_CLASSES.join(', ')}, or null when the photo does not show which.`,
    'Answer with JSON only, no prose:',
    '{"tags":[{"tag":"<a tag above>","confidence":0.0}],"free":["<up to 3 short lowercase words>"],"event_type_guess":null}',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- the model

// Text -> the parsed answer, or throws. Tolerates a ```json fence, nothing else.
function parseModelJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const o = JSON.parse(s);
  if (!o || typeof o !== 'object' || !Array.isArray(o.tags)) throw new Error('answer has no tags array');
  return o;
}

function createClaudeClient({ apiKey, fetchImpl = globalThis.fetch, model = MODEL } = {}) {
  if (!apiKey) throw new Error('no Anthropic API key');
  return {
    model,
    async describe(thumb, prompt) {
      const r = await fetchImpl(API_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumb.toString('base64') } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(`model call ${r.status}: ${(body && body.error && body.error.message) || 'error'}`);
      return (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    },
  };
}

// ---------------------------------------------------------------- one photo

// What the core's IDENTITY word list misses: descriptions of WHO is in the
// picture (ancestry, faith, age, gender, body). Seen red 10.04.2026: "asian
// guests" passed the core screen. Colour words (white, black) are left out on
// purpose, because "white florals" is a real tag.
const PERSON_WORDS = /\b(asian|african|hispanic|latin[oax]|caucasian|indian|arab|jewish|muslim|christian|hindu|sikh|gay|lesbian|elderly|old|young|teen|teenager|child|children|kid|kids|baby|toddler|man|men|woman|women|girl|girls|boy|boys|lady|ladies|guy|guys|blonde?|brunette|redhead|bald|tattoos?|pregnant|disabled|wheelchair user)\b/;

function personTag(word) { return PERSON_WORDS.test(A.norm(word)); }

// `removed` are this photo's human-removed tags; `added` its human-added ones.
async function tagPhoto({ model, vocab, prompt, thumb, removed = [], added = [] }) {
  if (!thumb || !thumb.length) throw new Error('no thumbnail');
  if (thumb.length > MAX_THUMB_BYTES) throw new Error(`refused: ${thumb.length} bytes is not a thumbnail`);
  const answer = parseModelJson(await model.describe(thumb, prompt));
  const raw = [...answer.tags, ...(answer.free || []).slice(0, 3).map((t) => ({ tag: t, confidence: 0.5 }))];
  const personal = raw.filter((t) => t && personTag(t.tag)).map((t) => ({ tag: t.tag, why: 'identifies a person' }));
  const screened = A.screenAiTags(vocab, raw.filter((t) => !(t && personTag(t.tag))));
  screened.dropped.push(...personal);
  const gone = new Set(removed.map(A.norm));
  const ai = screened.tags.filter((t) => !gone.has(A.norm(t.tag)));
  const guess = EVENT_CLASSES.includes(answer.event_type_guess) ? answer.event_type_guess : null;
  return { ai, final: A.finalTags({ ai, added, removed }), dropped: screened.dropped, event_type_guess: guess };
}

// ---------------------------------------------------------------- a batch

// `photos` [{ drive_id, ... }]; `getThumb(photo)` resolves to bytes. Tags at most
// `cap` photos, `batchSize` at a time. One bad photo is logged and skipped.
async function tagBatch({ photos, getThumb, model, vocab, prompt, cap = 500, batchSize = 10,
  removedFor = () => [], addedFor = () => [], onTagged = async () => {}, log = console.log }) {
  const todo = photos.slice(0, Math.max(0, cap));
  const results = [];
  const skipped = [];
  for (let i = 0; i < todo.length; i += batchSize) {
    await Promise.all(todo.slice(i, i + batchSize).map(async (p) => {
      try {
        const thumb = await getThumb(p);
        const r = await tagPhoto({ model, vocab, prompt, thumb, removed: removedFor(p), added: addedFor(p) });
        results.push({ photo: p, ...r });
        await onTagged(p, r);
      } catch (e) {
        skipped.push({ drive_id: p.drive_id, why: String(e.message || e) });
        log(`SKIPPED ${p.drive_id}: ${e.message || e}`);
      }
    }));
    log(`${results.length} of ${todo.length} tagged (${skipped.length} skipped; ${photos.length} waiting in all)`);
  }
  return { results, skipped, capped: photos.length > todo.length };
}

// ---------------------------------------------------------------- the sample

const isCorporate = (f) => {
  const p = A.parsePath(f.path);
  return p.brand === 'NLP' || p.event_class === 'corporate' || f.path.some((s) => /corporate/i.test(s));
};
const venueOf = (f) => A.parsePath(f.path).venue || f.path.map(A.venueCode).find(Boolean) || null;
const hashOrder = (id) => require('crypto').createHash('sha1').update(String(id)).digest('hex');

// #1240 step 3: N images, at least `minCorporate` corporate or NLP, across at
// least `minVenues` venues. Deterministic (ordered by a hash of the id).
function pickSample(files, { n = 20, minCorporate = 8, minVenues = 4 } = {}) {
  const imgs = files.filter((f) => /^image\//.test(f.mimeType || '') && f.thumbnailLink)
    .sort((a, b) => hashOrder(a.id).localeCompare(hashOrder(b.id)));
  const out = [];
  const take = (f) => { if (out.length < n && !out.includes(f)) out.push(f); };
  imgs.filter(isCorporate).slice(0, minCorporate).forEach(take);
  const venues = new Set(out.map(venueOf).filter(Boolean));
  for (const f of imgs) {
    if (venues.size >= minVenues) break;
    const v = venueOf(f);
    if (v && !venues.has(v)) { take(f); venues.add(v); }
  }
  imgs.forEach(take);
  return {
    sample: out,
    corporate: out.filter(isCorporate).length,
    venues: [...new Set(out.map(venueOf).filter(Boolean))],
  };
}

module.exports = {
  MODEL, API_URL, MAX_THUMB_BYTES, KEY_ENV, KEYCHAIN_SERVICE,
  findApiKey, vocabFromRows, buildPrompt, parseModelJson, createClaudeClient,
  tagPhoto, tagBatch, pickSample, isCorporate, venueOf, personTag,
};
