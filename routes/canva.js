// ORDER #3622: the brain@ Canva sign-in for the Archivist (the Pinterest pattern, #3164).
//
//   GET /settings/canva/connect    signed-in leadership: starts Canva's sign-in (PKCE), read-only scopes
//   GET /settings/canva/callback   Canva sends the browser back here with a one-time code
//   GET /api/canva/connects        the last week's sign-ins (who, when, outcome; never a code or token)
//
// The code is parked in canva_connects with its PKCE verifier; the Box trades it
// for the refresh token on its next cadet run and keeps that in its Keychain
// (lib/canva.js tradeCodes). This server never holds the client secret or a token.
// The client id is not a secret (it is in the sign-in link itself): CANVA_CLIENT_ID.
'use strict';

const express = require('express');
const C = require('../lib/canva');
const { personOf } = require('./review');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:40rem;margin:3rem auto;line-height:1.5"><h1>${esc(title)}</h1><p>${esc(body)}</p><p><a href="/cadet">Back to the Archivist</a></p>`;

function createCanvaRouter({ connects, env = process.env }) {
  const r = express.Router();

  r.get(C.CONNECT_PAGE, async (req, res) => {
    const who = personOf(req);
    if (!who) return res.status(403).send('Signed-in leadership only.');
    if (!env.CANVA_CLIENT_ID) return res.status(409).send(page('Canva sign-in not ready', 'The Canva integration id is not set on the dashboard yet (CANVA_CLIENT_ID).'));
    const state = C.newState();
    const verifier = C.newVerifier();
    const uri = C.redirectUri(env);
    await connects.addConnect({ state, who, redirectUri: uri, verifier });
    res.redirect(C.authorizeUrl({ clientId: env.CANVA_CLIENT_ID, redirectUri: uri, state, verifier }));
  });

  r.get(C.CALLBACK, async (req, res) => {
    if (!personOf(req)) return res.status(403).send('Signed-in leadership only.');
    const state = String(req.query.state || '');
    const code = String(req.query.code || '');
    if (req.query.error || !code) {
      const why = String(req.query.error_description || req.query.error || 'no code came back').slice(0, 300);
      return res.status(200).send(page('Canva sign-in not finished', `Canva said: ${why}. Open ${C.CONNECT_PAGE} to try again.`));
    }
    if (!/^CANVA\.[0-9a-f]{36}$/.test(state) || code.length > 4000) return res.status(400).send(page('Canva sign-in not finished', 'That sign-in link was not one this dashboard made.'));
    const got = await connects.setCode(state, code);
    if (!got) return res.status(200).send(page('Canva sign-in expired', `That sign-in is over an hour old or was already used. Open ${C.CONNECT_PAGE} to try again.`));
    res.status(200).send(page('Canva sign-in received', 'The Box finishes it on its next Archivist run (within 15 minutes). Nothing else to do here.'));
  });

  r.get('/api/canva/connects', async (req, res) => {
    if (!personOf(req)) return res.status(403).json({ error: 'Signed-in leadership only.' });
    res.json({ ready: !!env.CANVA_CLIENT_ID, read_on_box: 'CADET_CANVA_READ is set on the Box, not here', recent: await connects.recentConnects() });
  });

  return r;
}

module.exports = { createCanvaRouter };
