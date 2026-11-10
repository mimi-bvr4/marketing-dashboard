'use strict';
// ORDER #2955 step 2: the recorded clips on disk. Every file in
// public/agent-voices is <slug>_NN.mp3 for a character in the script and a line
// it has, is a real MP3, and every character has all 10 except the ones listed
// below as waiting. No express here, so it runs in a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AV = require('../lib/agent-voices');

// Characters still waiting on a voice. Empty since ORDER #2978 (11.05.2026):
// web was recorded in Bella, a default voice, after Charlotte (not on the
// account) and Emma (a professional voice) were ruled out.
// ORDER #3000 (11.05.2026): NB's three new agents got their lines and voices in
// the script (Roger, River, Adam). ORDER #3001: their 30 clips are recorded, so
// nobody is waiting.
// ORDER #3163 (11.10.2026): the Keyword Queen has her lines; Mimi picks her
// voice, and no clip is recorded until she does.
const WAITING = ['keyword-queen'];

const files = fs.readdirSync(AV.CLIP_DIR).filter((f) => !f.startsWith('.'));

test('every clip on disk belongs to a character and a line in the script', () => {
  const script = AV.loadScript();
  const known = new Set();
  for (const c of script) c.lines.forEach((_, i) => known.add(AV.clipName(c.slug, i)));
  for (const f of files) assert.ok(known.has(f), `${f} is not <slug>_NN.mp3 for a scripted line`);
});

test('every clip is a non-empty MP3', () => {
  for (const f of files) {
    const b = fs.readFileSync(path.join(AV.CLIP_DIR, f));
    assert.ok(b.length > 1000, `${f} is too small to be speech`);
    const id3 = b.slice(0, 3).toString('latin1') === 'ID3';
    const frame = b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
    assert.ok(id3 || frame, `${f} does not start like an MP3`);
  }
});

test('every character has its 10 clips, except the ones waiting on a voice', () => {
  const script = AV.loadScript();
  for (const c of script) {
    const have = c.lines.filter((_, i) => files.includes(AV.clipName(c.slug, i))).length;
    if (WAITING.includes(c.slug)) assert.strictEqual(have, 0, `${c.slug} is listed as waiting but has clips; take it off WAITING`);
    else assert.strictEqual(have, 10, `${c.slug} has ${have} of 10 clips`);
  }
  assert.strictEqual(files.length, (script.length - WAITING.length) * 10);
});

test('switch ON: the manifest offers each recorded character all 10 of its clips', () => {
  const m = AV.manifest();
  for (const c of AV.loadScript()) {
    if (WAITING.includes(c.slug)) { assert.ok(!m[c.slug], `${c.slug} has no clips yet, so no button`); continue; }
    const clips = m[c.slug];
    assert.ok(clips, `${c.slug} is in the manifest`);
    assert.strictEqual(clips.length, 10, `${c.slug} offers 10 clips`);
    clips.forEach((x, i) => {
      assert.strictEqual(x.src, `${AV.CLIP_URL}/${AV.clipName(c.slug, i)}`);
      assert.strictEqual(x.line, c.lines[i], `${c.slug} clip ${i + 1} captions its own line`);
    });
  }
});
