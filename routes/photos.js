// ORDER #1241: the photo archive page (#1008 DO steps 4 and 5).
//
//   GET  /photos                 the page
//   GET  /api/photos?q=&<facet>= search + facet counts (the #1008 core's search)
//   GET  /photos/thumb/:id       the ~400px thumbnail, bytes from the DB
//   GET  /api/photos/:id         one photo
//   POST /api/photos/:id/tags    editors: { action: 'add' | 'remove', tag }
//   POST /api/photos/:id/rights  editors: { internal: true | false }
//
// 🔴 ACCESS, mounted BELOW the #654 page gate (so a signed-out hit on any of
// these already got the sign-in wall) and ABOVE express.static (so
// public/photos.html cannot be fetched around this check):
//   view = dispatch says the person holds 'marketing.photos' (#1194: the #659
//          page tick boxes, defaults Marketing, Sales, EC, ED-director, rung 3)
//   edit = view, plus rung 3 or the #659 'marketing.dashboard' grant. That is
//          Ruling 3 (09.29.2026): "Katherine, Sam and execs", the same rule
//          planning's Marketing tab uses. By person id and level, never by name.
//   The shared marketing password is view only: it is not a person, so there is
//   no one to record against an edit. A fleet token never reads photos.
//
// 🔴 RIGHTS are decided on every read, not trusted from the stored column, so
// Katherine's one-line flip in lib/photo-config.js takes effect without a
// re-crawl. Download and Copy link are offered ONLY when the state is cleared.
'use strict';

const express = require('express');
const path = require('path');
const A = require('../lib/photo-archive');
const { vocabFromRows, personTag } = require('../lib/photo-tagger');
const { rowsByDealId } = require('../lib/photo-sheet-rule');
const { VENUES_DEFAULT } = require('../lib/photo-config');
const { sessionUser } = require('../middleware/page-gate');

const PAGE = path.join(__dirname, '..', 'public', 'photos.html');
const MAX_LIMIT = 100;
const NO_ACCESS = { level: 'none' };

// ---------------------------------------------------------------- who

async function accessOf(req, identity) {
  if (req.fleetClient) return { ...NO_ACCESS, reason: 'a fleet token does not read photos' };
  const u = sessionUser(req);
  if (!u) return { ...NO_ACCESS, reason: 'not signed in' };
  if (u.role === 'admin') return { level: 'view', who: null, reason: 'marketing password: view only' };
  if (!u.email) return { ...NO_ACCESS, reason: 'this sign-in carries no email' };
  const id = await identity.lookup(u.email);
  if (!id.active || !id.person_id) return { ...NO_ACCESS, reason: id.reason || 'not active staff in dispatch' };
  const s = id.surface_access || {};
  if (s['marketing.photos'] !== true) return { ...NO_ACCESS, reason: 'no photo archive access' };
  const editor = Number(id.rung) >= 3 || s['marketing.dashboard'] === true;
  return { level: editor ? 'edit' : 'view', who: `person:${id.person_id}` };
}

// ---------------------------------------------------------------- rights

function effectiveRights(p, sheetRows, venuesDefault) {
  const top = String(p.folder_path || '').split(' / ')[0];
  if (p.deal_id && !p.manual_internal && !sheetRows) {
    return { state: 'unknown', reason: 'the marketing sheet is not connected to this page yet' };
  }
  return A.rightsFor({ topFolder: top, dealId: p.deal_id, rowsByDealId: sheetRows || {},
    manualInternal: !!p.manual_internal, venuesDefault });
}

const driveView = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
const driveDownload = (id) => `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;

// ---------------------------------------------------------------- the index

function assemble({ photos, tags, vocabRows, synonymRows }, sheetRows, venuesDefault) {
  const vocab = A.buildVocabulary(vocabFromRows(vocabRows, synonymRows));
  const byPhoto = new Map();
  for (const t of tags) {
    const e = byPhoto.get(t.drive_id) || { ai: [], added: [], removed: [] };
    if (t.source === 'ai') e.ai.push({ tag: t.tag, confidence: Number(t.confidence) || 0 });
    else if (t.source === 'human_add') e.added.push(t.tag);
    else if (t.source === 'human_remove') e.removed.push(t.tag);
    byPhoto.set(t.drive_id, e);
  }
  const list = [];
  const byId = new Map();
  let images = 0;
  let tagged = 0;
  for (const p of photos) {
    if (A.parsePath(String(p.folder_path || '').split(' / ')).excluded) continue;   // Staff Photos, twice over
    const t = byPhoto.get(p.drive_id) || { ai: [], added: [], removed: [] };
    const rights = effectiveRights(p, sheetRows, venuesDefault);
    const row = { ...p, id: p.drive_id, tagEdits: t, tags: A.finalTags(t), rights_state: rights.state, rights };
    if (p.kind === 'image') { images += 1; if (t.ai.length) tagged += 1; }
    list.push(row);
    byId.set(p.drive_id, row);
  }
  return { vocab, list, byId, progress: { tagged, total: images } };
}

function filtersFrom(query) {
  const filters = {};
  for (const f of A.FACETS) {
    const v = query[f];
    if (v == null || v === '') continue;
    filters[f] = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return filters;
}

function lite(p) {
  return { id: p.id, name: p.name, kind: p.kind, venue: p.venue, space: p.space, taken_date: p.taken_date,
    tags: p.tags, rights_state: p.rights.state, badge: A.BADGES[p.rights.state] || null,
    thumb_url: p.has_thumb ? `/photos/thumb/${encodeURIComponent(p.id)}` : null };
}

// ---------------------------------------------------------------- the router

function createPhotosRouter({ store, identity, sheet = async () => null, venuesDefault = VENUES_DEFAULT,
  cacheMs = 60 * 1000, now = () => Date.now(), log = console.error } = {}) {
  const router = express.Router();
  let memo = null;

  async function index() {
    if (memo && now() - memo.at < cacheMs) return memo.value;
    const [raw, tabs] = await Promise.all([store.loadIndex(), sheet()]);
    const sheetRows = tabs ? rowsByDealId(tabs).rowsByDealId : null;
    memo = { at: now(), value: assemble(raw, sheetRows, venuesDefault) };
    return memo.value;
  }
  const invalidate = () => { memo = null; };

  // Resolves req.photoAccess; refuses below `min`. HTML for the page, JSON for the rest.
  function gate(min, { html = false } = {}) {
    return async (req, res, next) => {
      let a;
      try { a = await accessOf(req, identity); } catch (e) { a = { ...NO_ACCESS, reason: 'access check failed' }; }
      req.photoAccess = a;
      if (a.level === 'none' || (min === 'edit' && a.level !== 'edit')) {
        const msg = min === 'edit' && a.level === 'view'
          ? 'Only marketing editors can change photos'
          : 'You do not have the photo archive. Ask an admin to tick "Photo archive" on your page access.';
        if (html) return res.status(403).type('html').send(`<!doctype html><meta charset="utf-8"><title>Photos</title>`
          + `<link rel="stylesheet" href="https://dispatch.infinityhospitalitygroup.com/ihg-tokens.css">`
          + `<body style="font-family:system-ui;max-width:460px;margin:12vh auto;padding:0 20px"><h1 style="font-size:20px">Photos</h1>`
          + `<p style="color:#6D6E71">${msg}</p>`);
        return res.status(403).json({ error: msg, access: a.level });
      }
      next();
    };
  }
  const fail = (res, e, what) => { log(`[photos] ${what}:`, e.message); res.status(500).json({ error: `Could not ${what}` }); };

  router.get('/photos.html', (req, res) => res.redirect(301, '/photos'));
  router.get('/photos', gate('view', { html: true }), (req, res) => res.sendFile(PAGE));

  router.get('/api/photos', gate('view'), async (req, res) => {
    try {
      const ix = await index();
      const prefix = String(req.query.path || '').trim();
      const pool = prefix
        ? ix.list.filter((p) => p.folder_path === prefix || String(p.folder_path).startsWith(`${prefix} / `))
        : ix.list;
      const { results, facets } = A.search(ix.vocab, pool, { q: req.query.q, filters: filtersFrom(req.query) });
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 60));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      res.json({ total: results.length, offset, limit, results: results.slice(offset, offset + limit).map(lite),
        facets, progress: ix.progress, access: req.photoAccess.level });
    } catch (e) { fail(res, e, 'search photos'); }
  });

  router.get('/photos/thumb/:id', gate('view'), async (req, res) => {
    try {
      const ix = await index();
      if (!ix.byId.has(req.params.id)) return res.status(404).end();
      const bytes = await store.getThumb(req.params.id);
      if (!bytes) return res.status(404).end();
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(bytes);
    } catch (e) { fail(res, e, 'read the thumbnail'); }
  });

  router.get('/api/photos/:id', gate('view'), async (req, res) => {
    try {
      const p = (await index()).byId.get(req.params.id);
      if (!p) return res.status(404).json({ error: 'No such photo' });
      const cleared = A.canDownload(p.rights.state);
      const segs = String(p.folder_path || '').split(' / ').filter(Boolean);
      const editor = req.photoAccess.level === 'edit';
      res.json({
        ...lite(p), folder_path: p.folder_path, month: p.month, season: p.season, year: p.year,
        event_type: p.event_type, event_class: p.event_class, setup: p.setup, guest_band: p.guest_band,
        orientation: p.orientation, width: p.width, height: p.height,
        breadcrumbs: segs.map((s, i) => ({ label: s, path: segs.slice(0, i + 1).join(' / ') })),
        rights: { state: p.rights.state, reason: p.rights.reason, badge: A.BADGES[p.rights.state] || null,
          internal_by_hand: !!p.manual_internal },
        drive_url: driveView(p.id),
        download_url: cleared ? driveDownload(p.id) : null,
        share_url: cleared ? driveView(p.id) : null,
        can_edit: editor,
        ...(editor ? { removed_tags: p.tagEdits.removed } : {}),
      });
    } catch (e) { fail(res, e, 'read the photo'); }
  });

  router.post('/api/photos/:id/tags', gate('edit'), async (req, res) => {
    try {
      const ix = await index();
      const p = ix.byId.get(req.params.id);
      if (!p) return res.status(404).json({ error: 'No such photo' });
      const action = req.body && req.body.action;
      const typed = String((req.body && req.body.tag) || '').trim().toLowerCase();
      if (!['add', 'remove'].includes(action)) return res.status(400).json({ error: 'action is add or remove' });
      if (!typed || typed.length > 40) return res.status(400).json({ error: 'a tag is 1 to 40 characters' });
      let tag = typed;
      if (action === 'add') {
        // The same screen the AI's tags go through, so a human cannot add what
        // the tagger is forbidden to: who a person is, or a consumable.
        if (personTag(typed)) return res.status(400).json({ error: 'Tags describe the room, not the people in it' });
        const screened = A.screenAiTags(ix.vocab, [{ tag: typed, confidence: 1 }]);
        if (!screened.tags.length) return res.status(400).json({ error: `Not a tag: ${screened.dropped[0] ? screened.dropped[0].why : 'refused'}` });
        tag = screened.tags[0].tag;
      } else {
        tag = A.canonicalTag(ix.vocab, typed) || p.tags.find((t) => A.norm(t) === A.norm(typed)) || typed;
      }
      await store.editTag(p.id, action, tag, req.photoAccess.who);
      invalidate();
      const after = A.finalTags(A.applyTagEdit(p.tagEdits, action, tag));
      res.json({ ok: true, tag, tags: after });
    } catch (e) { fail(res, e, 'save the tag'); }
  });

  router.post('/api/photos/:id/rights', gate('edit'), async (req, res) => {
    try {
      const p = (await index()).byId.get(req.params.id);
      if (!p) return res.status(404).json({ error: 'No such photo' });
      if (typeof (req.body && req.body.internal) !== 'boolean') return res.status(400).json({ error: 'internal is true or false' });
      await store.setInternal(p.id, req.body.internal, req.photoAccess.who);
      invalidate();
      res.json({ ok: true, internal: req.body.internal });
    } catch (e) { fail(res, e, 'save internal only'); }
  });

  return router;
}

module.exports = { createPhotosRouter, accessOf, effectiveRights, assemble };
