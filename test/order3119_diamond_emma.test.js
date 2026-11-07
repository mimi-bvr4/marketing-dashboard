'use strict';
// ORDER #3119: Mimi re-cast the Engagement Sleuth on 11.07.2026 as a warm woman
// in her 50s. Voice Emma (Voice Library id dmWfLQZJq7wNPv9WmtiM), name "Diamond"
// (no longer "Detective Diamond"), and her 10 lines rewritten by the Marketing
// chat. The card must play the 10 new clips captioned with the new lines, and
// nothing may still call her "Detective Diamond". No express here, so it runs in
// a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AV = require('../lib/agent-voices');

const LINES = [
  'Somewhere in this city, someone just said yes. My job is to make sure our ad says hello.',
  "I don't snoop on anybody. Meta finds the newly engaged. I just write them a sweet note.",
  'The ring is on the finger, and the planning clock is ticking.',
  'Every love story starts with a search. I make sure we show up in it.',
  "My plan's on the card. Someone with the keys sets the targeting. Those are the rules.",
  "A garden shot for the spring couples, golden hour for the fall crowd. Now that's a good match.",
  "Diamonds are forever. Ad budgets are not. That's why a human holds them.",
  "I've heard a lot of proposal stories. I never get tired of them.",
  'The landing page is ready, the lead is warm, and my fingers are crossed.',
  "They're engaged. We're ready. Let's not keep them waiting.",
];

test('Diamond speaks as Emma, under the name "Diamond", with her 10 rewritten lines', () => {
  const c = AV.loadScript().find((x) => x.slug === 'engagement-sleuth');
  assert.ok(c, 'engagement-sleuth is in the script');
  assert.strictEqual(c.heading, 'Diamond, Engagement Sleuth');
  assert.strictEqual(c.voice, 'Emma');
  assert.deepStrictEqual(c.lines, LINES);
  for (const l of c.lines) assert.ok(!/—/.test(l), `no em dash: ${l}`);
});

test('switch ON: her card plays the 10 new clips with the new captions', () => {
  const clips = AV.apiBody({ AGENT_VOICES: 'on' }).voices['engagement-sleuth'];
  assert.ok(clips, 'she has a button');
  assert.deepStrictEqual(clips.map((x) => x.line), LINES);
  clips.forEach((x, i) => {
    assert.strictEqual(x.src, `${AV.CLIP_URL}/engagement-sleuth_${String(i + 1).padStart(2, '0')}.mp3`);
    assert.ok(fs.statSync(path.join(AV.CLIP_DIR, path.basename(x.src))).size > 1000);
  });
});

test('a REWRITTEN note after the voice keeps the character; other notes stay notes', () => {
  const text = [
    '## Scout (Chris)', '1. One.', '',
    '## Diamond, Engagement Sleuth (Emma). REWRITTEN 11.07.2026 (Mimi: keep "Diamond"); old lines in _archive', '1. Hello.', '',
    '## Convention Charles: CVB swaps APPLIED 11.05.2026 (Mimi: "do it"). Lines 8 and 10 above replaced', '- ALT A: not a line.',
  ].join('\n');
  assert.deepStrictEqual(AV.parseScript(text).map((c) => [c.slug, c.voice, c.lines]), [['scout', 'Chris', ['One.']], ['engagement-sleuth', 'Emma', ['Hello.']]]);
});

test('nothing in the app still calls her "Detective Diamond"', () => {
  const root = path.join(__dirname, '..');
  const files = [
    path.join(root, 'lib', 'agent-voices.js'),
    AV.SOURCE,
    path.join(root, 'agents', 'engagement-sleuth', 'agent.json'),
    path.join(root, 'agents', 'engagement-sleuth', 'SKILL.md'),
  ];
  for (const f of files) assert.ok(!/Detective Diamond/.test(fs.readFileSync(f, 'utf8')), `${path.relative(root, f)} has no "Detective Diamond"`);
});
