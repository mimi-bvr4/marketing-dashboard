// ORDER #3164: Pinterest Paul posts to EACH venue's own Pinterest account
// (Mimi 11.09.2026, in the Katherine meeting: "each venue has its own individual
// pinterest login. how is that going to work with Paul?").
//
// ONE developer app (pinterest-app-id + pinterest-app-secret, unchanged), and one
// login approval per venue account, which gives one refresh token per venue in
// the Box Keychain as pinterest-refresh-token-<venuecode>. Never printed.
//
// Behind PINTEREST_PER_VENUE (default OFF). Off, Paul is exactly #1710: one
// account, the three Keychain items. Rollback: unset the switch.
//
// Venue codes and names come ONLY from 05_AI_and_Brain/Venue_Master_CANONICAL.md
// (test/order3164_pinterest_per_venue.test.js checks every code against it).
// A post on a single-venue site pins to that venue. A post on a multi-venue site
// (infinityhospitalitygroup.com and the other brand sites) asks Katherine to pick
// the venue on the card. Paul never guesses.
//
// Where things live: the Railway dashboard holds the Settings page and the
// Connect button; the Pinterest login sends the browser back to the dashboard
// with a one-time code, which is parked in pinterest_connects. The Box (every
// 15 minutes, inside jobs/agent_handoff.js) trades the code for the refresh
// token, writes it to the Keychain, wipes the code, and records Connected and
// that account's boards in pinterest_accounts. No token ever reaches Postgres.
'use strict';

const crypto = require('crypto');

const VENUES = [
  { code: 'TBB', name: 'The Bridge Building', site: 'thebridgebuilding.com' },
  { code: 'TBT', name: 'The Bell Tower', site: 'thebelltower.com' },
  { code: 'ECD', name: 'The Estate at Cherokee Dock', site: 'cherokeedock.com' },
  { code: 'SWF', name: 'Saddle Woods Farm', site: 'saddlewoodsfarm.com' },
  { code: 'STE', name: 'Saint Elle', site: 'thesaintelle.com' },
  { code: 'COR', name: 'The Cordelle', site: 'thecordelle.com' },
  { code: 'EST', name: 'Estelle', site: 'estellenashville.com' },
];
const PAGE = '/settings/pinterest';
const SCOPES = 'boards:read,pins:read,pins:write';
const CODE_TTL_MIN = 60; // a parked code older than this is never traded

function perVenueOn(env = process.env) { return String(env.PINTEREST_PER_VENUE || '').trim().toLowerCase() === 'on'; }
const byCode = (code) => VENUES.find((v) => v.code === String(code || '').toUpperCase()) || null;
const tokenItem = (code) => `pinterest-refresh-token-${String(code).toLowerCase()}`;
const host = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return null; } };

// Which account a post's link belongs to: { venue } | { pick: true } | { none: true }.
function venueForLink(link) {
  const { OUR_SITES } = require('./pinterest');
  const h = host(link);
  const v = VENUES.find((x) => x.site === h);
  if (v) return { venue: v.code };
  if (OUR_SITES.includes(h)) return { pick: true };
  return { none: true };
}

// The card's pin, placed: a single-venue site sets the venue; a multi-venue site
// leaves it empty and marks it for Katherine to pick. Written by code, not the model.
function placePin(pin) {
  if (!pin) return pin;
  const w = venueForLink(pin.link);
  if (w.venue) return { ...pin, venue: w.venue, pick: false };
  return { ...pin, venue: null, pick: true };
}

function connectedLine(accounts) {
  const on = new Set((accounts || []).filter((a) => a.connected).map((a) => a.venue));
  const n = VENUES.filter((v) => on.has(v.code)).length;
  return { connected: n, total: VENUES.length, line: `Connected: ${n} of ${VENUES.length} venues`, page: PAGE };
}

function authorizeUrl({ appId, redirectUri, state }) {
  const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES, state });
  return `https://www.pinterest.com/oauth/?${q.toString()}`;
}
const newState = (code) => `${String(code).toUpperCase()}.${crypto.randomBytes(18).toString('hex')}`;

// Katherine's pick on a card (the venue on a multi-venue site; the board on any
// per-venue card). Returns { payload } or { error }. Boards come only from that
// venue's own account, as the Box last read it.
function choosePin(card, { venue, board }, accounts) {
  const pin = card && card.payload && card.payload.pin;
  if (!pin) return { error: 'this card carries no pin' };
  if (card.status !== 'draft') return { error: 'only a draft pin can be changed' };
  const v = byCode(venue || pin.venue);
  if (!v) return { error: 'pick one of our venues' };
  const site = venueForLink(pin.link);
  if (site.venue && site.venue !== v.code) return { error: `this post is on ${byCode(site.venue).name}'s site, so it pins to ${byCode(site.venue).name}` };
  const acct = (accounts || []).find((a) => a.venue === v.code);
  if (!acct || !acct.connected) return { error: `connect ${v.name} first (Settings, Pinterest accounts)` };
  const names = (acct.boards || []).map((b) => b.name);
  const want = board != null && String(board).trim() ? String(board).trim() : null;
  if (want && !names.includes(want)) return { error: `${v.name}'s Pinterest has no board named "${want}"` };
  const keep = want || (names.includes(pin.board) ? pin.board : null);
  return { payload: { ...card.payload, pin: { ...pin, venue: v.code, board: keep || '', pick: !!site.pick } } };
}

// Approve is refused until a per-venue pin knows its venue and its board.
function pinBlockers(pin) {
  if (!pin || !('venue' in pin)) return [];
  const out = [];
  if (!pin.venue) out.push('the pin: pick the venue (this post is on a site shared by several venues)');
  if (!pin.board || !String(pin.board).trim()) out.push('the pin: pick a board');
  return out;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pinterest_accounts (
  venue TEXT PRIMARY KEY,
  connected BOOLEAN NOT NULL DEFAULT false,
  boards JSONB NOT NULL DEFAULT '[]'::jsonb,
  why TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pinterest_connects (
  state TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  asked_by TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  code_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  outcome TEXT
);`;

async function ensurePinterestTables(pool) { await pool.query(SCHEMA_SQL); }

function createPgAccounts(pool) {
  return {
    async list() { return (await pool.query('SELECT venue, connected, boards, why, checked_at FROM pinterest_accounts ORDER BY venue')).rows; },
    async save(venue, { connected, boards, why }) {
      await pool.query(`INSERT INTO pinterest_accounts (venue, connected, boards, why, checked_at) VALUES ($1,$2,$3,$4,now())
        ON CONFLICT (venue) DO UPDATE SET connected = $2, boards = $3, why = $4, checked_at = now()`, [venue, !!connected, JSON.stringify(boards || []), why || null]);
    },
    async addConnect({ state, venue, who, redirectUri }) {
      await pool.query('INSERT INTO pinterest_connects (state, venue, asked_by, redirect_uri) VALUES ($1,$2,$3,$4)', [state, venue, who, redirectUri]);
    },
    async setCode(state, code) {
      return (await pool.query(`UPDATE pinterest_connects SET code = $2, code_at = now() WHERE state = $1 AND code IS NULL AND done_at IS NULL
        AND created_at > now() - interval '${CODE_TTL_MIN} minutes' RETURNING venue`, [state, code])).rows[0] || null;
    },
    async pendingCodes() {
      return (await pool.query(`SELECT state, venue, code, redirect_uri, code_at FROM pinterest_connects WHERE code IS NOT NULL AND done_at IS NULL ORDER BY code_at`)).rows;
    },
    async finishConnect(state, outcome) {
      await pool.query('UPDATE pinterest_connects SET code = NULL, done_at = now(), outcome = $2 WHERE state = $1', [state, String(outcome).slice(0, 300)]);
    },
    async recentConnects() {
      return (await pool.query(`SELECT venue, asked_by, created_at, code_at IS NOT NULL AS came_back, done_at, outcome FROM pinterest_connects
        WHERE created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 30`)).rows;
    },
  };
}

function createMemoryAccounts({ now = () => new Date() } = {}) {
  const accounts = new Map(); const connects = new Map();
  return {
    async list() { return [...accounts.values()].sort((a, b) => a.venue.localeCompare(b.venue)); },
    async save(venue, { connected, boards, why }) { accounts.set(venue, { venue, connected: !!connected, boards: boards || [], why: why || null, checked_at: now() }); },
    async addConnect({ state, venue, who, redirectUri }) { connects.set(state, { state, venue, asked_by: who, redirect_uri: redirectUri, code: null, created_at: now(), code_at: null, done_at: null, outcome: null }); },
    async setCode(state, code) {
      const c = connects.get(state);
      if (!c || c.code || c.done_at || now() - c.created_at > CODE_TTL_MIN * 60000) return null;
      c.code = code; c.code_at = now(); return { venue: c.venue };
    },
    async pendingCodes() { return [...connects.values()].filter((c) => c.code && !c.done_at); },
    async finishConnect(state, outcome) { const c = connects.get(state); if (c) { c.code = null; c.done_at = now(); c.outcome = String(outcome); } },
    async recentConnects() { return [...connects.values()].map(({ code, ...c }) => ({ ...c, came_back: !!c.code_at })); },
    _connects: connects,
  };
}

module.exports = { VENUES, PAGE, SCOPES, CODE_TTL_MIN, perVenueOn, byCode, tokenItem, venueForLink, placePin, connectedLine, authorizeUrl, newState,
  choosePin, pinBlockers, SCHEMA_SQL, ensurePinterestTables, createPgAccounts, createMemoryAccounts };
