'use strict';
// ORDER #3001: NB's three new agents (#3000) play their own voice. The card's
// "say something" button is keyed by the agent's folder name (listAgents), so
// each new card's slug must be the slug its 10 clips are filed under, and each
// clip must caption its own scripted line. No express here, so it runs in a
// worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AV = require('../lib/agent-voices');
const { listAgents } = require('../lib/agent-runner');

const NEW = { 'planner-scout': 'Roger', 'gala-scout': 'River', 'engagement-sleuth': 'Adam' };

test('each new agent is a card on the team page under the slug its clips use', () => {
  const cards = listAgents();
  for (const slug of Object.keys(NEW)) assert.ok(cards.includes(slug), `${slug} is a card`);
});

test('each new agent speaks in its own voice from the script, 10 lines', () => {
  const script = AV.loadScript();
  for (const [slug, voice] of Object.entries(NEW)) {
    const c = script.find((x) => x.slug === slug);
    assert.ok(c, `${slug} is in the script`);
    assert.strictEqual(c.voice, voice, `${slug} speaks as ${voice}`);
    assert.strictEqual(c.lines.length, 10, `${slug} has 10 lines`);
  }
});

test('switch ON: each new card plays only its own 10 clips, captioned with its own lines', () => {
  const m = AV.apiBody({ AGENT_VOICES: 'on' }).voices;
  const script = AV.loadScript();
  for (const slug of Object.keys(NEW)) {
    const c = script.find((x) => x.slug === slug);
    const clips = m[slug];
    assert.ok(clips, `${slug} has a button`);
    assert.strictEqual(clips.length, 10);
    clips.forEach((x, i) => {
      assert.strictEqual(x.src, `${AV.CLIP_URL}/${slug}_${String(i + 1).padStart(2, '0')}.mp3`);
      assert.strictEqual(x.line, c.lines[i]);
      assert.ok(fs.statSync(path.join(AV.CLIP_DIR, path.basename(x.src))).size > 1000);
    });
  }
});

test('switch OFF: no button for anyone, the new three included', () => {
  assert.deepStrictEqual(AV.apiBody({}), { on: false });
});

test('a PROPOSED character (waiting for Mimi\'s OK) is not read: no card, no button, no throw', () => {
  const text = [
    '## Scout (Chris)', '1. One.', '',
    '## PROPOSED 11.05.2026 (ORDER #1, Mimi to OK): Someone New (Harry)', '1. Not yet.', '2. Still not.', '',
    '## ADDED 11.05.2026: a note (ORDER #2)', '1. Not a line.',
  ].join('\n');
  const parsed = AV.parseScript(text);
  assert.deepStrictEqual(parsed.map((c) => [c.slug, c.lines]), [['scout', ['One.']]]);
  assert.ok(!AV.loadScript().some((c) => c.voice === 'Harry'), 'the proposed Harry character is not a card yet');
});
