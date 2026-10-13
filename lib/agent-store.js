// ORDER #1015 Part 2: the Review queue's tables and store.
//
// agent_cards  one row per DRAFT an agent wrote. Approve never publishes, sends,
//              posts or spends: it moves the card to 'ready' for a human to use.
// agent_runs   one row per run, done or failed, so a dead agent is visible.
//
// Idempotent, db.js style (this Postgres is in the Box's nightly backup set).
// The memory store has the same semantics, for tests and dry runs.
'use strict';

const { checkName, checkPortrait } = require('./agent-profile');
const { checkSite, MAX_WATCH } = require('./agent-watch');

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'running', cards INTEGER NOT NULL DEFAULT 0,
    unavailable JSONB NOT NULL DEFAULT '[]', note TEXT)`,
  `CREATE TABLE IF NOT EXISTS agent_cards (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, agent_name TEXT NOT NULL, job TEXT NOT NULL,
    target TEXT, title TEXT NOT NULL, body TEXT NOT NULL, sources JSONB NOT NULL DEFAULT '[]',
    checks JSONB NOT NULL DEFAULT '{}', run_id INTEGER,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'rejected')),
    edited BOOLEAN NOT NULL DEFAULT false, reason TEXT, decided_by TEXT, decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS idx_agent_cards_status ON agent_cards(status, created_at DESC)',
  // #1658: the structured post a card carries (Bloggy Bob) and what happened
  // when it was handed to WordPress after approval.
  'ALTER TABLE agent_cards ADD COLUMN IF NOT EXISTS payload JSONB',
  'ALTER TABLE agent_cards ADD COLUMN IF NOT EXISTS handoff JSONB',
  // #1658 Agents page: Katherine's edits to a bot, every save a new version
  // (never an update), so any earlier version can be put back.
  `CREATE TABLE IF NOT EXISTS agent_settings (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, version INTEGER NOT NULL, skill_md TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true, max_cards INTEGER NOT NULL DEFAULT 3, note TEXT,
    edited_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (agent, version))`,
  // #1658 character cards: Katherine asks a bot for a new ability; the Box sorts
  // it (instructions / build / cant). An instruction change waits for an exec.
  `CREATE TABLE IF NOT EXISTS agent_asks (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, ask TEXT NOT NULL, asked_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'sorting', 'awaiting_exec', 'applied', 'declined', 'building', 'built', 'cant', 'failed')),
    kind TEXT, triage JSONB, order_file TEXT, decided_by TEXT, decided_at TIMESTAMPTZ, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS agent_run_requests (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, ask TEXT, requested_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), picked_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, note TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_agent_cards_agent ON agent_cards(agent, created_at DESC)',
  // #1664: Katherine names each agent and gives it a portrait. Cosmetic only;
  // every change is logged in agent_profile_log.
  `CREATE TABLE IF NOT EXISTS agent_profiles (
    agent TEXT PRIMARY KEY, display_name TEXT, portrait BYTEA, portrait_type TEXT, portrait_at TIMESTAMPTZ,
    updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS agent_profile_log (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, field TEXT NOT NULL, old_value TEXT, new_value TEXT,
    changed_by TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  // #1666 the Scout: the competitor sites Katherine lists, and what each page
  // said last week so this week's run can report only what changed.
  `CREATE TABLE IF NOT EXISTS agent_watchlist (
    id SERIAL PRIMARY KEY, agent TEXT NOT NULL, site TEXT NOT NULL, label TEXT, added_by TEXT NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (agent, site))`,
  `CREATE TABLE IF NOT EXISTS agent_snapshots (
    agent TEXT NOT NULL, site TEXT NOT NULL, path TEXT NOT NULL, title TEXT, hash TEXT NOT NULL, text TEXT NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (agent, site, path))`,
  // #1668 competitor profiles: one row per competitor on Katherine's sheet,
  // refreshed by the Scout; top ones carry a profile, every version kept.
  `CREATE TABLE IF NOT EXISTS competitors (
    site TEXT PRIMARY KEY, name TEXT NOT NULL, brands JSONB NOT NULL DEFAULT '[]', segments JSONB NOT NULL DEFAULT '[]',
    sheet_notes JSONB NOT NULL DEFAULT '[]', top BOOLEAN NOT NULL DEFAULT false, on_sheet BOOLEAN NOT NULL DEFAULT true,
    last_changes TEXT, changes_at TIMESTAMPTZ, profile_md TEXT, profile_version INTEGER NOT NULL DEFAULT 0, profile_at TIMESTAMPTZ,
    kh_notes TEXT, kh_notes_by TEXT, kh_notes_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS competitor_profile_versions (
    id SERIAL PRIMARY KEY, site TEXT NOT NULL, version INTEGER NOT NULL, profile_md TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (site, version))`,
];

async function ensureAgentTables(pool) {
  if (!pool) return;
  for (const q of SCHEMA_SQL) await pool.query(q);
  await mergeListingsIntoCitations(pool);
  await citationsAddAiSources(pool);
}

// ORDER #1699 (Mimi 10.13.2026): "Listing and Citations need to combine into one
// agent." The agents/listings folder is gone; Citations does both. Every row the
// Listings agent owned moves to 'citations' so its history, Katherine's asks and
// any queued "Run now" follow it. Its name and portrait carry over only when
// Citations has none. Katherine's saved instruction versions are never edited:
// if Citations' newest saved version is still the old repo default, a new version
// with the merged instructions is added on top (every save is a version, so the
// old one can be put back); if she had changed them, they stay and the reply says
// so. Idempotent: a rerun finds nothing to move and the text already current.
const OLD_CITATIONS_DEFAULT_SHA = '23ae94e7d803d25b99f5accf775cb5e314f44cea7c9aacb62bcfb77239a03091';
async function mergeListingsIntoCitations(pool) {
  for (const t of ['agent_runs', 'agent_cards', 'agent_asks', 'agent_run_requests', 'agent_profile_log']) {
    await pool.query(`UPDATE ${t} SET agent = 'citations' WHERE agent = 'listings'`);
  }
  await pool.query(`INSERT INTO agent_profiles (agent, display_name, portrait, portrait_type, portrait_at, updated_by, updated_at)
    SELECT 'citations', display_name, portrait, portrait_type, portrait_at, updated_by, now() FROM agent_profiles WHERE agent = 'listings'
    ON CONFLICT (agent) DO NOTHING`);
  await pool.query(`UPDATE agent_profiles c SET display_name = l.display_name FROM agent_profiles l
    WHERE c.agent = 'citations' AND l.agent = 'listings' AND COALESCE(c.display_name, '') = '' AND COALESCE(l.display_name, '') <> ''`);
  let merged;
  try { merged = require('fs').readFileSync(require('path').join(__dirname, '..', 'agents', 'citations', 'SKILL.md'), 'utf8'); } catch (e) { return; }
  const body = merged.replace(/^[ \n\r\t]+|[ \n\r\t]+$/g, '');
  await pool.query(`INSERT INTO agent_settings (agent, version, skill_md, enabled, max_cards, note, edited_by)
    SELECT 'citations', s.version + 1, $1, s.enabled, GREATEST(s.max_cards, 4), 'ORDER #1699: Listings folded into Citations (Mimi 10.13.2026)', 'mimi@infinityhospitality.net (via the Box)'
      FROM agent_settings s
     WHERE s.agent = 'citations' AND s.version = (SELECT max(version) FROM agent_settings WHERE agent = 'citations')
       AND encode(sha256(convert_to(btrim(s.skill_md, E' \n\r\t'), 'UTF8')), 'hex') = $2
    ON CONFLICT (agent, version) DO NOTHING`, [body, OLD_CITATIONS_DEFAULT_SHA]);
}

// ORDER #1715 (Mimi 10.13.2026, "Citation audit for AI"): the Citations
// instructions gain the "Where AI gets its answers" card. Same rule as #1699:
// only when Citations' newest saved version is still the #1699 merged default is
// a new version added on top; a version Katherine changed is left alone.
const CITATIONS_1699_DEFAULT_SHA = '4b441e1b97609516edc3de0928c248f9966afec0d8bd56472d30177a055b8608';
async function citationsAddAiSources(pool) {
  let text;
  try { text = require('fs').readFileSync(require('path').join(__dirname, '..', 'agents', 'citations', 'SKILL.md'), 'utf8'); } catch (e) { return; }
  const body = text.replace(/^[ \n\r\t]+|[ \n\r\t]+$/g, '');
  await pool.query(`INSERT INTO agent_settings (agent, version, skill_md, enabled, max_cards, note, edited_by)
    SELECT 'citations', s.version + 1, $1, s.enabled, GREATEST(s.max_cards, 5), 'ORDER #1715: the AI citation audit card (Mimi 10.13.2026)', 'mimi@infinityhospitality.net (via the Box)'
      FROM agent_settings s
     WHERE s.agent = 'citations' AND s.version = (SELECT max(version) FROM agent_settings WHERE agent = 'citations')
       AND encode(sha256(convert_to(btrim(s.skill_md, E' \n\r\t'), 'UTF8')), 'hex') = $2
    ON CONFLICT (agent, version) DO NOTHING`, [body, CITATIONS_1699_DEFAULT_SHA]);
}

const DECISIONS = new Set(['approve', 'reject', 'edit']);

// The checks on a settings save, shared by both stores.
const MAX_SKILL = 40000;
function checkSettings({ skill_md, enabled, max_cards, who }) {
  if (!who) return { error: 'no person to record' };
  if (typeof skill_md !== 'string' || !skill_md.trim()) return { error: 'the instructions cannot be empty' };
  if (skill_md.length > MAX_SKILL) return { error: `the instructions are over ${MAX_SKILL} characters` };
  const n = Number(max_cards);
  if (!Number.isInteger(n) || n < 1 || n > 10) return { error: 'drafts per run must be 1 to 10' };
  return { row: { skill_md, enabled: enabled !== false, max_cards: n } };
}

// The one rule both stores share. Returns { ok, error } or the new fields.
function decide(card, { action, who, reason, body }, lint) {
  if (!DECISIONS.has(action)) return { error: 'unknown action' };
  if (!who) return { error: 'no person to record' };
  if (action === 'reject') {
    if (!reason || !String(reason).trim()) return { error: 'a reject needs a one-line reason' };
    return { fields: { status: 'rejected', reason: String(reason).trim().slice(0, 500), decided_by: who } };
  }
  const post = card.payload && card.payload.post;
  const pin = card.payload && card.payload.pin;
  if (action === 'edit') {
    if (!body || !String(body).trim()) return { error: 'an edit needs the new text' };
    // A card that carries a post (Bloggy Bob): the edit IS the post, so the
    // WordPress draft gets what Katherine wrote, not the original.
    if (post) {
      const payload = { ...card.payload, post: { ...post, content_md: String(body) } };
      const checks = { ...(card.checks || {}), ai_tells: lint(card.body + '\n' + body) };
      return { fields: { payload, edited: true, checks, decided_by: who, status: 'draft' } };
    }
    // #1710: on a Pinterest Paul card the edit IS the pin description (what goes on Pinterest).
    if (pin) {
      const payload = { ...card.payload, pin: { ...pin, description: String(body).slice(0, 500) } };
      const checks = { ...(card.checks || {}), ai_tells: lint(card.body + '\n' + pin.title + '\n' + body) };
      return { fields: { payload, edited: true, checks, decided_by: who, status: 'draft' } };
    }
    const checks = { ...(card.checks || {}), ai_tells: lint(body) };
    return { fields: { body: String(body), edited: true, checks, decided_by: who, status: 'draft' } };
  }
  const own = require('./agent-runner').modelText(card.body);
  const tells = lint((card.title || '') + '\n' + own + (post ? '\n' + post.content_md + '\n' + (post.title || '') : '')
    + (pin ? '\n' + (pin.title || '') + '\n' + (pin.description || '') : ''));
  if (tells.fails.length) return { error: 'this draft has an em dash or spaced en dash; edit it before marking ready' };
  return { fields: { status: 'ready', decided_by: who, reason: reason ? String(reason).slice(0, 500) : null } };
}

function createPgStore(pool, { lint }) {
  return {
    async list({ status = 'draft', agent, limit = 100 } = {}) {
      const args = [status];
      let sql = 'SELECT * FROM agent_cards WHERE status = $1';
      if (agent) { args.push(agent); sql += ` AND agent = $${args.length}`; }
      args.push(Math.min(Number(limit) || 100, 200));
      sql += ` ORDER BY created_at DESC LIMIT $${args.length}`;
      return (await pool.query(sql, args)).rows;
    },
    async get(id) { return (await pool.query('SELECT * FROM agent_cards WHERE id = $1', [id])).rows[0] || null; },
    async decide(id, d) {
      const card = await this.get(id);
      if (!card) return { error: 'no such card', status: 404 };
      const r = decide(card, d, lint);
      if (r.error) return r;
      const f = r.fields;
      const cols = Object.keys(f);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const vals = cols.map((c) => (c === 'checks' || c === 'payload' ? JSON.stringify(f[c]) : f[c]));
      const row = (await pool.query(`UPDATE agent_cards SET ${sets}, decided_at = now() WHERE id = $1 RETURNING *`, [id, ...vals])).rows[0];
      return { card: row };
    },
    async insert(c) {
      return (await pool.query(`INSERT INTO agent_cards (agent, agent_name, job, target, title, body, sources, checks, run_id, payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [c.agent, c.agent_name, c.job, c.target || null, c.title, c.body, JSON.stringify(c.sources || []),
        JSON.stringify(c.checks || {}), c.run_id || null, c.payload ? JSON.stringify(c.payload) : null])).rows[0];
    },
    // Ready cards that carry a post and were never handed off. One card, one post, ever.
    async readyForHandoff(limit = 20) {
      return (await pool.query(`SELECT * FROM agent_cards WHERE status = 'ready' AND payload IS NOT NULL
        AND (payload ? 'post' OR payload ? 'pin') AND handoff IS NULL ORDER BY decided_at LIMIT $1`, [limit])).rows;
    },
    async setHandoff(id, h) {
      await pool.query('UPDATE agent_cards SET handoff = $2 WHERE id = $1 AND handoff IS NULL', [id, JSON.stringify(h)]);
    },
    async lastRejections(agent, n = 10) {
      return (await pool.query(`SELECT title, reason FROM agent_cards WHERE agent = $1 AND status = 'rejected'
        ORDER BY decided_at DESC NULLS LAST LIMIT $2`, [agent, n])).rows;
    },
    async currentSettings(agent) {
      return (await pool.query('SELECT * FROM agent_settings WHERE agent = $1 ORDER BY version DESC LIMIT 1', [agent])).rows[0] || null;
    },
    async allCurrentSettings() {
      return (await pool.query('SELECT DISTINCT ON (agent) * FROM agent_settings ORDER BY agent, version DESC')).rows;
    },
    async settingsHistory(agent, limit = 50) {
      return (await pool.query('SELECT * FROM agent_settings WHERE agent = $1 ORDER BY version DESC LIMIT $2', [agent, limit])).rows;
    },
    async saveSettings(agent, input) {
      const c = checkSettings(input);
      if (c.error) return c;
      const r = c.row;
      const row = (await pool.query(`INSERT INTO agent_settings (agent, version, skill_md, enabled, max_cards, note, edited_by)
        VALUES ($1, COALESCE((SELECT MAX(version) FROM agent_settings WHERE agent = $1), 0) + 1, $2, $3, $4, $5, $6) RETURNING *`,
      [agent, r.skill_md, r.enabled, r.max_cards, input.note ? String(input.note).slice(0, 300) : null, input.who])).rows[0];
      return { settings: row };
    },
    async revertSettings(agent, version, who) {
      const old = (await pool.query('SELECT * FROM agent_settings WHERE agent = $1 AND version = $2', [agent, version])).rows[0];
      if (!old) return { error: 'no such version', status: 404 };
      return this.saveSettings(agent, { skill_md: old.skill_md, enabled: old.enabled, max_cards: old.max_cards,
        note: `put back version ${version}`, who });
    },
    async queueRun(agent, ask, who) {
      if (!who) return { error: 'no person to record' };
      const open = (await pool.query("SELECT id FROM agent_run_requests WHERE agent = $1 AND status IN ('queued','running')", [agent])).rows[0];
      if (open) return { error: 'this agent already has a run waiting', status: 409 };
      return { request: (await pool.query('INSERT INTO agent_run_requests (agent, ask, requested_by) VALUES ($1,$2,$3) RETURNING *',
        [agent, ask ? String(ask).slice(0, 4000) : null, who])).rows[0] };
    },
    async takeRunRequests(limit = 5) {
      return (await pool.query(`UPDATE agent_run_requests SET status = 'running', picked_at = now()
        WHERE id IN (SELECT id FROM agent_run_requests WHERE status = 'queued' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [limit])).rows;
    },
    async finishRunRequest(id, ok, note) {
      await pool.query('UPDATE agent_run_requests SET status = $2, finished_at = now(), note = $3 WHERE id = $1', [id, ok ? 'done' : 'failed', note || null]);
    },
    async runRequests(limit = 20) {
      return (await pool.query('SELECT * FROM agent_run_requests ORDER BY created_at DESC LIMIT $1', [limit])).rows;
    },
    // #1658 Monday digest: the last 7 days, per agent.
    async weekStats() {
      const cards = (await pool.query(`SELECT agent, status, count(*)::int AS n FROM agent_cards
        WHERE created_at > now() - interval '7 days' AND agent <> 'digest' GROUP BY agent, status`)).rows;
      const runs = (await pool.query(`SELECT agent, status, unavailable FROM agent_runs
        WHERE started_at > now() - interval '7 days' AND agent <> 'digest'`)).rows;
      return { cards, runs };
    },
    async createAsk(agent, ask, who) {
      if (!who) return { error: 'no person to record' };
      const t = String(ask || '').trim();
      if (t.length < 5) return { error: 'say what you want it to do' };
      if (t.length > 2000) return { error: 'keep the ask under 2000 characters' };
      return { ask: (await pool.query('INSERT INTO agent_asks (agent, ask, asked_by) VALUES ($1,$2,$3) RETURNING *', [agent, t, who])).rows[0] };
    },
    async listAsks(agent) {
      return (await pool.query('SELECT * FROM agent_asks WHERE ($1::text IS NULL OR agent = $1) ORDER BY created_at DESC LIMIT 200', [agent || null])).rows;
    },
    async getAsk(id) { return (await pool.query('SELECT * FROM agent_asks WHERE id = $1', [id])).rows[0] || null; },
    async takeNewAsks(limit = 5) {
      return (await pool.query(`UPDATE agent_asks SET status = 'sorting' WHERE id IN (SELECT id FROM agent_asks WHERE status = 'new'
        ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`, [limit])).rows;
    },
    async updateAsk(id, f) {
      const cols = Object.keys(f);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const vals = cols.map((c) => (c === 'triage' ? JSON.stringify(f[c]) : f[c]));
      return (await pool.query(`UPDATE agent_asks SET ${sets} WHERE id = $1 RETURNING *`, [id, ...vals])).rows[0];
    },
    // #1664 names and portraits. profiles() never returns the picture bytes.
    async profiles() {
      return (await pool.query(`SELECT agent, display_name, portrait_type, portrait_at, updated_by, updated_at
        FROM agent_profiles`)).rows;
    },
    async profile(agent) {
      return (await pool.query(`SELECT agent, display_name, portrait_type, portrait_at, updated_by, updated_at
        FROM agent_profiles WHERE agent = $1`, [agent])).rows[0] || null;
    },
    async setName(agent, raw, who) {
      if (!who) return { error: 'no person to record' };
      const c = checkName(raw);
      if (c.error) return c;
      const old = await this.profile(agent);
      const row = (await pool.query(`INSERT INTO agent_profiles (agent, display_name, updated_by) VALUES ($1, $2, $3)
        ON CONFLICT (agent) DO UPDATE SET display_name = EXCLUDED.display_name, updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING agent, display_name, portrait_type, portrait_at, updated_by, updated_at`, [agent, c.name, who])).rows[0];
      await pool.query('INSERT INTO agent_profile_log (agent, field, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)',
        [agent, 'name', old ? old.display_name : null, c.name, who]);
      return { profile: row };
    },
    async setPortrait(agent, buf, who) {
      if (!who) return { error: 'no person to record' };
      let type = null;
      if (buf !== null) { const c = checkPortrait(buf); if (c.error) return c; type = c.type; }
      const row = (await pool.query(`INSERT INTO agent_profiles (agent, portrait, portrait_type, portrait_at, updated_by)
        VALUES ($1, $2::bytea, $3, CASE WHEN $2::bytea IS NULL THEN NULL ELSE now() END, $4)
        ON CONFLICT (agent) DO UPDATE SET portrait = EXCLUDED.portrait, portrait_type = EXCLUDED.portrait_type,
          portrait_at = EXCLUDED.portrait_at, updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING agent, display_name, portrait_type, portrait_at, updated_by, updated_at`, [agent, buf, type, who])).rows[0];
      await pool.query('INSERT INTO agent_profile_log (agent, field, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)',
        [agent, 'portrait', null, buf ? `${type}, ${buf.length} bytes` : 'removed', who]);
      return { profile: row };
    },
    async portrait(agent) {
      return (await pool.query('SELECT portrait, portrait_type, portrait_at FROM agent_profiles WHERE agent = $1 AND portrait IS NOT NULL', [agent])).rows[0] || null;
    },
    async profileLog(agent, limit = 30) {
      return (await pool.query('SELECT field, old_value, new_value, changed_by, changed_at FROM agent_profile_log WHERE agent = $1 ORDER BY id DESC LIMIT $2', [agent, limit])).rows;
    },
    // #1666 the Scout's watch list and last-seen pages.
    async watchlist(agent) {
      return (await pool.query('SELECT id, site, label, added_by, added_at FROM agent_watchlist WHERE agent = $1 ORDER BY site', [agent])).rows;
    },
    async addWatch(agent, raw, label, who) {
      if (!who) return { error: 'no person to record' };
      const c = checkSite(raw);
      if (c.error) return c;
      const n = (await pool.query('SELECT count(*)::int AS n FROM agent_watchlist WHERE agent = $1', [agent])).rows[0].n;
      if (n >= MAX_WATCH) return { error: `the list is full (${MAX_WATCH} sites); remove one first` };
      const row = (await pool.query(`INSERT INTO agent_watchlist (agent, site, label, added_by) VALUES ($1, $2, $3, $4)
        ON CONFLICT (agent, site) DO NOTHING RETURNING id, site, label, added_by, added_at`,
      [agent, c.site, label ? String(label).trim().slice(0, 80) || null : null, who])).rows[0];
      if (!row) return { error: `${c.site} is already on the list`, status: 409 };
      return { watch: row };
    },
    async removeWatch(agent, id) {
      const r = (await pool.query('DELETE FROM agent_watchlist WHERE agent = $1 AND id = $2 RETURNING site', [agent, id])).rows[0];
      if (!r) return { error: 'not on the list', status: 404 };
      await pool.query('DELETE FROM agent_snapshots WHERE agent = $1 AND site = $2', [agent, r.site]);
      return { removed: r.site };
    },
    async snapshots(agent, site) {
      return (await pool.query('SELECT path, title, hash, text, seen_at FROM agent_snapshots WHERE agent = $1 AND site = $2', [agent, site])).rows;
    },
    async saveSnapshots(agent, site, pages, gone) {
      for (const p of pages) {
        await pool.query(`INSERT INTO agent_snapshots (agent, site, path, title, hash, text) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (agent, site, path) DO UPDATE SET title = EXCLUDED.title, hash = EXCLUDED.hash, text = EXCLUDED.text, seen_at = now()`,
        [agent, site, p.path, p.title || null, p.hash, p.text]);
      }
      if (gone && gone.length) await pool.query('DELETE FROM agent_snapshots WHERE agent = $1 AND site = $2 AND path = ANY($3)', [agent, site, gone]);
    },
    // #1668 competitors and their profiles.
    async syncCompetitors(list) {
      for (const c of list) {
        await pool.query(`INSERT INTO competitors (site, name, brands, segments, sheet_notes, top, on_sheet) VALUES ($1,$2,$3,$4,$5,$6,true)
          ON CONFLICT (site) DO UPDATE SET name = EXCLUDED.name, brands = EXCLUDED.brands, segments = EXCLUDED.segments,
            sheet_notes = EXCLUDED.sheet_notes, top = EXCLUDED.top, on_sheet = true, updated_at = now()`,
        [c.site, c.name, JSON.stringify(c.brands), JSON.stringify(c.segments || []), JSON.stringify(c.notes || []), !!c.top]);
      }
      await pool.query('UPDATE competitors SET on_sheet = false, top = false WHERE NOT (site = ANY($1))', [list.map((c) => c.site)]);
    },
    async competitors() {
      return (await pool.query('SELECT * FROM competitors WHERE on_sheet ORDER BY top DESC, jsonb_array_length(brands) DESC, name')).rows;
    },
    async competitor(site) { return (await pool.query('SELECT * FROM competitors WHERE site = $1', [site])).rows[0] || null; },
    async setCompetitorChanges(site, text) {
      await pool.query('UPDATE competitors SET last_changes = $2, changes_at = now() WHERE site = $1', [site, text]);
    },
    async saveProfile(site, md) {
      const row = (await pool.query(`UPDATE competitors SET profile_md = $2, profile_version = profile_version + 1, profile_at = now()
        WHERE site = $1 RETURNING profile_version`, [site, md])).rows[0];
      if (!row) return { error: 'no such competitor', status: 404 };
      await pool.query('INSERT INTO competitor_profile_versions (site, version, profile_md) VALUES ($1,$2,$3)', [site, row.profile_version, md]);
      return { version: row.profile_version };
    },
    // #1702: take a profile off the page (its versions stay in the table).
    async withdrawProfile(site) {
      await pool.query('UPDATE competitors SET profile_md = NULL WHERE site = $1', [site]);
    },
    async profileVersions(site, limit = 20) {
      return (await pool.query('SELECT version, profile_md, created_at FROM competitor_profile_versions WHERE site = $1 ORDER BY version DESC LIMIT $2', [site, limit])).rows;
    },
    async setKhNotes(site, notes, who) {
      if (!who) return { error: 'no person to record' };
      const t = String(notes == null ? '' : notes).trim();
      if (t.length > 4000) return { error: 'keep notes under 4000 characters' };
      const row = (await pool.query(`UPDATE competitors SET kh_notes = $2, kh_notes_by = $3, kh_notes_at = now() WHERE site = $1
        RETURNING site, kh_notes, kh_notes_by, kh_notes_at`, [site, t || null, who])).rows[0];
      return row ? { competitor: row } : { error: 'no such competitor', status: 404 };
    },
    async startRun(agent) { return (await pool.query('INSERT INTO agent_runs (agent) VALUES ($1) RETURNING id', [agent])).rows[0].id; },
    async finishRun(id, { status, cards, unavailable, note }) {
      await pool.query(`UPDATE agent_runs SET finished_at = now(), status = $2, cards = $3, unavailable = $4, note = $5 WHERE id = $1`,
        [id, status, cards || 0, JSON.stringify(unavailable || []), note || null]);
    },
    async runs(limit = 30) {
      return (await pool.query(`SELECT DISTINCT ON (agent) * FROM agent_runs ORDER BY agent, started_at DESC LIMIT $1`, [limit])).rows;
    },
  };
}

function createMemoryStore({ lint, now = () => new Date() }) {
  const cards = [];
  const runList = [];
  const settings = [];
  const requests = [];
  const asks = [];
  const profileRows = [];
  const profileLogRows = [];
  const watch = [];
  const snaps = [];
  const comps = [];
  const compVersions = [];
  return {
    cards, runList,
    async list({ status = 'draft', agent } = {}) {
      return cards.filter((c) => c.status === status && (!agent || c.agent === agent)).slice().reverse();
    },
    async get(id) { return cards.find((c) => c.id === Number(id)) || null; },
    async decide(id, d) {
      const card = await this.get(id);
      if (!card) return { error: 'no such card', status: 404 };
      const r = decide(card, d, lint);
      if (r.error) return r;
      Object.assign(card, r.fields, { decided_at: now() });
      return { card };
    },
    async insert(c) {
      const row = { id: cards.length + 1, status: 'draft', edited: false, reason: null, decided_by: null,
        decided_at: null, created_at: now(), target: null, sources: [], checks: {}, run_id: null, payload: null, handoff: null, ...c };
      cards.push(row);
      return row;
    },
    async readyForHandoff() { return cards.filter((c) => c.status === 'ready' && c.payload && (c.payload.post || c.payload.pin) && !c.handoff); },
    async setHandoff(id, h) { const c = cards.find((x) => x.id === id); if (c && !c.handoff) c.handoff = h; },
    async lastRejections(agent, n = 10) {
      return cards.filter((c) => c.agent === agent && c.status === 'rejected').slice(-n).map((c) => ({ title: c.title, reason: c.reason }));
    },
    asks,
    async createAsk(agent, ask, who) {
      if (!who) return { error: 'no person to record' };
      const t = String(ask || '').trim();
      if (t.length < 5) return { error: 'say what you want it to do' };
      if (t.length > 2000) return { error: 'keep the ask under 2000 characters' };
      const a = { id: asks.length + 1, agent, ask: t, asked_by: who, created_at: now(), status: 'new', kind: null, triage: null, order_file: null, decided_by: null, decided_at: null, note: null };
      asks.push(a);
      return { ask: a };
    },
    async listAsks(agent) { return asks.filter((a) => !agent || a.agent === agent).slice().reverse(); },
    async getAsk(id) { return asks.find((a) => a.id === Number(id)) || null; },
    async takeNewAsks() { const q = asks.filter((a) => a.status === 'new'); q.forEach((a) => { a.status = 'sorting'; }); return q; },
    async updateAsk(id, f) { const a = asks.find((x) => x.id === id); Object.assign(a, f); return a; },
    settings, requests,
    async weekStats() {
      const m = new Map();
      for (const c of cards.filter((x) => x.agent !== 'digest')) { const k = c.agent + '|' + c.status; m.set(k, (m.get(k) || 0) + 1); }
      return { cards: [...m].map(([k, n]) => ({ agent: k.split('|')[0], status: k.split('|')[1], n })),
        runs: runList.filter((r) => r.agent !== 'digest').map((r) => ({ agent: r.agent, status: r.status, unavailable: r.unavailable || [] })) };
    },
    async currentSettings(agent) { return settings.filter((x) => x.agent === agent).slice(-1)[0] || null; },
    async allCurrentSettings() { const m = new Map(); for (const x of settings) m.set(x.agent, x); return [...m.values()]; },
    async settingsHistory(agent) { return settings.filter((x) => x.agent === agent).slice().reverse(); },
    async saveSettings(agent, input) {
      const c = checkSettings(input);
      if (c.error) return c;
      const version = settings.filter((x) => x.agent === agent).length + 1;
      const row = { id: settings.length + 1, agent, version, ...c.row, note: input.note || null, edited_by: input.who, created_at: now() };
      settings.push(row);
      return { settings: row };
    },
    async revertSettings(agent, version, who) {
      const old = settings.find((x) => x.agent === agent && x.version === Number(version));
      if (!old) return { error: 'no such version', status: 404 };
      return this.saveSettings(agent, { skill_md: old.skill_md, enabled: old.enabled, max_cards: old.max_cards, note: `put back version ${version}`, who });
    },
    async queueRun(agent, ask, who) {
      if (!who) return { error: 'no person to record' };
      if (requests.some((r) => r.agent === agent && ['queued', 'running'].includes(r.status))) return { error: 'this agent already has a run waiting', status: 409 };
      const r = { id: requests.length + 1, agent, ask: ask || null, requested_by: who, status: 'queued', created_at: now() };
      requests.push(r);
      return { request: r };
    },
    async takeRunRequests() { const q = requests.filter((r) => r.status === 'queued'); q.forEach((r) => { r.status = 'running'; r.picked_at = now(); }); return q; },
    async finishRunRequest(id, ok, note) { Object.assign(requests.find((r) => r.id === id), { status: ok ? 'done' : 'failed', note: note || null, finished_at: now() }); },
    async runRequests() { return requests.slice().reverse(); },
    // #1664 names and portraits.
    profileRows, profileLogRows,
    async profiles() { return profileRows.map(({ portrait, ...p }) => p); },
    async profile(agent) { const p = profileRows.find((x) => x.agent === agent); if (!p) return null; const { portrait, ...rest } = p; return rest; },
    async setName(agent, raw, who) {
      if (!who) return { error: 'no person to record' };
      const c = checkName(raw);
      if (c.error) return c;
      let p = profileRows.find((x) => x.agent === agent);
      const old = p ? p.display_name : null;
      if (!p) { p = { agent, display_name: null, portrait: null, portrait_type: null, portrait_at: null }; profileRows.push(p); }
      Object.assign(p, { display_name: c.name, updated_by: who, updated_at: now() });
      profileLogRows.push({ agent, field: 'name', old_value: old, new_value: c.name, changed_by: who, changed_at: now() });
      return { profile: await this.profile(agent) };
    },
    async setPortrait(agent, buf, who) {
      if (!who) return { error: 'no person to record' };
      let type = null;
      if (buf !== null) { const c = checkPortrait(buf); if (c.error) return c; type = c.type; }
      let p = profileRows.find((x) => x.agent === agent);
      if (!p) { p = { agent, display_name: null }; profileRows.push(p); }
      Object.assign(p, { portrait: buf, portrait_type: type, portrait_at: buf ? now() : null, updated_by: who, updated_at: now() });
      profileLogRows.push({ agent, field: 'portrait', old_value: null, new_value: buf ? `${type}, ${buf.length} bytes` : 'removed', changed_by: who, changed_at: now() });
      return { profile: await this.profile(agent) };
    },
    async portrait(agent) { const p = profileRows.find((x) => x.agent === agent && x.portrait); return p ? { portrait: p.portrait, portrait_type: p.portrait_type, portrait_at: p.portrait_at } : null; },
    async profileLog(agent) { return profileLogRows.filter((x) => x.agent === agent).slice().reverse(); },
    // #1666 the Scout.
    async watchlist(agent) { return watch.filter((w) => w.agent === agent).sort((a, b) => a.site.localeCompare(b.site)).map(({ agent: _, ...w }) => w); },
    async addWatch(agent, raw, label, who) {
      if (!who) return { error: 'no person to record' };
      const c = checkSite(raw);
      if (c.error) return c;
      if (watch.filter((w) => w.agent === agent).length >= MAX_WATCH) return { error: `the list is full (${MAX_WATCH} sites); remove one first` };
      if (watch.some((w) => w.agent === agent && w.site === c.site)) return { error: `${c.site} is already on the list`, status: 409 };
      const w = { id: watch.length + 1, agent, site: c.site, label: label ? String(label).trim().slice(0, 80) || null : null, added_by: who, added_at: now() };
      watch.push(w);
      const { agent: _, ...out } = w;
      return { watch: out };
    },
    async removeWatch(agent, id) {
      const i = watch.findIndex((w) => w.agent === agent && w.id === Number(id));
      if (i < 0) return { error: 'not on the list', status: 404 };
      const [w] = watch.splice(i, 1);
      for (let j = snaps.length - 1; j >= 0; j--) if (snaps[j].agent === agent && snaps[j].site === w.site) snaps.splice(j, 1);
      return { removed: w.site };
    },
    async snapshots(agent, site) { return snaps.filter((x) => x.agent === agent && x.site === site).map(({ agent: _a, site: _s, ...x }) => x); },
    async saveSnapshots(agent, site, pages, gone) {
      for (const p of pages) {
        const old = snaps.find((x) => x.agent === agent && x.site === site && x.path === p.path);
        if (old) Object.assign(old, { title: p.title || null, hash: p.hash, text: p.text, seen_at: now() });
        else snaps.push({ agent, site, path: p.path, title: p.title || null, hash: p.hash, text: p.text, seen_at: now() });
      }
      for (const g of gone || []) { const i = snaps.findIndex((x) => x.agent === agent && x.site === site && x.path === g); if (i >= 0) snaps.splice(i, 1); }
    },
    watch, snaps,
    // #1668 competitors.
    comps, compVersions,
    async syncCompetitors(list) {
      const keep = new Set(list.map((c) => c.site));
      for (const c of list) {
        let r = comps.find((x) => x.site === c.site);
        if (!r) { r = { site: c.site, profile_md: null, profile_version: 0, profile_at: null, last_changes: null, changes_at: null, kh_notes: null, kh_notes_by: null, kh_notes_at: null }; comps.push(r); }
        Object.assign(r, { name: c.name, brands: c.brands, segments: c.segments || [], sheet_notes: c.notes || [], top: !!c.top, on_sheet: true, updated_at: now() });
      }
      for (const r of comps) if (!keep.has(r.site)) Object.assign(r, { on_sheet: false, top: false });
    },
    async competitors() {
      return comps.filter((c) => c.on_sheet).slice().sort((a, b) => (b.top - a.top) || (b.brands.length - a.brands.length) || a.name.localeCompare(b.name));
    },
    async competitor(site) { return comps.find((c) => c.site === site) || null; },
    async setCompetitorChanges(site, text) { const c = comps.find((x) => x.site === site); if (c) Object.assign(c, { last_changes: text, changes_at: now() }); },
    async saveProfile(site, md) {
      const c = comps.find((x) => x.site === site);
      if (!c) return { error: 'no such competitor', status: 404 };
      c.profile_version += 1; c.profile_md = md; c.profile_at = now();
      compVersions.push({ site, version: c.profile_version, profile_md: md, created_at: now() });
      return { version: c.profile_version };
    },
    async withdrawProfile(site) { const c = comps.find((x) => x.site === site); if (c) c.profile_md = null; },
    async profileVersions(site) { return compVersions.filter((v) => v.site === site).slice().reverse(); },
    async setKhNotes(site, notes, who) {
      if (!who) return { error: 'no person to record' };
      const t = String(notes == null ? '' : notes).trim();
      if (t.length > 4000) return { error: 'keep notes under 4000 characters' };
      const c = comps.find((x) => x.site === site);
      if (!c) return { error: 'no such competitor', status: 404 };
      Object.assign(c, { kh_notes: t || null, kh_notes_by: who, kh_notes_at: now() });
      return { competitor: { site, kh_notes: c.kh_notes, kh_notes_by: who, kh_notes_at: c.kh_notes_at } };
    },
    async startRun(agent) { runList.push({ id: runList.length + 1, agent, status: 'running', started_at: now() }); return runList.length; },
    async finishRun(id, f) { Object.assign(runList[id - 1], f, { finished_at: now() }); },
    async runs() {
      const last = new Map();
      for (const r of runList) last.set(r.agent, r);
      return [...last.values()];
    },
  };
}

module.exports = { SCHEMA_SQL, ensureAgentTables, mergeListingsIntoCitations, OLD_CITATIONS_DEFAULT_SHA, citationsAddAiSources, CITATIONS_1699_DEFAULT_SHA, createPgStore, createMemoryStore, decide, checkSettings, MAX_SKILL };
