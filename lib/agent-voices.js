// ORDER #2955: each team card's "say something" button. Ten short lines per
// character, recorded once in that character's ElevenLabs DEFAULT voice.
//
// FEATURE FLAG: AGENT_VOICES default OFF. Off, GET /api/agent-voices answers
// { on: false } and the page draws no speaker button anywhere. Mimi listens to
// the clips first (01_Operations/Marketing Build/agent_voices/ on the laptop),
// then turns it on.
//
// THE LINES: agents/voices/AGENT_CATCHPHRASES_AND_VOICES.md is a verbatim copy
// of the Marketing chat's script. Nothing here rewrites a line; the page shows
// the same words the clip says, as a caption while it plays.
//
// THE CLIPS: public/agent-voices/<slug>_<NN>.mp3, served by express.static
// below the page gate. A character only offers the clips that exist on disk,
// so a partly recorded set plays what it has and a character with none shows
// no button.
'use strict';

const fs = require('fs');
const path = require('path');

const FLAG = 'AGENT_VOICES';
function voicesOn(env = process.env) { return /^(1|on|true|yes)$/i.test(String(env[FLAG] || '').trim()); }

const SOURCE = path.join(__dirname, '..', 'agents', 'voices', 'AGENT_CATCHPHRASES_AND_VOICES.md');
const CLIP_DIR = path.join(__dirname, '..', 'public', 'agent-voices');
const CLIP_URL = '/agent-voices';

// The script's section heading (before the voice in brackets) -> the card slug.
const SLUG_OF = {
  'The Producer': 'producer',
  'Google Business': 'gbp',
  'PR Patty': 'pr-patty',
  'Site Health': 'site-health',
  'Convention Charles': 'convention-connector',
  'Monthly Report': 'monthly-report',
  'Listings + Citations': 'citations',
  'Paid Ads Auditor': 'paid-ads',
  'SEO': 'seo',
  'Email Agent': 'email',
  'Scout': 'scout',
  'Pinterest Paul': 'pinterest-paul',
  'Bloggy Bob': 'bloggy-bob',
  'Copywriter': 'copywriter',
  'Collateral Cadet': 'collateral-cadet',
  'Web Agent': 'web',
  'Site Guardian, the night watch': 'site-guardian',
};

// [{ slug, heading, voice, lines: [10 strings] }] in the script's order.
function parseScript(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const h = raw.match(/^## (.+?) \(([^)]+)\)\s*$/);
    if (h) {
      const slug = SLUG_OF[h[1].trim()];
      if (!slug) throw new Error(`no card for the script heading "${h[1]}"`);
      cur = { slug, heading: h[1].trim(), voice: h[2].trim(), lines: [] };
      out.push(cur);
      continue;
    }
    if (/^#/.test(raw)) { cur = null; continue; }
    const l = raw.match(/^\s*(\d+)\.\s+(.+?)\s*$/);
    if (cur && l) cur.lines.push(l[2]);
  }
  return out;
}

function loadScript(file = SOURCE) { return parseScript(fs.readFileSync(file, 'utf8')); }

const clipName = (slug, i) => `${slug}_${String(i + 1).padStart(2, '0')}.mp3`;

// { slug: [{ src, line }] } for the clips that exist on disk.
function manifest({ file = SOURCE, dir = CLIP_DIR } = {}) {
  const out = {};
  for (const c of loadScript(file)) {
    const clips = c.lines.map((line, i) => ({ src: `${CLIP_URL}/${clipName(c.slug, i)}`, line, f: clipName(c.slug, i) }))
      .filter((x) => fs.existsSync(path.join(dir, x.f)))
      .map(({ src, line }) => ({ src, line }));
    if (clips.length) out[c.slug] = clips;
  }
  return out;
}

// What GET /api/agent-voices answers. Off: nothing but { on: false }.
function apiBody(env = process.env, opts) {
  if (!voicesOn(env)) return { on: false };
  return { on: true, voices: manifest(opts) };
}

// One narrate.py script per character (one line per paragraph), for recording.
function narrationScripts(file = SOURCE) {
  return loadScript(file).map((c) => ({ slug: c.slug, voice: c.voice, text: c.lines.join('\n\n') + '\n' }));
}

module.exports = { FLAG, voicesOn, SOURCE, CLIP_DIR, CLIP_URL, SLUG_OF, parseScript, loadScript, clipName, manifest, apiBody, narrationScripts };
