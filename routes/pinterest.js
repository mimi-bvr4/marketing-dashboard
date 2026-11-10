// ORDER #3164: Settings, Pinterest accounts. One row per venue (Connected or
// Not connected) and a Connect button that runs Pinterest's login approval for
// that venue's account. Behind PINTEREST_PER_VENUE (default OFF): off, the page
// says so and Connect answers 404.
//
//   GET  /settings/pinterest                  the page
//   GET  /api/pinterest/accounts              { on, app_ready, line, venues, recent }  (no token, ever)
//   POST /api/pinterest/connect/:venue        -> { url } the Pinterest approval page for that venue
//   GET  /settings/pinterest/callback         Pinterest sends the browser back here with a one-time code
//   POST /api/pinterest/cards/:id/choose      { venue, board } Katherine's pick on a draft pin
//
// The code is parked in pinterest_connects for the Box, which trades it for the
// venue's refresh token and keeps that token in its Keychain (lib/pinterest-connect.js).
// This server never holds the app secret or any token. Below the #654/#1370
// page gate, signed-in leadership only, recorded by email.
'use strict';

const express = require('express');
const path = require('path');
const PV = require('../lib/pinterest-venues');
const { personOf } = require('./review');

const PAGE_FILE = path.join(__dirname, '..', 'public', 'pinterest-accounts.html');

function redirectUri(env = process.env) {
  return env.PINTEREST_REDIRECT_URI || `${env.MARKETING_BASE_URL || 'https://marketing.infinityhospitalitygroup.com'}/settings/pinterest/callback`;
}

function createPinterestRouter({ accounts, store, env = process.env }) {
  const r = express.Router();
  const need = (req, res, next) => (personOf(req) ? next() : res.status(403).json({ error: 'Signed-in leadership only.' }));
  const on = (req, res, next) => (PV.perVenueOn(env) ? next() : res.status(404).json({ error: 'off', switch: 'PINTEREST_PER_VENUE' }));

  r.get(PV.PAGE, (req, res) => (personOf(req) ? res.sendFile(PAGE_FILE) : res.status(403).send('Signed-in leadership only.')));

  r.get('/api/pinterest/accounts', need, async (req, res) => {
    const rows = PV.perVenueOn(env) ? await accounts.list() : [];
    const by = new Map(rows.map((a) => [a.venue, a]));
    res.json({ on: PV.perVenueOn(env), app_ready: !!env.PINTEREST_APP_ID, ...PV.connectedLine(rows),
      venues: PV.VENUES.map((v) => { const a = by.get(v.code); return { code: v.code, name: v.name, site: v.site,
        connected: !!(a && a.connected), boards: a ? (a.boards || []).map((b) => b.name) : [], why: a ? a.why : null, checked_at: a ? a.checked_at : null }; }),
      recent: PV.perVenueOn(env) ? (await accounts.recentConnects()).map((c) => ({ venue: c.venue, asked_by: c.asked_by, created_at: c.created_at, came_back: c.came_back, done_at: c.done_at, outcome: c.outcome })) : [] });
  });

  r.post('/api/pinterest/connect/:venue', need, on, async (req, res) => {
    const v = PV.byCode(req.params.venue);
    if (!v) return res.status(404).json({ error: 'not one of our venues' });
    if (!env.PINTEREST_APP_ID) return res.status(409).json({ error: 'The Pinterest app id is not set on the dashboard yet (PINTEREST_APP_ID).' });
    const state = PV.newState(v.code);
    const uri = redirectUri(env);
    await accounts.addConnect({ state, venue: v.code, who: personOf(req), redirectUri: uri });
    res.json({ url: PV.authorizeUrl({ appId: env.PINTEREST_APP_ID, redirectUri: uri, state }) });
  });

  r.get('/settings/pinterest/callback', async (req, res) => {
    if (!personOf(req)) return res.status(403).send('Signed-in leadership only.');
    if (!PV.perVenueOn(env)) return res.redirect(PV.PAGE);
    const state = String(req.query.state || '');
    const code = String(req.query.code || '');
    if (req.query.error || !code) return res.redirect(`${PV.PAGE}?result=declined`);
    if (!/^[A-Z]{3}\.[0-9a-f]{36}$/.test(state) || code.length > 2000) return res.redirect(`${PV.PAGE}?result=bad`);
    const got = await accounts.setCode(state, code);
    res.redirect(`${PV.PAGE}?result=${got ? `waiting&venue=${encodeURIComponent(got.venue)}` : 'expired'}`);
  });

  r.post('/api/pinterest/cards/:id/choose', need, on, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad id' });
    const card = await store.get(id);
    if (!card) return res.status(404).json({ error: 'no such card' });
    const out = PV.choosePin(card, req.body || {}, await accounts.list());
    if (out.error) return res.status(400).json({ error: out.error });
    const saved = await store.setPinPayload(id, out.payload);
    if (!saved) return res.status(409).json({ error: 'only a draft pin can be changed' });
    res.json({ card: saved });
  });

  return r;
}

module.exports = { createPinterestRouter, redirectUri };
