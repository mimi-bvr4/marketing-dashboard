#!/usr/bin/env node
// ORDER #1658: "Run now" from the Agents page. Every 15 minutes the Box takes
// queued requests (FOR UPDATE SKIP LOCKED, so two runs never take the same
// one), runs the agent with the person's request, and marks it done/failed.
// Then it mirrors every agent's current instructions into the project tree
// (07_Marketing_and_Brand/Agents/), so the Box and every Claude session read
// the same words Katherine saved.
'use strict';

const fs = require('fs');
const path = require('path');
const { treeRoot } = require('../lib/agent-sources');
const { listAgents, loadAgent } = require('../lib/agent-runner');

async function takeAndRun({ store, runOne, log = console.log }) {
  const reqs = await store.takeRunRequests(5);
  for (const q of reqs) {
    let r;
    try { r = await runOne(q.agent, q.ask); } catch (e) { r = { ok: false, error: e.message, cards: [] }; }
    const ids = (r.cards || []).map((c) => `#${c.id}`).join(', ');
    await store.finishRunRequest(q.id, r.ok, r.ok ? `card(s) ${ids || 'none'}` : r.error);
    log(`request ${q.id} (${q.agent}, by ${q.requested_by}): ${r.ok ? 'done' : 'FAILED ' + r.error}`);
  }
  return reqs.length;
}

function mirrorText(def, s) {
  const head = s
    ? `<!-- MIRROR of the Agents page. Version ${s.version}, saved by ${s.edited_by}${s.note ? ` (${s.note})` : ''}. ${s.enabled ? 'ON' : 'PAUSED'}, ${s.max_cards} draft(s) per run. Edit on marketing /agents, not here: this file is rewritten every 15 minutes. -->`
    : `<!-- MIRROR of the Agents page. Default instructions (never edited). Edit on marketing /agents, not here: this file is rewritten every 15 minutes. -->`;
  return `${head}\n${s ? s.skill_md : def.skill}`;
}

async function mirror({ store, root, log = console.log }) {
  const dir = path.join(root, '07_Marketing_and_Brand', 'Agents');
  fs.mkdirSync(dir, { recursive: true });
  const current = new Map((await store.allCurrentSettings()).map((s) => [s.agent, s]));
  let wrote = 0;
  for (const slug of listAgents()) {
    const text = mirrorText(loadAgent(slug), current.get(slug));
    const f = path.join(dir, `${slug}.SKILL.md`);
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === text) continue;   // unchanged: no Syncthing churn
    fs.writeFileSync(f, text);
    wrote++;
  }
  log(`mirror: ${wrote} agent file(s) updated in 07_Marketing_and_Brand/Agents`);
  return wrote;
}

async function main({ env = process.env, log = console.log } = {}) {
  if (!env.MARKETING_DATABASE_URL) { log('NOT RUN: MARKETING_DATABASE_URL is not set'); return 3; }
  const { Pool } = require('pg');
  const { createPgStore, ensureAgentTables } = require('../lib/agent-store');
  const { runAgent } = require('../lib/agent-runner');
  const { textClientFromEnv } = require('../lib/agent-llm');
  const { lint } = require('../lib/ai-tells');
  const pool = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await ensureAgentTables(pool);
    const store = createPgStore(pool, { lint });
    const llm = textClientFromEnv().client;
    await takeAndRun({ store, log, runOne: (slug, ask) => runAgent({ slug, store, llm, ask, env, log }) });
    const root = treeRoot(env);
    if (root) await mirror({ store, root, log }); else log('mirror skipped: project tree not found');
    return 0;
  } finally { await pool.end(); }
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('agent_requests:', e.message); process.exit(1); });

module.exports = { takeAndRun, mirror, mirrorText };
