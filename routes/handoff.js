// ORDER #3165: the Sales Hand-off desk, Mary Topp's queue.
//
//   GET  /handoff                   the page
//   GET  /api/handoff               { on, waiting_line, batches, roster, can_pick }
//   POST /api/handoff/assign        { card_ids: [..], owner_id } one salesperson for these leads
//   POST /api/handoff/send-back     { card_ids: [..], note }     back to Katherine's Drafts
//
// WHO: everyone past the page gate may LOOK (exec, Katherine, and Mary's
// hand-off seat, lib/access.js). Only Mary (by her People person id) or an
// exec (rung 3: Mimi, Kevin) may assign or send back, asked of Dispatch per
// press, never read from the page.
//
// WHAT AN ASSIGN DOES: it writes Mary's pick on the card, nothing else. The
// Box's hand-off job (jobs/agent_handoff.js) then sends it down the existing
// #2940/#3012 path to that owner id, once (the card is claimed before any
// HubSpot call). The owner id must be a PICKABLE entry of the live roster at
// the moment of the press: never free text, never a name.
'use strict';

const express = require('express');
const path = require('path');
const desk = require('../lib/mary-desk');
const { createRosterReader } = require('../lib/sales-roster');

const PAGE = path.join(__dirname, '..', 'public', 'handoff.html');
const MAX_IDS = 100;

function personOf(req) {
  const u = req.mktUser;
  return u && u.email ? { email: String(u.email).toLowerCase(), name: u.name || u.email } : null;
}

async function canPick(req, identity) {
  const me = personOf(req);
  if (!me || !identity) return false;
  const who = await identity.lookup(me.email);
  if (!who || who.active !== true) return false;
  return Number(who.rung) >= 3 || who.person_id === desk.MARY_PERSON_ID;
}

function ids(body) {
  const list = Array.isArray(body && body.card_ids) ? body.card_ids : [];
  const out = [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return out.length && out.length <= MAX_IDS ? out : null;
}

function createHandoffRouter({ store, identity, roster = createRosterReader(), env = process.env, now = () => new Date() }) {
  const r = express.Router();
  const need = (req, res, next) => (personOf(req) ? next() : res.status(403).json({ error: 'Signed-in staff only.' }));
  const needPicker = async (req, res, next) => {
    if (!desk.on(env)) return res.status(409).json({ error: `The Sales Hand-off desk is off (${desk.FLAG}=off), so nothing is assigned here.` });
    return (await canPick(req, identity)) ? next() : res.status(403).json({ error: 'Only Mary Topp or an exec picks the salesperson.' });
  };

  r.get(['/handoff', '/handoff.html'], (req, res) => (personOf(req) ? res.sendFile(PAGE) : res.status(403).send('Signed-in staff only.')));

  r.get('/api/handoff', need, async (req, res) => {
    const names = new Map((store.profiles ? await store.profiles() : []).filter((p) => p.display_name).map((p) => [p.agent, p.display_name]));
    const list = desk.batches(await store.handoffDesk(), { names });
    const ros = await roster();
    res.json({ on: desk.on(env), flag: desk.FLAG, waiting_line: desk.waitingLine(list) || 'Nothing is waiting for a salesperson.',
      batches: list, roster: ros.people, roster_note: ros.why, roster_where: ros.where, can_pick: await canPick(req, identity) });
  });

  r.post('/api/handoff/assign', need, needPicker, async (req, res) => {
    const cardIds = ids(req.body);
    if (!cardIds) return res.status(400).json({ error: `pass card_ids, 1 to ${MAX_IDS} card numbers` });
    const ownerId = String((req.body || {}).owner_id || '').trim();
    if (!/^\d{1,20}$/.test(ownerId)) return res.status(400).json({ error: 'Pick a salesperson from the list.' });
    const ros = await roster({ fresh: true });
    const pick = ros.people.find((p) => p.owner_id === ownerId);
    if (!pick) return res.status(400).json({ error: 'That salesperson is not on the live list.' });
    if (!pick.pickable) return res.status(400).json({ error: `${pick.name} cannot be picked: ${pick.why}` });
    const rec = desk.assignRecord(pick, personOf(req), now().toISOString());
    const results = [];
    for (const id of cardIds) {
      const c = await store.assignCard(id, rec);
      results.push(c ? { card_id: id, ok: true, line: desk.leadState(c).line }
        : { card_id: id, ok: false, why: 'Not waiting on Mary: already assigned, sent back, handed off, or not an approved sales card. Nothing changed.' });
    }
    const status = results.some((x) => x.ok) ? 200 : 409;
    res.status(status).json({ assigned_to: { name: pick.name, owner_id: pick.owner_id }, results });
  });

  r.post('/api/handoff/send-back', need, needPicker, async (req, res) => {
    const cardIds = ids(req.body);
    if (!cardIds) return res.status(400).json({ error: `pass card_ids, 1 to ${MAX_IDS} card numbers` });
    const note = String((req.body || {}).note || '').trim();
    if (note.length < 3) return res.status(400).json({ error: 'Say why it is going back to Katherine.' });
    const rec = desk.sendBackRecord(note, personOf(req), now().toISOString());
    const results = [];
    for (const id of cardIds) {
      const c = await store.sendBackCard(id, rec);
      results.push(c ? { card_id: id, ok: true } : { card_id: id, ok: false, why: 'Not waiting on Mary, so it was not sent back. Nothing changed.' });
    }
    res.status(results.some((x) => x.ok) ? 200 : 409).json({ results });
  });
  return r;
}

module.exports = { createHandoffRouter, canPick, MAX_IDS };
