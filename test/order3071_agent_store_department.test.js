'use strict';
// ORDER #3071 (#2963 slice 2): lib/agent-store.js takes a department. Every read
// filters on it, every write stamps it, ensureAgentTables runs slice 1's
// migration with the config's department as the default, and with no department
// given the store behaves exactly as before for the app's own department.
//
// The real-Postgres half reads MARKETING_TEST_DATABASE_URL: the auto-merger's
// pg_guard points it at a throwaway local database. Without it those tests skip
// and the memory-store and SQL-shape tests below still prove the rule.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const S = require('../lib/agent-store');
const MKT = require('../config/department.marketing');
const { lint } = require('../lib/ai-tells');
const { SHARED_TABLES } = require('../packages/agent-platform');

const card = (over = {}) => ({ agent: 'scout', agent_name: 'Scout', job: 'j', title: 'A title', body: 'A body.', ...over });

// ---------- the memory store ----------

test('memory: with no department given, every write is stamped with the config department', async () => {
  const s = S.createMemoryStore({ lint });
  const c = await s.insert(card());
  assert.strictEqual(c.department, MKT.id);
  await s.startRun('scout');
  assert.strictEqual(s.runList[0].department, MKT.id);
  const { request } = await s.queueRun('scout', 'go', 'k@x.com');
  assert.strictEqual(request.department, MKT.id);
  const { ask } = await s.createAsk('scout', 'do a thing please', 'k@x.com');
  assert.strictEqual(ask.department, MKT.id);
  const { settings } = await s.saveSettings('scout', { skill_md: 'x', max_cards: 3, who: 'k@x.com' });
  assert.strictEqual(settings.department, MKT.id);
});

test('memory: a write cannot claim another department by passing one in the row', async () => {
  const s = S.createMemoryStore({ lint });
  const c = await s.insert(card({ department: 'demo' }));
  assert.strictEqual(c.department, MKT.id);
});

test('memory: rows of another department in the same arrays are never returned', async () => {
  const s = S.createMemoryStore({ lint });
  const mine = await s.insert(card({ title: 'mine' }));
  s.cards.push({ ...mine, id: 99, title: 'theirs', department: 'demo' });
  s.settings.push({ id: 50, agent: 'scout', version: 9, skill_md: 'theirs', enabled: true, max_cards: 3, department: 'demo' });
  s.requests.push({ id: 50, agent: 'scout', status: 'queued', department: 'demo' });
  s.asks.push({ id: 50, agent: 'scout', ask: 'theirs', status: 'new', department: 'demo' });
  s.runList.push({ id: 50, agent: 'scout', status: 'ok', department: 'demo' });
  assert.deepStrictEqual((await s.list()).map((c) => c.title), ['mine']);
  assert.strictEqual(await s.get(99), null);
  assert.strictEqual(await s.currentSettings('scout'), null);
  assert.deepStrictEqual(await s.allCurrentSettings(), []);
  assert.deepStrictEqual(await s.listAsks(), []);
  assert.deepStrictEqual(await s.takeNewAsks(), []);
  assert.deepStrictEqual(await s.takeRunRequests(), []);
  assert.deepStrictEqual(await s.runs(), []);
  assert.strictEqual(await s.draftsWaiting(), 1);
  // A store for the other department sees only its own.
  const d = S.createMemoryStore({ lint, department: 'demo' });
  d.cards.push(...s.cards);
  assert.deepStrictEqual((await d.list()).map((c) => c.title), ['theirs']);
});

test('department ids go through slice 1\'s plain-id check', async () => {
  for (const bad of ["x'; DROP TABLE agent_cards; --", 'Demo', 'a', 'has space']) {
    assert.throws(() => S.createMemoryStore({ lint, department: bad }), /department/);
    assert.throws(() => S.createPgStore({ query: async () => ({ rows: [] }) }, { lint, department: bad }), /department/);
    await assert.rejects(() => S.ensureAgentTables({ query: async () => ({ rows: [] }) }, { department: bad }), /department/);
  }
  // A department config object is taken by its id.
  assert.strictEqual(S.departmentOf(MKT), MKT.id);
  assert.strictEqual(S.departmentOf(), MKT.id);
  assert.strictEqual(S.departmentOf('demo'), 'demo');
});

// ---------- the pg store's SQL, with a recording pool ----------

function recorder() {
  const seen = [];
  const pool = { query: async (sql, args) => { seen.push({ sql, args: args || [] }); return { rows: [{ n: 0, id: 1, version: 1, agent: 'scout', site: 's', profile_version: 1 }], rowCount: 1 }; } };
  return { seen, pool };
}
const SHARED_RE = new RegExp(`\\b(${SHARED_TABLES.join('|')})\\b`);

test('pg: every statement on a shared table names the department and carries its id', async () => {
  const { seen, pool } = recorder();
  const s = S.createPgStore(pool, { lint, department: 'demo' });
  const who = 'k@x.com';
  const calls = [
    () => s.list(), () => s.list({ status: 'ready', agent: 'scout' }), () => s.get(1), () => s.insert(card()),
    () => s.seenCards('scout', ['k']), () => s.seenList('scout'), () => s.readyForHandoff(), () => s.setHandoff(1, {}),
    () => s.claimHandoff(1, {}), () => s.finishHandoff(1, null), () => s.lastRejections('scout'),
    () => s.currentSettings('scout'), () => s.allCurrentSettings(), () => s.settingsHistory('scout'),
    () => s.saveSettings('scout', { skill_md: 'x', max_cards: 3, who }), () => s.revertSettings('scout', 1, who),
    () => s.takeRunRequests(), () => s.finishRunRequest(1, true), () => s.runRequests(),
    () => s.chainKeys('c', ['k']), () => s.chainMark('c', 'k'), () => s.bobCardForPost('s', 'x'), () => s.weekStats(),
    () => s.createAsk('scout', 'do a thing please', who), () => s.listAsks('scout'), () => s.getAsk(1), () => s.takeNewAsks(),
    () => s.updateAsk(1, { status: 'applied' }), () => s.profiles(), () => s.profile('scout'), () => s.setName('scout', 'Sam', who),
    () => s.portrait('scout'), () => s.profileLog('scout'), () => s.watchlist('scout'), () => s.removeWatch('scout', 1),
    () => s.snapshots('scout', 's'), () => s.saveSnapshots('scout', 's', [{ path: '/', hash: 'h', text: 't' }], ['/x']),
    () => s.startRun('scout'), () => s.finishRun(1, { status: 'ok' }), () => s.runs(), () => s.runHistory(),
    () => s.draftsWaiting(), () => s.draftAges(), () => s.producerWeekCards('2026-11-02'),
    () => s.producerLog({ ymd: '2026-11-06', week_start: '2026-11-02', agent: 'scout', decision: 'ran' }),
    () => s.producerDay('2026-11-06'), () => s.calendarRows(), () => s.setCalendarDays('scout', ['mon'], who),
  ];
  for (const c of calls) await c();
  const shared = seen.filter((q) => SHARED_RE.test(q.sql));
  assert.ok(shared.length >= calls.length, `recorded ${shared.length} statements`);
  const bare = shared.filter((q) => !/\bdepartment\b/.test(q.sql) || !q.args.includes('demo'));
  assert.deepStrictEqual(bare.map((q) => q.sql.replace(/\s+/g, ' ').slice(0, 120)), []);
});

test('pg: with no department given the store and the migration use the config department', async () => {
  const { seen, pool } = recorder();
  const s = S.createPgStore(pool, { lint });
  await s.list(); await s.insert(card());
  assert.ok(seen.every((q) => q.args.includes(MKT.id)));
  const m = recorder();
  await S.ensureAgentTables(m.pool);
  const alters = m.seen.filter((q) => /ADD COLUMN IF NOT EXISTS department/.test(q.sql));
  assert.strictEqual(alters.length, SHARED_TABLES.length);
  assert.ok(alters.every((q) => q.sql.endsWith(`DEFAULT '${MKT.id}'`)));
  // The migration runs after the tables exist and before the old Listings fold-in.
  const firstAlter = m.seen.findIndex((q) => /ADD COLUMN IF NOT EXISTS department/.test(q.sql));
  const lastCreate = m.seen.map((q) => /^\s*CREATE TABLE/.test(q.sql)).lastIndexOf(true);
  const firstFold = m.seen.findIndex((q) => /SET agent = 'citations'/.test(q.sql));
  assert.ok(lastCreate < firstAlter && firstAlter < firstFold);
});

test('no department literal in lib/agent-store.js (it comes from config)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-store.js'), 'utf8');
  const hits = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /'marketing'|"marketing"|`marketing`/i.test(l));
  assert.deepStrictEqual(hits, []);
});

// ---------- real Postgres (throwaway only) ----------

const URL_ = process.env.MARKETING_TEST_DATABASE_URL;
const pgTest = URL_ ? test : test.skip;

function localOnly(u) {
  const h = new URL(u).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(h)) throw new Error(`refusing non-local test database ${h}`);
}

pgTest('pg (c): ensureAgentTables twice is idempotent and leaves rows written before it on the config department', async () => {
  localOnly(URL_);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_ });
  try {
    for (const t of [...SHARED_TABLES, 'competitors', 'competitor_profile_versions']) await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    // Today's schema, before the department column existed.
    for (const q of S.SCHEMA_SQL) await pool.query(q);
    await pool.query("INSERT INTO agent_cards (agent, agent_name, job, title, body) VALUES ('scout','Scout','j','old card','b')");
    await pool.query("INSERT INTO agent_settings (agent, version, skill_md, edited_by) VALUES ('scout', 1, 'x', 'k')");
    await S.ensureAgentTables(pool);
    await S.ensureAgentTables(pool);
    const rows = (await pool.query('SELECT title, department FROM agent_cards')).rows;
    assert.deepStrictEqual(rows, [{ title: 'old card', department: MKT.id }]);
    assert.strictEqual((await pool.query('SELECT department FROM agent_settings')).rows[0].department, MKT.id);
    // Every shared table this store creates gains the column. reviewer_visits is
    // created by lib/reviewer-watch.js, not here, so ALTER TABLE IF EXISTS skips it.
    const mineTables = SHARED_TABLES.filter((t) => S.SCHEMA_SQL.some((q) => q.includes(`CREATE TABLE IF NOT EXISTS ${t} `)));
    assert.deepStrictEqual(SHARED_TABLES.filter((t) => !mineTables.includes(t)), ['reviewer_visits']);
    const cols = (await pool.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'department'
      AND table_name = ANY($1)`, [SHARED_TABLES])).rows.map((r) => r.table_name).sort();
    assert.deepStrictEqual(cols, [...mineTables].sort());
    const s = S.createPgStore(pool, { lint });
    assert.deepStrictEqual((await s.list()).map((c) => c.title), ['old card'], 'Marketing reads its old rows as before');
  } finally { await pool.end(); }
});

pgTest('pg (a)+(b): two departments in the same tables; a read never crosses; a write with none given stamps the config department', async () => {
  localOnly(URL_);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_ });
  try {
    await S.ensureAgentTables(pool);
    await pool.query('TRUNCATE agent_cards, agent_settings, agent_asks, agent_run_requests, agent_runs, agent_watchlist, producer_log');
    const mkt = S.createPgStore(pool, { lint });
    const demo = S.createPgStore(pool, { lint, department: 'demo' });
    const who = 'k@x.com';
    const a = await mkt.insert(card({ title: 'mkt card' }));
    const b = await demo.insert(card({ title: 'demo card' }));
    assert.strictEqual(a.department, MKT.id);
    assert.strictEqual(b.department, 'demo');
    assert.deepStrictEqual((await mkt.list()).map((c) => c.title), ['mkt card']);
    assert.deepStrictEqual((await demo.list()).map((c) => c.title), ['demo card']);
    assert.strictEqual(await mkt.get(b.id), null);
    assert.strictEqual((await mkt.decide(b.id, { action: 'reject', who, reason: 'no' })).status, 404);
    assert.strictEqual(await mkt.draftsWaiting(), 1);

    await mkt.saveSettings('scout', { skill_md: 'mkt words', max_cards: 3, who });
    await demo.saveSettings('scout', { skill_md: 'demo words', max_cards: 3, who });
    assert.strictEqual((await mkt.currentSettings('scout')).skill_md, 'mkt words');
    assert.strictEqual((await demo.currentSettings('scout')).skill_md, 'demo words');
    assert.deepStrictEqual((await mkt.allCurrentSettings()).map((r) => r.skill_md), ['mkt words']);

    await mkt.queueRun('scout', 'go', who);
    assert.ok(!(await demo.queueRun('scout', 'go', who)).error, 'a Marketing run waiting never blocks another department');
    const taken = await mkt.takeRunRequests(10);
    assert.deepStrictEqual(taken.map((r) => r.department), [MKT.id]);

    await mkt.createAsk('scout', 'mkt ask here', who);
    await demo.createAsk('scout', 'demo ask here', who);
    assert.deepStrictEqual((await mkt.listAsks()).map((r) => r.ask), ['mkt ask here']);

    const rid = await demo.startRun('scout');
    await demo.finishRun(rid, { status: 'ok' });
    assert.deepStrictEqual(await mkt.runs(), []);

    await mkt.addWatch('scout', 'example.com', null, who);
    assert.deepStrictEqual(await demo.watchlist('scout'), []);

    const stamped = (await pool.query('SELECT DISTINCT department FROM agent_cards UNION SELECT department FROM agent_runs ORDER BY 1')).rows.map((r) => r.department);
    assert.deepStrictEqual(stamped, ['demo', MKT.id].sort());
  } finally { await pool.end(); }
});
