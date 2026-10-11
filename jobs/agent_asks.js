#!/usr/bin/env node
// ORDER #1658: sort Katherine's ability asks (lib/agent-asks.js), every 15
// minutes from jobs/agents_handoff.sh. Also marks a "Being built" ask built
// once its ORDER has a REPLY that says DONE.
'use strict';

const path = require('path');
const { treeRoot } = require('../lib/agent-sources');
const { loadAgent, listAgents } = require('../lib/agent-runner');
const { triageAsk, fileBuildOrder, isBuilt } = require('../lib/agent-asks');

async function sortAsks({ store, llm, inbox, now = () => new Date(), log = console.log }) {
  if (!llm) { log('asks: no model key, nothing sorted'); return 0; }
  const asks = await store.takeNewAsks(5);
  for (const a of asks) {
    try {
      if (!listAgents().includes(a.agent)) throw new Error(`no agent ${a.agent}`);
      const def = loadAgent(a.agent);
      const t = await triageAsk({ ask: a, def, current: await store.currentSettings(a.agent), llm });
      if (t.kind === 'instructions') {
        await store.updateAsk(a.id, { kind: t.kind, triage: t, status: 'awaiting_exec' });
      } else if (t.kind === 'build') {
        if (!inbox) throw new Error('project tree not found, so the build order could not be filed');
        const o = fileBuildOrder({ inbox, ask: a, def, triage: t, now: now() });
        await store.updateAsk(a.id, { kind: t.kind, triage: t, status: 'building', order_file: o.file });
      } else {
        await store.updateAsk(a.id, { kind: t.kind, triage: t, status: 'cant' });
      }
      log(`ask ${a.id} (${a.agent}): ${t.kind}${t.overruled ? ' (fence overruled the model)' : ''}`);
    } catch (e) {
      await store.updateAsk(a.id, { status: 'failed', note: e.message.slice(0, 400) });
      log(`ask ${a.id}: FAILED ${e.message}`);
    }
  }
  if (inbox) {
    for (const a of (await store.listAsks()).filter((x) => x.status === 'building' && x.order_file)) {
      if (isBuilt(inbox, a.order_file)) { await store.updateAsk(a.id, { status: 'built' }); log(`ask ${a.id}: built`); }
    }
  }
  return asks.length;
}

async function main({ env = process.env, log = console.log } = {}) {
  if (!env.MARKETING_DATABASE_URL) { log('NOT RUN: MARKETING_DATABASE_URL is not set'); return 3; }
  const { Pool } = require('pg');
  const { createPgStore, ensureAgentTables } = require('../lib/agent-store');
  const { textClientFromEnv } = require('../lib/agent-llm');
  const { lint } = require('../lib/ai-tells');
  const pool = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await ensureAgentTables(pool);
    const root = treeRoot(env);
    await sortAsks({ store: createPgStore(pool, { lint }), llm: textClientFromEnv().client, log,
      inbox: root ? path.join(root, '05_AI_and_Brain', 'BRAIN_INBOX') : null });
    return 0;
  } finally { await pool.end(); }
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('agent_asks:', e.message); process.exit(1); });

module.exports = { sortAsks };
