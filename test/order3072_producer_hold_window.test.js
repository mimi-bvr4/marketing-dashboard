'use strict';
// ORDER #3072 (ruling on #2939, Mimi 11.06.2026 19:21 CT): the Producer's
// waiting hold is 20 from 11.09.2026 00:00 CT through 11.22.2026 23:59 CT, and
// 15 before and after, with no human action to set it back. The window is data
// in the department config, not an `if` on today's date in the Producer.
const { test } = require('node:test');
const assert = require('node:assert');

const P = require('../lib/producer');
const MKT = require('../config/department.marketing');
const AP = require('../packages/agent-platform');

// Nashville wall-clock instants (CST, UTC-6, in force all of November 2026).
const ct = (ymd, hm) => new Date(`${ymd}T${hm}:00-06:00`);

test('the hold is 15, 20, 20, 15 at the four edges of the window (CT)', () => {
  assert.strictEqual(P.holdAt(ct('2026-11-08', '23:59')), 15);
  assert.strictEqual(P.holdAt(ct('2026-11-09', '00:00')), 20);
  assert.strictEqual(P.holdAt(ct('2026-11-22', '23:59')), 20);
  assert.strictEqual(P.holdAt(ct('2026-11-23', '00:00')), 15);
});

test('the window reads Nashville days, not UTC days', () => {
  // 11.08 20:00 CT is already 11.09 in UTC: still the old hold.
  assert.strictEqual(P.holdAt(ct('2026-11-08', '20:00')), 15);
  // 11.22 20:00 CT is already 11.23 in UTC: still the window.
  assert.strictEqual(P.holdAt(ct('2026-11-22', '20:00')), 20);
});

test('the held reason names the number in force', async () => {
  const d = P.decide({ agent: 'scout', waiting: 20, used: 0, maxCards: 3, hold: P.holdAt(ct('2026-11-10', '09:00')) });
  assert.strictEqual(d.run, false);
  assert.match(d.why, /20 drafts are waiting for review \(the hold starts at 20\)/);
  const free = P.decide({ agent: 'scout', waiting: 19, used: 0, maxCards: 3, hold: P.holdAt(ct('2026-11-10', '09:00')) });
  assert.strictEqual(free.run, true);
});

test('runDay uses the hold in force on its day: 19 waiting runs on 11.10, is held on 11.23', async () => {
  const mk = () => {
    const logged = [];
    return {
      logged,
      store: {
        draftsWaiting: async () => 19,
        producerWeekCards: async () => 0,
        producerLog: async (row) => { logged.push(row); },
        producerRecordCards: async () => {},
      },
    };
  };
  const ran = [];
  const runOne = async (a) => { ran.push(a); return { cards: [] }; };
  const a = mk();
  await P.runDay({ ymd: '2026-11-10', store: a.store, runOne, maxCardsOf: () => 1 });
  assert.ok(!a.logged.some((r) => r.decision === 'held' && /waiting for review/.test(r.why)), JSON.stringify(a.logged));
  const b = mk();
  await P.runDay({ ymd: '2026-11-23', store: b.store, runOne, maxCardsOf: () => 1 });
  const held = b.logged.filter((r) => r.decision === 'held');
  assert.ok(held.length > 0);
  for (const r of held) assert.match(r.why, /19 drafts are waiting for review \(the hold starts at 15\)/);
});

test('the window is one line of the marketing config; the base stays 15', () => {
  assert.strictEqual(MKT.producer.waiting_hold, 15);
  assert.strictEqual(P.WAITING_HOLD, 15);
  assert.deepStrictEqual({ ...MKT.producer.waiting_hold_window }, { value: 20, from: '2026-11-09', to: '2026-11-22' });
});

test('with no window the hold is the base every day (deleting the line reverses the ruling)', () => {
  const DEMO = {
    id: 'demo', name: 'Demo',
    head: { name: 'H', emails: ['h@example.com'] },
    instruction_approver: { name: 'A', emails: ['a@example.com'] },
    agents_dir: '/x', skills_dir: '/x',
  };
  const d = AP.defineDepartment(DEMO);
  assert.strictEqual(d.producer.waiting_hold_window, null);
  for (const ymd of ['2026-11-08', '2026-11-09', '2026-11-22', '2026-11-23']) assert.strictEqual(AP.waitingHoldOn(d, ymd), 15);
});

test('a bad window is refused with the reason', () => {
  const base = {
    id: 'demo', name: 'Demo',
    head: { name: 'H', emails: ['h@example.com'] },
    instruction_approver: { name: 'A', emails: ['a@example.com'] },
    agents_dir: '/x', skills_dir: '/x',
  };
  for (const w of [
    { value: 0, from: '2026-11-09', to: '2026-11-22' },
    { value: 20, from: '11.09.2026', to: '2026-11-22' },
    { value: 20, from: '2026-11-22', to: '2026-11-09' },
    { value: 20 },
  ]) {
    assert.throws(() => AP.defineDepartment({ ...base, producer: { waiting_hold_window: w } }), /producer\.waiting_hold_window/);
  }
});
