// ORDER #3622 (follows #3617, spec 05_AI_and_Brain/specs/cadet_canva_read_spec.md):
// the Archivist reads Canva designs, READ-ONLY, behind CADET_CANVA_READ (default OFF).
//
// Ruled by Mimi 11.19.2026 (popup): the Canva account that signs in is brain@ Canva,
// on Katherine's Canva team, able to open all 114 Collateral Map designs.
//
// Where things live (the Pinterest pattern, #3164):
//   - The dashboard (Railway) holds the sign-in link (/settings/canva/connect) and
//     the redirect (/settings/canva/callback). Canva sends the browser back with a
//     one-time code, which is parked in canva_connects with its PKCE verifier.
//     The dashboard never holds the client secret or any token.
//   - The Box (jobs/cadet_run.js, every 15 minutes) trades the code for the refresh
//     token and keeps it in the Box Keychain as canva-refresh-token. Canva refresh
//     tokens are single-use: every refresh returns a new one, which is written back
//     at once. No token is ever printed, logged or stored in Postgres.
//   - The Box exports each design to PDF, reads its text (lib/canva-pdf.js) and
//     caches it by design id plus Canva's updated_at, so only a changed design is
//     exported again. The cache is a folder on the Box (CANVA_CACHE_DIR).
//
// The client sends GETs, plus exactly two POSTs: /oauth/token (the login trade)
// and /exports (an export makes a download file; it does not change the design).
// Scopes: design:meta:read design:content:read, and no write scope of any kind.
//
// Checked against Canva's live docs 11.19.2026 (canva.dev/docs/connect: authentication,
// generate-access-token, create-design-export-job, get-design-export-job, get-design, scopes).
// Rollback: unset CADET_CANVA_READ (the search is then byte-for-byte #3617's).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pdfText } = require('./canva-pdf');

const API = 'https://api.canva.com/rest/v1';
const AUTHORIZE = 'https://www.canva.com/api/oauth/authorize';
const SCOPES = 'design:meta:read design:content:read';
const CONNECT_PAGE = '/settings/canva/connect';
const CALLBACK = '/settings/canva/callback';
const ITEMS = { id: 'canva-client-id', secret: 'canva-client-secret', refresh: 'canva-refresh-token' };
const CODE_TTL_MIN = 60;            // a parked code older than this is never traded
const CHECK_MS = 60 * 60 * 1000;    // a cached design is re-checked against Canva after an hour
const POLL_MS = 2000;
const POLL_TRIES = 60;
const CANT_OPEN = "brain@ can't open this one";
const NO_TEXT = 'NOT CHECKED (image-only pages): the exported PDF has no text to read';

function readOn(env = process.env) { return String(env.CADET_CANVA_READ || '').trim().toLowerCase() === 'on'; }

function redirectUri(env = process.env) {
  return env.CANVA_REDIRECT_URI || `${env.MARKETING_BASE_URL || 'https://marketing.infinityhospitalitygroup.com'}${CALLBACK}`;
}

// ------------------------------------------------------------ PKCE sign-in link

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newState = () => `CANVA.${crypto.randomBytes(18).toString('hex')}`;
const newVerifier = () => b64url(crypto.randomBytes(48)); // 64 characters, inside 43..128
const challengeOf = (verifier) => b64url(crypto.createHash('sha256').update(verifier).digest());

function authorizeUrl({ clientId, redirectUri: uri, state, verifier }) {
  const q = new URLSearchParams({ code_challenge: challengeOf(verifier), code_challenge_method: 's256', scope: SCOPES,
    response_type: 'code', client_id: clientId, state, redirect_uri: uri });
  return `${AUTHORIZE}?${q.toString()}`;
}

// ------------------------------------------------------------ Keychain

function keychain(name, run = execFileSync) {
  try { return String(run('security', ['find-generic-password', '-s', name, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null; }
  catch (e) { return null; }
}

// The token goes to `security` on stdin (its -i mode), never on the command line.
const SAFE = /^[A-Za-z0-9._~+/=-]{8,8192}$/;
function saveSecret(item, value, run = execFileSync) {
  if (!SAFE.test(String(value))) throw new Error('Canva returned a token in an unexpected shape; not saved');
  run('security', ['-i'], { input: `add-generic-password -U -a ihg-box -s ${item} -w ${value}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
}

// ------------------------------------------------------------ tokens (the Box)

async function tokenCall(body, { fetchImpl, secrets }) {
  const id = secrets(ITEMS.id); const secret = secrets(ITEMS.secret);
  if (!id || !secret) return { ok: false, retry: true, why: `the Canva integration is not on the Box yet (Keychain items ${ITEMS.id}, ${ITEMS.secret})` };
  const r = await fetchImpl(`${API}/oauth/token`, { method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) return { ok: false, why: `Canva refused: ${j.error_description || j.message || j.error || j.code || r.status}` };
  return { ok: true, access: j.access_token || null, refresh: j.refresh_token };
}

// A code parked by the dashboard, traded for the refresh token.
async function exchangeCode({ code, verifier, redirectUri: uri, fetchImpl = globalThis.fetch, secrets = keychain }) {
  return tokenCall({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: uri }, { fetchImpl, secrets });
}

// A fresh access token. Canva refresh tokens are single-use: the new one is saved
// before the access token is handed out. A failed save is loud: the old one is spent.
async function accessToken({ fetchImpl = globalThis.fetch, secrets = keychain, save = saveSecret }) {
  const refresh = secrets(ITEMS.refresh);
  if (!refresh) return { ok: false, unconnected: true, why: 'brain@ has not signed in to Canva yet' };
  const r = await tokenCall({ grant_type: 'refresh_token', refresh_token: refresh }, { fetchImpl, secrets });
  if (!r.ok) return r;
  try { save(ITEMS.refresh, r.refresh); }
  catch (e) { return { ok: false, why: `the Box could not save Canva's new refresh token (${e.message}); sign in again at ${CONNECT_PAGE}` }; }
  if (!r.access) return { ok: false, why: 'Canva sent no access token' };
  return { ok: true, token: r.access };
}

// Every code parked on the dashboard: trade, save, wipe. Never logs a token.
async function tradeCodes({ connects, fetchImpl = globalThis.fetch, secrets = keychain, save = saveSecret, log = console.log }) {
  let traded = 0;
  for (const c of await connects.pendingCodes()) {
    const r = await exchangeCode({ code: c.code, verifier: c.verifier, redirectUri: c.redirect_uri, fetchImpl, secrets });
    if (r.retry) { log(`canva connect: will retry, ${r.why}`); continue; }
    if (!r.ok) { await connects.finishConnect(c.state, `failed: ${r.why}. Sign in again.`); log(`canva connect: ${r.why}`); continue; }
    try { save(ITEMS.refresh, r.refresh); }
    catch (e) { await connects.finishConnect(c.state, `failed: the Box could not save it (${e.message})`); log('canva connect: Keychain save failed'); continue; }
    await connects.finishConnect(c.state, 'connected');
    log(`canva connect: connected (Keychain ${ITEMS.refresh})`);
    traded++;
  }
  return traded;
}

// ------------------------------------------------------------ the API (read-only)

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function api(pathname, { token, fetchImpl, method = 'GET', body }) {
  const r = await fetchImpl(`${API}${pathname}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, j };
}

// A canva.link short link is followed, without a credential, to its /design/<id>/ address.
async function designIdOf(link, { fetchImpl }) {
  if (link && link.id) return link.id;
  let u = link && link.uri;
  for (let hop = 0; u && hop < 4; hop++) {
    const m = String(u).match(/canva\.com\/design\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    let r;
    try { r = await fetchImpl(u, { method: 'GET', redirect: 'manual' }); } catch (e) { return null; }
    const loc = r.headers && typeof r.headers.get === 'function' ? r.headers.get('location') : null;
    if (!loc) return null;
    u = new URL(loc, u).toString();
  }
  return null;
}

async function exportPdf(id, { token, fetchImpl, wait = sleep }) {
  const start = await api('/exports', { token, fetchImpl, method: 'POST', body: { design_id: id, format: { type: 'pdf' } } });
  if (start.status === 403 || start.status === 404) return { denied: true };
  if (!start.ok || !start.j.job) return { failed: `Canva would not start the export (${start.j.code || start.status})` };
  let job = start.j.job;
  for (let n = 0; job.status === 'in_progress' && n < POLL_TRIES; n++) {
    await wait(POLL_MS);
    const g = await api(`/exports/${encodeURIComponent(job.id)}`, { token, fetchImpl });
    if (!g.ok || !g.j.job) return { failed: `Canva's export could not be checked (${g.j.code || g.status})` };
    job = g.j.job;
  }
  if (job.status !== 'success') return { failed: job.status === 'failed' ? `Canva's export failed (${(job.error && job.error.code) || 'no reason given'})` : 'Canva\'s export did not finish in time' };
  const texts = [];
  for (const url of job.urls || []) {
    const r = await fetchImpl(url, { method: 'GET' });
    if (!r.ok) return { failed: `the exported PDF did not download (${r.status})` };
    texts.push(pdfText(Buffer.from(await r.arrayBuffer())));
  }
  return { text: texts.join('\n').trim() };
}

// ------------------------------------------------------------ the cache

function createFileCache(dir = process.env.CANVA_CACHE_DIR || path.join(os.homedir(), '.ihg_archivist_canva')) {
  const safe = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
  const file = (id) => path.join(dir, `${safe(id)}.json`);
  const linksFile = path.join(dir, 'links.json');
  let links = null;
  const loadLinks = () => { if (!links) { try { links = JSON.parse(fs.readFileSync(linksFile, 'utf8')); } catch (e) { links = {}; } } return links; };
  return {
    get(id) { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch (e) { return null; } },
    set(id, v) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file(id), JSON.stringify(v)); },
    linkId(uri) { return loadLinks()[uri] || null; },
    setLinkId(uri, id) { loadLinks()[uri] = id; fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(linksFile, JSON.stringify(links)); },
  };
}

function createMemoryCache() {
  const m = new Map(); const l = new Map();
  return { get: (id) => m.get(id) || null, set: (id, v) => m.set(id, v), linkId: (u) => l.get(u) || null, setLinkId: (u, id) => l.set(u, id), _m: m };
}

// ------------------------------------------------------------ the reader

// One reader per Box run. read(material) answers one of:
//   { off: true }                       not signed in: the search keeps #3617's honest line
//   { denied: true }                    brain@ can't open it (listed by the map's title)
//   { not_checked: why }                queued, export failed, or image-only
//   { text, design_id, updated_at }     the design's text, from the cache or a fresh export
function createReader({ fetchImpl = globalThis.fetch, secrets = keychain, save = saveSecret, cache = createFileCache(), now = () => Date.now(), budget = 10, wait = sleep, log = () => {} } = {}) {
  let token = null; let tokenFail = null; let spent = 0;
  async function getToken() {
    if (token || tokenFail) return token;
    const t = await accessToken({ fetchImpl, secrets, save });
    if (t.ok) token = t.token; else { tokenFail = t; log(`canva: no access token, ${t.why}`); }
    return token;
  }
  const answer = (c) => (c.denied ? { denied: true } : c.text ? { text: c.text, design_id: c.design_id, updated_at: c.updated_at } : { not_checked: c.why || NO_TEXT });

  async function read(material) {
    const link = material.link || {};
    let id = link.id || cache.linkId(link.uri);
    const cached = id ? cache.get(id) : null;
    if (cached && now() - cached.checked_at < CHECK_MS) return answer(cached);
    if (spent >= budget) return cached ? answer(cached) : { not_checked: 'not read yet: the Archivist reads Canva designs a few at a time, and this one is next in line' };
    if (!(await getToken())) return cached ? answer(cached) : { off: true };
    spent++;
    if (!id) {
      id = await designIdOf(link, { fetchImpl });
      if (!id) return { not_checked: `the Canva link ${link.uri || ''} did not lead to a design` };
      cache.setLinkId(link.uri, id);
    }
    const meta = await api(`/designs/${encodeURIComponent(id)}`, { token, fetchImpl });
    if (meta.status === 403 || meta.status === 404) { cache.set(id, { design_id: id, denied: true, checked_at: now() }); return { denied: true }; }
    if (!meta.ok || !meta.j.design) return cached ? answer(cached) : { not_checked: `Canva could not be asked about this design (${meta.j.code || meta.status})` };
    const updated = meta.j.design.updated_at;
    if (cached && !cached.denied && cached.updated_at === updated) { cache.set(id, { ...cached, checked_at: now() }); return answer(cached); }
    const ex = await exportPdf(id, { token, fetchImpl, wait });
    if (ex.denied) { cache.set(id, { design_id: id, denied: true, checked_at: now() }); return { denied: true }; }
    if (ex.failed) return cached ? answer(cached) : { not_checked: ex.failed };
    const entry = { design_id: id, updated_at: updated, text: ex.text, why: ex.text ? null : NO_TEXT, checked_at: now() };
    cache.set(id, entry);
    log(`canva: read design ${id} (${ex.text.length} characters)`);
    return answer(entry);
  }

  // The Box run's own pass: read up to `budget` Canva materials, oldest-checked first.
  async function prime(materials) {
    const list = (materials || []).filter((m) => m.link && m.link.kind === 'canva');
    const age = (m) => { const id = m.link.id || cache.linkId(m.link.uri); const c = id ? cache.get(id) : null; return c ? c.checked_at : 0; };
    list.sort((a, b) => age(a) - age(b));
    let done = 0;
    for (const m of list) {
      if (spent >= budget) break;
      const r = await read(m);
      if (r.off) break;
      done++;
    }
    return { read: done, spent };
  }

  return { read, prime, get spent() { return spent; } };
}

// ------------------------------------------------------------ the sign-ins (Postgres)

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS canva_connects (
  state TEXT PRIMARY KEY,
  asked_by TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  verifier TEXT,
  code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  code_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  outcome TEXT
);
CREATE TABLE IF NOT EXISTS canva_app (
  id INT PRIMARY KEY,
  client_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

// ORDER #3625: the Box publishes the Canva client id (not a secret: it rides in
// the sign-in link itself) from its Keychain to the dashboard's database on every
// Archivist run, so the dashboard needs no CANVA_CLIENT_ID variable on Railway.
// The client secret never leaves the Box. The id itself is not logged.
const CLIENT_ID_SHAPE = /^[A-Za-z0-9_-]{4,128}$/;
async function publishClientId({ connects, secrets = keychain, log = console.log }) {
  const id = secrets(ITEMS.id);
  if (!id) { log(`canva app: Keychain item ${ITEMS.id} not found on the Box; the dashboard's sign-in link stays not ready`); return 'missing'; }
  if (!CLIENT_ID_SHAPE.test(id)) { log(`canva app: Keychain item ${ITEMS.id} is not in the shape of a Canva client id; not published`); return 'bad shape'; }
  if ((await connects.clientId()) === id) return 'unchanged';
  await connects.setClientId(id);
  log('canva app: client id published to the dashboard (the secret stays on the Box)');
  return 'published';
}

async function ensureCanvaTables(pool) { await pool.query(SCHEMA_SQL); }

function createPgConnects(pool) {
  return {
    async addConnect({ state, who, redirectUri: uri, verifier }) {
      await pool.query('INSERT INTO canva_connects (state, asked_by, redirect_uri, verifier) VALUES ($1,$2,$3,$4)', [state, who, uri, verifier]);
    },
    async setCode(state, code) {
      return (await pool.query(`UPDATE canva_connects SET code = $2, code_at = now() WHERE state = $1 AND code IS NULL AND done_at IS NULL
        AND created_at > now() - interval '${CODE_TTL_MIN} minutes' RETURNING state`, [state, code])).rows[0] || null;
    },
    async pendingCodes() {
      return (await pool.query('SELECT state, code, verifier, redirect_uri, code_at FROM canva_connects WHERE code IS NOT NULL AND done_at IS NULL ORDER BY code_at')).rows;
    },
    async finishConnect(state, outcome) {
      await pool.query('UPDATE canva_connects SET code = NULL, verifier = NULL, done_at = now(), outcome = $2 WHERE state = $1', [state, String(outcome).slice(0, 300)]);
    },
    async recentConnects() {
      return (await pool.query(`SELECT asked_by, created_at, code_at IS NOT NULL AS came_back, done_at, outcome FROM canva_connects
        WHERE created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 20`)).rows;
    },
    async clientId() {
      const row = (await pool.query('SELECT client_id FROM canva_app WHERE id = 1')).rows[0];
      return row ? row.client_id : null;
    },
    async setClientId(id) {
      await pool.query(`INSERT INTO canva_app (id, client_id, updated_at) VALUES (1, $1, now())
        ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, updated_at = now()`, [id]);
    },
  };
}

function createMemoryConnects({ now = () => new Date() } = {}) {
  const connects = new Map();
  let appClientId = null;
  return {
    async clientId() { return appClientId; },
    async setClientId(id) { appClientId = id; },
    async addConnect({ state, who, redirectUri: uri, verifier }) { connects.set(state, { state, asked_by: who, redirect_uri: uri, verifier, code: null, created_at: now(), code_at: null, done_at: null, outcome: null }); },
    async setCode(state, code) {
      const c = connects.get(state);
      if (!c || c.code || c.done_at || now() - c.created_at > CODE_TTL_MIN * 60000) return null;
      c.code = code; c.code_at = now(); return { state };
    },
    async pendingCodes() { return [...connects.values()].filter((c) => c.code && !c.done_at); },
    async finishConnect(state, outcome) { const c = connects.get(state); if (c) { c.code = null; c.verifier = null; c.done_at = now(); c.outcome = String(outcome); } },
    async recentConnects() { return [...connects.values()].map(({ code, verifier, state, redirect_uri, ...c }) => ({ ...c, came_back: !!c.code_at })); },
    _connects: connects,
  };
}

module.exports = { API, AUTHORIZE, SCOPES, ITEMS, CONNECT_PAGE, CALLBACK, CANT_OPEN, NO_TEXT, CHECK_MS, readOn, redirectUri, newState, newVerifier, challengeOf, authorizeUrl,
  keychain, saveSecret, publishClientId, exchangeCode, accessToken, tradeCodes, designIdOf, exportPdf, createFileCache, createMemoryCache, createReader,
  SCHEMA_SQL, ensureCanvaTables, createPgConnects, createMemoryConnects };
