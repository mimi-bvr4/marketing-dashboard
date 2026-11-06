'use strict';
// ORDER #3005: Convention Charles lines 8 and 10 swapped for the CVB lines
// (Mimi 11.05.2026 "do it"). The caption and the clip must both be the new
// line; the old lines are gone from the script. No express here.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AV = require('../lib/agent-voices');

const NEW8 = 'Drafted a note to the CVB this morning. Sales will do the calling. I just bring the charm.';
const NEW10 = "Every conference has a rep who books the after-party. I'd like to meet that rep.";
const OLD8 = 'Business cards are back, I tell you. Like vinyl.';
const OLD10 = "Y'all, if I had a nickel for every lanyard I've seen, I'd buy another lanyard.";

test('Charles: lines 8 and 10 are the CVB lines, the old ones are gone', () => {
  const charles = AV.loadScript().find((c) => c.slug === 'convention-connector');
  assert.ok(charles, 'convention-connector is in the script');
  assert.strictEqual(charles.voice, 'Bill');
  assert.strictEqual(charles.lines.length, 10);
  assert.strictEqual(charles.lines[7], NEW8);
  assert.strictEqual(charles.lines[9], NEW10);
  assert.ok(!charles.lines.includes(OLD8));
  assert.ok(!charles.lines.includes(OLD10));
});

// sha256 of the 11.04.2026 recordings of the OLD lines (#2955), now in
// Marketing Build/agent_voices/_archive/
const OLD_SHA = {
  '08': 'af52323cf7fdff2a39a1bd0c9462c95c373a4211733cb00c9e88889a607025b0',
  '10': 'a5b3d669ccae3c6b0cc0c2c0e1be7194241c9a1fd34338cf04ddcb088e0c76ad',
};

test('Charles: clips 08 and 10 are real MP3s and are not the old recordings', () => {
  for (const n of ['08', '10']) {
    const b = fs.readFileSync(path.join(__dirname, '..', 'public', 'agent-voices', `convention-connector_${n}.mp3`));
    const id3 = b.subarray(0, 3).toString('latin1') === 'ID3';
    const frame = b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
    assert.ok(id3 || frame, `convention-connector_${n}.mp3 is an MP3 by its bytes`);
    assert.ok(b.length > 10000, `convention-connector_${n}.mp3 is not empty`);
    const sha = crypto.createHash('sha256').update(b).digest('hex');
    assert.notStrictEqual(sha, OLD_SHA[n], `convention-connector_${n}.mp3 is the new CVB recording, not the old line`);
  }
});
