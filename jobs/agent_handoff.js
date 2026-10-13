#!/usr/bin/env node
// ORDER #1658: hand APPROVED cards that carry a post (Bloggy Bob) to WordPress
// as UNPUBLISHED drafts. Every 15 minutes on the Box (agents_handoff.sh).
//
// A card is handed off at most once: success, a skip (not a WordPress site)
// and an ALARM are recorded on the card and never retried. A refusal that can
// clear (no Keychain item yet, WordPress down) is logged and tried again on the
// next run. Never publishes: lib/wp-draft.js sends status "draft" only.
'use strict';

const { createPgStore, createMemoryStore, ensureAgentTables } = require('../lib/agent-store');
const { createDraft } = require('../lib/wp-draft');
const { createPin } = require('../lib/pinterest');
const { lint } = require('../lib/ai-tells');

async function handoff({ store, fetchImpl, login, secrets, log = console.log, now = () => new Date() }) {
  const cards = await store.readyForHandoff(20);
  let done = 0;
  for (const c of cards) {
    // #1710: an approved Pinterest Paul card is pinned live (Mimi 10.13.2026, "Post live on approve").
    if (c.payload.pin) {
      const r = await createPin({ pin: c.payload.pin, evidence: c.payload.evidence, fetchImpl, ...(secrets ? { secrets } : {}) });
      const at = now().toISOString();
      if (r.ok) { await store.setHandoff(c.id, { at, ok: true, pin_id: r.id, pin_url: r.url, board: r.board }); log(`card ${c.id}: pinned to ${r.board} ${r.url}`); done++; }
      else if (r.skip) { await store.setHandoff(c.id, { at, ok: false, why: r.why }); log(`card ${c.id}: not pinned: ${r.why}`); }
      else log(`card ${c.id}: will retry, ${r.why}`);
      continue;
    }
    const post = c.payload.post;
    const r = await createDraft({ post, fetchImpl, login });
    const at = now().toISOString();
    if (r.ok) {
      await store.setHandoff(c.id, { at, ok: true, wp_id: r.id, edit_link: r.edit_link, status: r.status, note: r.note || null });
      log(`card ${c.id}: WordPress draft ${r.id} on ${post.site} ${r.edit_link}`);
      done++;
    } else if (r.skip || r.alarm) {
      await store.setHandoff(c.id, { at, ok: false, alarm: !!r.alarm, wp_id: r.id || null, edit_link: r.edit_link || null, why: r.why });
      log(`card ${c.id}: ${r.alarm ? 'ALARM ' : 'not handed off: '}${r.why}`);
    } else {
      log(`card ${c.id}: will retry, ${r.why}`);
    }
  }
  log(`handoff: ${cards.length} ready card(s) with a post or pin, ${done} handed off`);
  return { seen: cards.length, done };
}

async function main({ env = process.env, log = console.log } = {}) {
  if (!env.MARKETING_DATABASE_URL) { log('NOT RUN: MARKETING_DATABASE_URL is not set'); return 3; }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await ensureAgentTables(pool);
    await handoff({ store: createPgStore(pool, { lint }), fetchImpl: globalThis.fetch, log });
    return 0;
  } finally { await pool.end(); }
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('agent_handoff:', e.message); process.exit(1); });

module.exports = { handoff, main, createMemoryStore };
