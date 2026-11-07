'use strict';
// ORDER #2963 slice 1: department config, the fence in code, the department column.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const P = require('..');

// A dummy department with zero agents (the order's "demo" acceptance config).
const DEMO = {
  id: 'demo', name: 'Demo',
  head: { name: 'Demo Head', emails: ['Demo.Head@example.com'] },
  instruction_approver: { name: 'Demo Approver', emails: ['approver@example.com'] },
  agents_dir: '/nowhere/agents', skills_dir: '/nowhere/skills',
};

test('a minimal config gets the defaults: exec+head gate, cap 25, hold 15, base laws, standard pages', () => {
  const d = P.defineDepartment(DEMO);
  assert.deepStrictEqual([...d.review_gate], ['exec', 'head']);
  assert.strictEqual(d.producer.weekly_cap, 25);
  assert.strictEqual(d.producer.waiting_hold, 15);
  assert.strictEqual(d.producer.waiting_hold_window, null);
  assert.deepStrictEqual([...d.laws], ['finance read-only', 'compensation never']);
  assert.strictEqual(d.pages.review, '/review');
  assert.strictEqual(d.voices, false);
  assert.strictEqual(d.build_route, null);
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.head) && Object.isFrozen(d.laws));
});

test('#3072: a dated hold window is accepted, frozen, and applies only inside its days', () => {
  const d = P.defineDepartment({ ...DEMO, producer: { waiting_hold: 15, waiting_hold_window: { value: 20, from: '2026-11-09', to: '2026-11-22' } } });
  assert.strictEqual(d.producer.waiting_hold, 15);
  assert.deepStrictEqual({ ...d.producer.waiting_hold_window }, { value: 20, from: '2026-11-09', to: '2026-11-22' });
  assert.ok(Object.isFrozen(d.producer.waiting_hold_window));
  assert.deepStrictEqual(['2026-11-08', '2026-11-09', '2026-11-22', '2026-11-23'].map((y) => P.waitingHoldOn(d, y)), [15, 20, 20, 15]);
});

test('emails are compared lowercase; head and approver are separate roles', () => {
  const d = P.defineDepartment(DEMO);
  assert.ok(P.isHead(d, 'demo.head@EXAMPLE.com'));
  assert.ok(!P.isInstructionApprover(d, 'demo.head@example.com'));
  assert.ok(P.isInstructionApprover(d, 'approver@example.com'));
  const execOnly = P.defineDepartment({ ...DEMO, review_gate: ['exec'] });
  assert.ok(!P.isHead(execOnly, 'demo.head@example.com'));
});

test('a config cannot drop the base laws', () => {
  const d = P.defineDepartment({ ...DEMO, laws: ['no weekend posts'] });
  assert.deepStrictEqual([...d.laws], ['finance read-only', 'compensation never', 'no weekend posts']);
});

test('the fence is in code: any config naming a fence key is refused, whatever its value', () => {
  for (const k of ['drafts_only', 'allow_send', 'auto_approve', 'skip_copy_checks', 'api_key', 'reviewer_reads_agent_tables_only']) {
    assert.throws(() => P.defineDepartment({ ...DEMO, [k]: false }), new RegExp(`${k}: a fence`));
  }
  assert.ok(Object.isFrozen(P.FENCE) && Object.isFrozen(P.FENCE.forbidden_actions));
  assert.throws(() => { 'use strict'; P.FENCE.drafts_only = false; }, TypeError);
  for (const a of ['send', 'POST', ' pay ', 'sign']) assert.ok(P.forbidden(a), a);
  assert.ok(!P.forbidden('draft'));
});

test('a bad config lists every problem at once', () => {
  let msg = '';
  try { P.defineDepartment({ id: 'Bad Id', review_gate: ['head'], producer: { weekly_cap: 0 }, build_route: { order_tag: 'k' } }); }
  catch (e) { msg = e.message; }
  for (const want of ['id:', 'name: missing', 'head:', 'instruction_approver:', 'skills_dir', 'agents_dir',
    'review_gate: must include "exec"', 'producer.weekly_cap', 'build_route']) assert.ok(msg.includes(want), `${want} in\n${msg}`);
});

test('department migration: additive and idempotent SQL for every shared table, default from the config', async () => {
  const sql = P.departmentMigrationSql('demo');
  assert.strictEqual(P.SHARED_TABLES.length, 14);
  for (const t of P.SHARED_TABLES) {
    assert.ok(sql.includes(`ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT 'demo'`), t);
  }
  for (const s of sql) assert.match(s, /^(ALTER TABLE IF EXISTS \w+ ADD COLUMN IF NOT EXISTS |CREATE INDEX IF NOT EXISTS )/);
  assert.ok(!sql.some((s) => /\b(DROP|RENAME|DELETE|UPDATE|TRUNCATE)\b/i.test(s)));
  // Department-only tables stay in their app.
  assert.ok(!P.SHARED_TABLES.includes('competitors') && !P.SHARED_TABLES.includes('competitor_profile_versions'));
  // The id is a SQL literal, so anything but a plain id is refused.
  for (const bad of ["x'; DROP TABLE agent_cards; --", '', 'Demo', null]) assert.throws(() => P.departmentMigrationSql(bad));
});

test('the module takes a db handle and never opens its own connection', async () => {
  const ran = [];
  const db = { query: async (s) => { ran.push(s); return { rows: [] }; } };
  const n = await P.ensureDepartmentColumn(db, 'demo');
  assert.strictEqual(n, ran.length);
  assert.deepStrictEqual(ran, P.departmentMigrationSql('demo'));
  await assert.rejects(() => P.ensureDepartmentColumn(null, 'demo'), /db handle/);
  for (const f of walk(path.join(__dirname, '..', 'lib'))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/new\s+(Pool|Client)\s*\(|connectionString|DATABASE_URL/.test(src), `${f} opens a connection`);
  }
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(p)) : [p];
  });
}

test('grep proof: no department literal in the module outside test/ and README.md', () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  for (const f of walk(root)) {
    const rel = path.relative(root, f);
    if (rel.startsWith(`test${path.sep}`) || rel === 'README.md') continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/katherine|khowe|07_marketing|marketing/i.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});
