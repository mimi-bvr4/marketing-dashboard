#!/usr/bin/env node
// ORDER #1658 (10.11.2026 live-run fix): recompute the AI-tells check on cards
// still waiting in Review, reading only each bot's own words (not the measured
// tables, not quoted text). Changes the check fields only; never a draft's text.
'use strict';

const { lint, summary } = require('../lib/ai-tells');
const { modelText } = require('../lib/agent-runner');

async function relint(pool, log = console.log) {
  const rows = (await pool.query("SELECT id, title, body, payload, checks FROM agent_cards WHERE status = 'draft'")).rows;
  for (const c of rows) {
    const post = c.payload && c.payload.post;
    const t = lint((c.title || '') + '\n' + modelText(c.body) + (post ? '\n' + post.content_md : ''));
    const checks = { ...(c.checks || {}), ai_tells: t, ai_tells_summary: summary(t) };
    await pool.query('UPDATE agent_cards SET checks = $2 WHERE id = $1', [c.id, JSON.stringify(checks)]);
    log(`card ${c.id}: ${summary(t)}`);
  }
  return rows.length;
}

if (require.main === module) {
  const { Pool } = require('pg');
  if (!process.env.MARKETING_DATABASE_URL) { console.log('NOT RUN: MARKETING_DATABASE_URL is not set'); process.exit(3); }
  const pool = new Pool({ connectionString: process.env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  relint(pool).then((n) => { console.log(`relint: ${n} waiting card(s) re-checked`); return pool.end(); })
    .then(() => process.exit(0)).catch((e) => { console.error('agent_relint:', e.message); process.exit(1); });
}

module.exports = { relint };
