#!/usr/bin/env node
// ORDER #2955: write one narrate.py script per character (one line per
// paragraph, verbatim from agents/voices/AGENT_CATCHPHRASES_AND_VOICES.md) and
// voices.tsv (slug, voice NAME, characters) into <outdir>. Reads and writes
// files only; it never calls ElevenLabs. The recording is
//   python3 ~/repos/brain-core/box_jobs/narrate/narrate.py <outdir>/<slug>.txt \
//     --voice <Voice> --prefix <slug> --out <clipdir>
// one character per call, default voices only (narrate.py refuses the rest).
'use strict';
const fs = require('fs');
const path = require('path');
const { narrationScripts } = require('../lib/agent-voices');

const out = process.argv[2];
if (!out) { console.error('usage: node jobs/agent_voices_scripts.js <outdir>'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
let total = 0;
const rows = ['slug\tvoice\tcharacters'];
for (const s of narrationScripts()) {
  fs.writeFileSync(path.join(out, `${s.slug}.txt`), s.text);
  const n = s.text.split(/\n\n/).map((x) => x.trim()).filter(Boolean).reduce((a, x) => a + x.length, 0);
  total += n;
  rows.push(`${s.slug}\t${s.voice}\t${n}`);
}
fs.writeFileSync(path.join(out, 'voices.tsv'), rows.join('\n') + '\n');
console.log(`${rows.length - 1} scripts, ${total} characters, written to ${out}`);
