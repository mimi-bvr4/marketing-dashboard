'use strict';
// ORDER #2955: the "say something" button. Switch off means no button; switch
// on means a click plays a clip of the right character, never the same clip
// twice in a row, with the line as the caption. No express here, so it runs in
// a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AV = require('../lib/agent-voices');
const V = require('../public/agents-view');
const { listAgents, loadAgent } = require('../lib/agent-runner');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'agents.js'), 'utf8');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function clipDir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v2955-'));
  for (const f of files) fs.writeFileSync(path.join(d, f), 'ID3');
  return d;
}

test('the script: 17 characters, 10 lines each, one per card plus the Producer', () => {
  const s = AV.loadScript();
  assert.strictEqual(s.length, 17);
  for (const c of s) assert.strictEqual(c.lines.length, 10, `${c.slug} has 10 lines`);
  const slugs = s.map((c) => c.slug).sort();
  // #3000: a new member whose lines are not written yet says so in its agent.json
  // ("voice_pending"); it has no button until the Marketing chat's lines land.
  const voiced = listAgents().filter((a) => !loadAgent(a).voice_pending);
  assert.deepStrictEqual(slugs, ['producer', ...voiced].sort(), 'every card has a voice, and every voice a card');
  assert.strictEqual(new Set(s.map((c) => c.voice)).size, 17, 'no voice shared');
});

test('the lines are verbatim from the source and carry no em dash', () => {
  const s = AV.loadScript();
  const alice = s.find((c) => c.slug === 'producer');
  assert.strictEqual(alice.voice, 'Alice');
  assert.strictEqual(alice.lines[0], 'Places, everyone. The week does not run itself. Well, technically I run it.');
  assert.strictEqual(s.find((c) => c.slug === 'site-guardian').lines[9], 'Dawn\'s coming. Handing the watch back to the day crew.');
  for (const c of s) for (const l of c.lines) assert.doesNotMatch(l, /—/, `${c.slug}: no em dash`);
  // the repo copy matches the Marketing Build original whenever the original is on this machine
  const orig = path.join(os.homedir(), 'Full_IH_Project', '01_Operations', 'Marketing Build', 'AGENT_CATCHPHRASES_AND_VOICES.md');
  if (fs.existsSync(orig)) assert.strictEqual(fs.readFileSync(AV.SOURCE, 'utf8'), fs.readFileSync(orig, 'utf8'), 'repo copy is byte-identical to the source');
});

test('switch OFF: the API says off and the page draws no button', () => {
  assert.deepStrictEqual(AV.apiBody({}), { on: false });
  assert.deepStrictEqual(AV.apiBody({ AGENT_VOICES: 'off' }), { on: false });
  const dir = clipDir(['producer_01.mp3', 'scout_01.mp3']);
  assert.deepStrictEqual(AV.apiBody({}, { dir }), { on: false }, 'clips on disk do not turn it on');
  assert.strictEqual(V.speakerHtml({ on: false }, 'scout', 'Scout', esc), '');
  assert.strictEqual(V.speakerHtml(null, 'scout', 'Scout', esc), '');
  assert.strictEqual(V.speakerFor({ on: false, voices: { scout: [{ src: 'x', line: 'y' }] } }, 'scout'), null);
});

test('switch ON: each character gets only its own clips that exist on disk', () => {
  const dir = clipDir(['producer_01.mp3', 'producer_02.mp3', 'scout_07.mp3']);
  const body = AV.apiBody({ AGENT_VOICES: 'on' }, { dir });
  assert.strictEqual(body.on, true);
  assert.deepStrictEqual(Object.keys(body.voices).sort(), ['producer', 'scout']);
  assert.deepStrictEqual(body.voices.scout, [{ src: '/agent-voices/scout_07.mp3', line: AV.loadScript().find((c) => c.slug === 'scout').lines[6] }]);
  assert.strictEqual(body.voices.producer[1].src, '/agent-voices/producer_02.mp3');
  assert.strictEqual(V.speakerHtml(body, 'gbp', 'Google Business', esc), '', 'no clips, no button');
  const html = V.speakerHtml(body, 'scout', 'Scout', esc);
  assert.match(html, /data-speak="scout"/);
  assert.match(html, /data-speakcap="scout"[^>]*hidden/, 'caption hidden until it plays');
});

test('a click picks a clip of THAT character, never the same one twice in a row', () => {
  const state = { on: true, voices: { scout: Array.from({ length: 10 }, (_, i) => ({ src: `/agent-voices/scout_${i}.mp3`, line: `l${i}` })) } };
  const clips = V.speakerFor(state, 'scout');
  let last = null;
  for (let k = 0; k < 500; k++) {
    const i = V.pickClip(clips.length, last);
    assert.ok(i >= 0 && i < 10);
    assert.notStrictEqual(i, last, 'never the same clip twice in a row');
    assert.match(clips[i].src, /\/scout_/);
    last = i;
  }
  for (let last2 = 0; last2 < 10; last2++) for (const r of [0, 0.5, 0.9999]) assert.notStrictEqual(V.pickClip(10, last2, () => r), last2);
  assert.strictEqual(V.pickClip(1, 0), 0, 'one clip plays');
  assert.strictEqual(V.pickClip(0, null), -1);
});

test('the page: button on every card and the Producer, click only, no loop, caption', () => {
  assert.match(HTML, /V\.speakerHtml\(voices, a\.slug, a\.name, esc\)/, 'character cards');
  assert.match(HTML, /V\.speakerHtml\(voices, 'producer', p\.name, esc\)/, 'the Producer');
  assert.match(HTML, /let voices = \{ on: false \};/, 'off until the API says on');
  assert.match(HTML, /api\('\/api\/agent-voices'\)/);
  assert.match(HTML, /a\.loop = false/);
  assert.doesNotMatch(HTML, /autoplay/i);
  assert.match(HTML, /cap\.textContent = clips\[i\]\.line/, 'the line is the caption');
  assert.match(ROUTE, /r\.get\('\/api\/agent-voices', need,/, 'signed-in only');
});

test('narration scripts: one per character, one line per paragraph', () => {
  const s = AV.narrationScripts();
  assert.strictEqual(s.length, 17);
  const p = s.find((x) => x.slug === 'producer');
  assert.strictEqual(p.text.split('\n\n').length, 10);
  assert.ok(p.text.startsWith('Places, everyone.'));
});

test('the flag name and its default', () => {
  assert.strictEqual(AV.FLAG, 'AGENT_VOICES');
  assert.strictEqual(AV.voicesOn({}), false);
  assert.strictEqual(AV.voicesOn({ AGENT_VOICES: 'on' }), true);
});
