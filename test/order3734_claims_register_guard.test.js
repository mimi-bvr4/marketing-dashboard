// ORDER #3734 (#3602 item 3, #3575 step 5): the Fact-Checker (Citations) and
// Bloggy Bob carry the claims-register guard. A provenance or history claim
// must trace to a register row marked TRUE, or it is cut. The allowed claims
// are read from the register file itself (07_Marketing_and_Brand/
// Claims_Register_11.18.2026.md), never typed into a prompt, so Mimi's later
// marks flow in with no new order. The fixture is a copy of that register as
// built 11.22.2026 by #3575.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadAgent } = require('../lib/agent-runner');
const { fileSource } = require('../lib/agent-sources');

const TREE = path.join(__dirname, 'fixtures', 'claims_register');
const REG = '07_Marketing_and_Brand/Claims_Register_11.18.2026.md';
const AGENTS = ['citations', 'bloggy-bob'];

const regSource = (slug) => loadAgent(slug).sources.find((s) => s.type === 'file' && s.path === REG);
const readReg = async (slug) => fileSource(regSource(slug), { env: { IHG_TREE: TREE } });

// The 12 rows marked TRUE on 11.18.2026. B1-1..B1-5 of the rulings file
// (#3602) are A11, A4, A21, A5, A6; #3603 is A26, A29, A24, A25, A18; #3605's
// TRUE rows are A14 and A22.
const B3602 = { 'B1-1': 'A11', 'B1-2': 'A4', 'B1-3': 'A21', 'B1-4': 'A5', 'B1-5': 'A6' };
const OTHER_TRUE = ['A26', 'A29', 'A24', 'A25', 'A18', 'A14', 'A22'];

test('1a: both agents carry the guard in their instructions', () => {
  for (const slug of AGENTS) {
    const a = loadAgent(slug);
    assert.match(a.skill, /ORDER #3575 step 5/, slug);
    assert.match(a.skill, /must trace to a (claims )?register row marked TRUE/i, slug);
    assert.match(a.skill, /cut/i, slug);
    for (const w of ['original', 'built by', 'first', 'only', 'largest']) assert.ok(a.skill.includes(`"${w}"`), `${slug} names "${w}"`);
    assert.match(a.skill, /year or count/i, slug);
  }
});

test('1a: the register source carries the guard too (a saved Agents-page version cannot drop it)', async () => {
  for (const slug of AGENTS) {
    assert.ok(regSource(slug), `${slug} reads ${REG}`);
    const r = await readReg(slug);
    assert.strictEqual(r.ok, true, `${slug}: ${r.why}`);
    assert.match(r.text, /must trace to a row marked TRUE/i);
    assert.match(r.text, /cut/i);
  }
});

test('1b: the 5 #3602 rows and the other 7 TRUE rows reach both agents, sourced Mimi 11.18.2026', async () => {
  for (const slug of AGENTS) {
    const { text } = await readReg(slug);
    for (const id of [...Object.values(B3602), ...OTHER_TRUE]) {
      const line = text.split('\n').find((l) => l.startsWith(`- ${id} `));
      assert.ok(line, `${slug}: allowed row ${id}`);
      assert.match(line, /source: Mimi 11\.18\.2026/, `${slug}: ${id} source`);
    }
    assert.match(text, /Amish/);
    assert.match(text, /first built by freed slaves/);
    assert.match(text, /choir loft/);
  }
});

test('1c: TBB 1,200 or 610 is never paired with one room, always building-wide', async () => {
  for (const slug of AGENTS) {
    const a = loadAgent(slug);
    assert.match(a.skill, /610 seated across our floors/, slug);
    assert.match(a.skill, /1,200 guests across the building/, slug);
    const { text } = await readReg(slug);
    assert.match(text, /610 seated across our floors/);
    assert.match(text, /1,200 guests across the building/);
    assert.ok(!text.split('\n').some((l) => l.startsWith('- A3 ')), 'A3 is not a TRUE row; it rides on the TBB rule');
  }
});

test('1d: a row not marked TRUE is not on the allowed list, and neither is the bells claim', async () => {
  const { text } = await readReg('citations');
  const allowed = text.split('\n').filter((l) => /^- [A-C]\d+ /.test(l)).map((l) => l.split(' ')[1]);
  assert.strictEqual(allowed.length, 12, allowed.join(','));
  for (const id of ['A1', 'A2', 'A3', 'A7', 'A8', 'A15', 'B1', 'B3', 'B5', 'B6', 'B19', 'C3', 'C4']) assert.ok(!allowed.includes(id), id);
  assert.ok(!/original bell tower of the church/.test(text), 'A7 text');
  assert.ok(!/largest free-standing/.test(text), 'A8 text');
  assert.ok(!/church bells/i.test(text.split('NOT ALLOWED')[0]), 'bells (#3574, FALSE)');
});

test('Mimi marking a row TRUE later lets it in with no code change', () => {
  const { allowedClaims } = require('../lib/claims-register');
  const md = fs.readFileSync(path.join(TREE, REG), 'utf8').replace(/(\| A12 \|[^\n]*\| )____ \|/, '$1TRUE |');
  const ids = allowedClaims(md).allowed.map((r) => r.id);
  assert.ok(ids.includes('A12'));
  assert.strictEqual(ids.length, 13);
});
