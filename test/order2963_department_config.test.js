'use strict';
// ORDER #2963 slice 1: Marketing's department config matches what the in-repo
// agent code uses today, value for value, so the switch onto the module is parity.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MKT = require('../config/department.marketing');
const W = require('../lib/reviewer-watch');
const runner = require('../lib/agent-runner');
const P = require('../packages/agent-platform');

test('marketing config validates and is frozen', () => {
  assert.strictEqual(MKT.id, 'marketing');
  assert.ok(Object.isFrozen(MKT));
  assert.ok(MKT.laws.includes('compensation never') && MKT.laws.includes('finance read-only'));
});

test('head, pages and visit pages equal reviewer-watch DEPARTMENTS marketing', () => {
  const d = W.department('marketing');
  assert.strictEqual(MKT.head.name, d.head);
  assert.deepStrictEqual([...MKT.head.emails], d.head_emails);
  assert.strictEqual(MKT.pages.review, d.review_page);
  assert.strictEqual(MKT.pages.agents, d.agents_page);
  assert.deepStrictEqual([...MKT.visit_pages], d.visit_pages);
});

test('agents folder is the runner\'s AGENTS_DIR and every agent loads from it', () => {
  assert.strictEqual(path.resolve(MKT.agents_dir), path.resolve(runner.AGENTS_DIR));
  assert.ok(runner.listAgents(MKT.agents_dir).length > 0);
});

test('Producer cap and hold are today\'s numbers (25 / 15)', () => {
  const producer = require('../lib/producer');
  assert.strictEqual(MKT.producer.weekly_cap, producer.WEEKLY_CAP);
  assert.strictEqual(MKT.producer.waiting_hold, producer.WAITING_HOLD);
});

test('migration default is marketing, so existing rows keep working', () => {
  for (const s of P.departmentMigrationSql(MKT.id).filter((x) => x.startsWith('ALTER'))) assert.match(s, /DEFAULT 'marketing'$/);
});
