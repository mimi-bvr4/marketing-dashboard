// ORDER #3522: store.runs() must return every agent's newest run. On
// origin/main it ran `SELECT DISTINCT ON (agent) ... LIMIT 30`, so with more
// than 30 agents in agent_runs the ones whose names sort last silently lost
// their last run on the /agents cards and in /api/review/runs.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPgStore, createMemoryStore } = require('../lib/agent-store');

const lint = () => ({ ok: true, issues: [] });

// A fake pool that does what Postgres does with DISTINCT ON (agent) ... ORDER
// BY agent, started_at DESC, and honours a LIMIT $n if the SQL carries one.
function fakePool(rows) {
  return {
    seen: [],
    async query(sql, args = []) {
      this.seen.push({ sql, args });
      if (!/FROM agent_runs/.test(sql)) return { rows: [] };
      const sorted = [...rows].sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : b.started_at - a.started_at));
      const out = [];
      for (const r of sorted) if (!out.length || out[out.length - 1].agent !== r.agent) out.push(r);
      const m = /LIMIT \$(\d+)/.exec(sql);
      return { rows: m ? out.slice(0, Number(args[Number(m[1]) - 1])) : out };
    },
  };
}

function seed(n) {
  const rows = [];
  let id = 0;
  for (let i = 0; i < n; i++) {
    const agent = `agent-${String(i).padStart(2, '0')}`;
    rows.push({ id: ++id, agent, status: 'failed', started_at: new Date(Date.UTC(2026, 10, 16, 10)), cards: 0, unavailable: [], note: 'old' });
    rows.push({ id: ++id, agent, status: 'done', started_at: new Date(Date.UTC(2026, 10, 17, 10)), cards: 2, unavailable: [], note: 'new' });
  }
  return rows;
}

test('#3522 pg runs(): 31+ agents, the one that sorts last still gets its newest run', async () => {
  const pool = fakePool(seed(35));
  const runs = await createPgStore(pool, { lint }).runs();
  assert.strictEqual(runs.length, 35, 'every agent comes back, none cut by a fixed LIMIT');
  const last = runs.find((r) => r.agent === 'agent-34');
  assert.ok(last, 'agent-34 (sorts last) still has a last run');
  assert.strictEqual(last.note, 'new');
  assert.strictEqual(last.status, 'done');
  assert.ok(runs.every((r) => r.note === 'new'), 'each row is that agent\'s newest run');
});

test('#3522 pg runs(): same row shape (whole agent_runs row, DISTINCT ON agent)', async () => {
  const pool = fakePool(seed(3));
  const runs = await createPgStore(pool, { lint }).runs();
  assert.match(pool.seen[0].sql, /SELECT DISTINCT ON \(agent\) \* FROM agent_runs ORDER BY agent, started_at DESC/);
  assert.deepStrictEqual(Object.keys(runs[0]).sort(), ['agent', 'cards', 'id', 'note', 'started_at', 'status', 'unavailable']);
});

test('#3522 memory runs(): agrees with the pg store past 30 agents', async () => {
  const s = createMemoryStore({ lint });
  for (let i = 0; i < 35; i++) await s.startRun(`agent-${String(i).padStart(2, '0')}`);
  const runs = await s.runs();
  assert.strictEqual(runs.length, 35);
});
