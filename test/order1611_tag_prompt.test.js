// ORDER #1611: the tightened tagging prompt. #1278's graded sample (71% right)
// named four miss classes; each one has a rule in the prompt, and each rule is
// pinned here so a later edit cannot quietly drop it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/photo-tagger');
const { GROUPS, SYNONYMS } = require('../lib/photo-vocabulary');

const PROMPT = T.buildPrompt({ groups: GROUPS, synonyms: SYNONYMS });

test('day or night only when sky, sunlight or windows show it', () => {
  assert.match(PROMPT, /day or night: ONLY when sky, sunlight or windows show it/);
});

test('exterior only outdoors', () => {
  assert.match(PROMPT, /exterior: ONLY when the photo is taken outdoors/);
});

test('sweetheart and head tables are not rounds, and go in free', () => {
  assert.match(PROMPT, /rounds \/ banquet rounds: ONLY round guest tables/);
  assert.match(PROMPT, /"sweetheart table" or "head table" in free/);
});

test('lounge furniture only for sofas, armchairs or ottomans', () => {
  assert.match(PROMPT, /lounge furniture \/ soft seating: ONLY sofas, armchairs or ottomans/);
});

test('meeting setups are not ceremonies or dinners', () => {
  assert.match(PROMPT, /classroom, theater, boardroom, breakout room: ONLY a meeting set/);
});

test('event type is null when the photo does not show it', () => {
  assert.match(PROMPT, /or null when the photo does not show which/);
});

test('the identity and consumables rules are still there', () => {
  assert.match(PROMPT, /Never tag who a person is/);
  assert.match(PROMPT, /Never tag liquor, wine, disposables/);
  assert.match(PROMPT, /JSON only/);
});
