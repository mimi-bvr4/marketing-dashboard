// ORDER #1688: the Collateral Cadet's page. Katherine types a phrase; the Box
// searches every material on the Collateral Map it can read and our 11 public
// websites within 15 minutes, and the answer shows here with each place and the
// line quoted. "Post to the Change Log" opens Dispatch's /changes form already
// filled with those places; Katherine checks it and posts it herself.
//
//   GET  /cadet                 the page
//   GET  /api/cadet             the latest Collateral Map read + recent searches
//   GET  /api/cadet/asks/:id    one search with its full answer
//   POST /api/cadet/ask         { phrase }  -> queued for the Box
//
// ACCESS: below the #654/#1370 page gate, signed-in leadership only
// (req.mktUser), same as Review, Katherine's Team and Competitors. Nothing here
// edits a material, sends or publishes: step 2 (making the edits) needs Mimi's
// ruling.
'use strict';

const express = require('express');
const path = require('path');
const { personOf } = require('./review');
const { checkPhrase, changeLogPlaces } = require('../lib/cadet-search');

const PAGE = path.join(__dirname, '..', 'public', 'cadet.html');
const BUCKETS = ['marketing', 'menus'];
const MAX_PLACES = 40;

// Dispatch's Change Log form, filled from one search. The draft rides in the
// URL fragment, so it never reaches a server log; Dispatch's page reads it.
function changeLogUrl(result, { bucket = 'marketing', base = process.env.DISPATCH_BRIDGE_URL || 'https://dispatch.infinityhospitalitygroup.com' } = {}) {
  const found = (result.materials || []).filter((m) => m.status === 'FOUND');
  const sitePlaces = changeLogPlaces({ sites: result.sites });
  const draft = {
    from: 'cadet',
    bucket: BUCKETS.includes(bucket) ? bucket : 'marketing',
    title: `Change "${result.phrase}"`.slice(0, 160),
    before: result.phrase,
    collateral: found.map((m) => ({ company: m.company, title: m.title })),
    places: sitePlaces.slice(0, MAX_PLACES),
  };
  return `${String(base).replace(/\/$/, '')}/changes#submit?cadet=${encodeURIComponent(JSON.stringify(draft))}`;
}

function createCadetRouter({ store }) {
  const r = express.Router();
  const who = (req, res) => { const p = personOf(req); if (!p) res.status(403).json({ error: 'Signed-in leadership only.' }); return p; };

  r.get(['/cadet', '/cadet.html'], (req, res) => (personOf(req) ? res.sendFile(PAGE) : res.status(403).send('Signed-in leadership only.')));

  r.get('/api/cadet', async (req, res) => {
    if (!who(req, res)) return;
    const m = await store.map();
    res.json({ map: m ? { read_at: m.read_at, summary: m.summary } : null, asks: await store.asks(30) });
  });

  r.get('/api/cadet/asks/:id', async (req, res) => {
    if (!who(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad id' });
    const a = await store.ask(id);
    if (!a) return res.status(404).json({ error: 'no such search' });
    const out = { id: a.id, phrase: a.phrase, asked_by: a.asked_by, status: a.status, created_at: a.created_at, finished_at: a.finished_at, error: a.error, result: a.result || null };
    if (a.result) out.change_log = { marketing: changeLogUrl(a.result, { bucket: 'marketing' }), menus: changeLogUrl(a.result, { bucket: 'menus' }) };
    res.json(out);
  });

  r.post('/api/cadet/ask', async (req, res) => {
    const p = who(req, res); if (!p) return;
    const c = checkPhrase((req.body || {}).phrase);
    if (c.error) return res.status(400).json({ error: c.error });
    const out = await store.queueAsk(c.phrase, p);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ ask: out.ask });
  });

  return r;
}

module.exports = { createCadetRouter, changeLogUrl };
