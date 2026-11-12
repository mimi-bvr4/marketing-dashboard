#!/usr/bin/env node
// ORDER #3243: re-run every live "Waiting on" check (lib/agent-checks.js) and
// write one row per check to agent_checks. Run at the start of the daily agents
// run (jobs/agents_daily.sh) and on every 15-minute job (jobs/agents_handoff.sh),
// so no check is ever more than about 15 minutes old while the Box is up.
//
// Read-only: env reads, `security find-generic-password` exit codes (never -w),
// a Search Console site list, and Gmail message ids. No value of any secret is
// printed or stored; only ok / not ok, a reason and a time.
//
// ALERTS ship OFF (FEATURE FLAG: AGENT_CHECK_ALERTS default OFF). On, a check that
// fails twice in a row asks the Box driver for ONE text (one line in
// escalation_request.txt, which the driver rate-limits); it never asks again
// until the check passes and fails twice more. Off, the alert that WOULD be due
// is printed and recorded (alerted_at), so the card still shows the failure.
'use strict';

const path = require('path');
const fs = require('fs');
const { listAgents, loadAgent } = require('../lib/agent-runner');
const C = require('../lib/agent-checks');

const ESCALATION = path.join(process.env.HOME || '', 'Full_IH_Project', '05_AI_and_Brain', 'box_driver_state', 'escalation_request.txt');
const alertsOn = (env) => /^(1|on|true|yes)$/i.test(String(env.AGENT_CHECK_ALERTS || '').trim());

async function runChecks(store, { ctx, now = () => new Date(), env = process.env, log = console.log, requestAlert } = {}) {
  const defs = listAgents().map((s) => [s, loadAgent(s)]);
  const checks = C.fleetChecks(defs);
  const prev = new Map((await store.checkRows()).map((r) => [r.id, r]));
  const out = [];
  for (const c of checks) {
    const res = await C.runCheck(c, ctx);
    const at = now().toISOString();
    const st = C.nextState(prev.get(c.id), res, at);
    await store.saveCheck({ id: c.id, label: c.label, agents: c.agents, ok: st.ok, reason: st.reason, checked_at: at, fail_count: st.fail_count, alerted_at: st.alerted_at });
    log(`${st.ok ? 'PASS' : 'FAIL'} ${c.id} [${c.agents.join(', ')}]: ${st.reason}`);
    if (st.alert_due) {
      const line = `agent-check-${c.id.replace(/[^a-z0-9]+/gi, '-')}|marketing agents ${c.agents.join(', ')} wait on: ${st.reason} (ORDER #3243)`;
      if (alertsOn(env) && requestAlert) { requestAlert(line); log(`ALERT REQUESTED ONCE: ${line}`); }
      else log(`ALERT DUE ONCE (AGENT_CHECK_ALERTS is off, not sent): ${line}`);
    }
    out.push({ ...c, ...st });
  }
  return out;
}

if (require.main === module) {
  const { Pool } = require('pg');
  if (!process.env.MARKETING_DATABASE_URL) { console.log('NOT RUN: MARKETING_DATABASE_URL is not set'); process.exit(3); }
  const pool = new Pool({ connectionString: process.env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { SCHEMA_SQL, createPgStore } = require('../lib/agent-store');
  const ddl = SCHEMA_SQL.find((q) => /CREATE TABLE IF NOT EXISTS agent_checks/.test(q));
  const store = createPgStore(pool, { lint: () => ({}) });
  const requestAlert = (line) => fs.appendFileSync(ESCALATION, `${line.replace(/\n/g, ' ')}\n`);
  pool.query(ddl)
    .then(() => runChecks(store, { ctx: C.liveContext(process.env), requestAlert }))
    .then((rows) => { console.log(`agent_checks: ${rows.filter((r) => r.ok).length} pass, ${rows.filter((r) => !r.ok).length} fail`); return pool.end(); })
    .then(() => process.exit(0)).catch((e) => { console.error('agent_checks:', e.message); process.exit(1); });
}

module.exports = { runChecks, alertsOn, ESCALATION };
