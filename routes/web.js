// ORDER #1873: the Web Agent page. Katherine uploads one HTML file (plus its
// photos, each marked cleared or not), picks the site and either an existing
// page or "new page", and the Box builds a WordPress DRAFT within 15 minutes.
// The card lands on her Review tab.
//
//   GET  /web                               the page
//   GET  /api/web                           sites, the publish switch, recent uploads
//   GET  /api/web/pages?site=&q=            that site's published pages (public REST, no credential)
//   POST /api/web/requests                  { site, page_id | new_title, html, assets: [{ name, type, data, cleared }] }
//   GET  /api/web/requests/:id              one upload with its result and its write log
//   GET  /api/web/requests/:id/shot/:which/:size   before|after, mobile|desktop (PNG)
//   POST /api/web/requests/:id/publish      REFUSED while the switch is OFF (logged)
//
// ACCESS: below the #654/#1370 page gate, signed-in leadership only. Railway
// holds no WordPress credential: nothing here writes to a site.
'use strict';

const express = require('express');
const path = require('path');
const { personOf } = require('./review');
const W = require('../lib/web-wp');
const P = require('../lib/web-publish');

const PAGE = path.join(__dirname, '..', 'public', 'web.html');
const MAX_HTML = 2 * 1024 * 1024;
const MAX_ASSETS = 12;
const MAX_ASSET_B64 = 8 * 1024 * 1024;
const BODY_LIMIT = '40mb';

function checkRequest(b) {
  const s = W.siteOf(b.site);
  if (!s) return { error: 'Pick a site.' };
  if (s.squarespace) return { error: `${s.domain} is a Squarespace site; it has no page API, so the Box cannot build a draft there. Paste it in Squarespace by hand.` };
  const pageId = b.page_id === undefined || b.page_id === null || b.page_id === '' ? null : Number(b.page_id);
  const title = String(b.new_title || '').replace(/\s+/g, ' ').trim();
  if (pageId !== null && (!Number.isInteger(pageId) || pageId < 1)) return { error: 'That page id is not a number.' };
  if ((pageId === null) === !title) return { error: 'Pick an existing page or give the new page a title (one, not both).' };
  if (title.length > 150) return { error: 'The title is longer than 150 characters.' };
  const html = String(b.html || '');
  if (!/<[a-z!]/i.test(html)) return { error: 'Upload an HTML file.' };
  if (html.length > MAX_HTML) return { error: 'The HTML file is over 2 MB.' };
  const assets = Array.isArray(b.assets) ? b.assets : [];
  if (assets.length > MAX_ASSETS) return { error: `Up to ${MAX_ASSETS} photos per page.` };
  const clean = [];
  for (const a of assets) {
    const name = String((a && a.name) || '').split(/[\\/]/).pop().slice(0, 120);
    if (!name) return { error: 'A photo has no file name.' };
    if (!W.IMAGE_TYPES[a.type]) return { error: `${name}: only JPG, PNG, WebP or GIF photos.` };
    if (typeof a.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(a.data) || a.data.length > MAX_ASSET_B64) return { error: `${name}: the file is empty or over 6 MB.` };
    clean.push({ name, type: a.type, data: a.data, cleared: a.cleared === true });
  }
  return { request: { site: s.code, page_id: pageId, new_title: pageId ? null : title, html, assets: clean } };
}

function createWebRouter({ store, env = process.env, fetchImpl = globalThis.fetch }) {
  const r = express.Router();
  const who = (req, res) => { const p = personOf(req); if (!p) res.status(403).json({ error: 'Signed-in leadership only.' }); return p; };
  const idOf = (req, res) => { const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: 'bad id' }); return null; } return id; };

  r.get(['/web', '/web.html'], (req, res) => (personOf(req) ? res.sendFile(PAGE) : res.status(403).send('Signed-in leadership only.')));

  r.get('/api/web', async (req, res) => {
    if (!who(req, res)) return;
    res.json({
      sites: Object.entries(W.SITES).map(([code, s]) => ({ code, name: s.name, domain: s.domain })),
      squarespace: Object.entries(W.SQUARESPACE).map(([code, domain]) => ({ code, domain })),
      publish: P.publishOn(env) ? 'on' : 'off',
      requests: await store.list(30),
    });
  });

  r.get('/api/web/pages', async (req, res) => {
    if (!who(req, res)) return;
    const out = await W.publicPages(req.query.site, req.query.q, fetchImpl).catch((e) => ({ error: e.message }));
    if (out.error) return res.status(502).json(out);
    res.json(out);
  });

  r.post('/api/web/requests', express.json({ limit: BODY_LIMIT }), async (req, res) => {
    const p = who(req, res); if (!p) return;
    const c = checkRequest(req.body || {});
    if (c.error) return res.status(400).json({ error: c.error });
    const out = await store.queue(c.request, p);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json({ request: out.request });
  });

  r.get('/api/web/requests/:id', async (req, res) => {
    if (!who(req, res)) return; const id = idOf(req, res); if (!id) return;
    const x = await store.get(id);
    if (!x) return res.status(404).json({ error: 'no such upload' });
    const { html, assets, result, ...rest } = x;
    const shots = result && result.shots ? { before: !!result.shots.before, after: !!result.shots.after, why: result.shots.why || null } : null;
    res.json({ request: { ...rest, assets: (assets || []).map((a) => ({ name: a.name, cleared: a.cleared })), result: result ? { ...result, shots } : null }, log: await store.logs(id), publish: P.publishOn(env) ? 'on' : 'off' });
  });

  r.get('/api/web/requests/:id/shot/:which/:size', async (req, res) => {
    if (!who(req, res)) return; const id = idOf(req, res); if (!id) return;
    if (!['before', 'after'].includes(req.params.which) || !['mobile', 'desktop'].includes(req.params.size)) return res.status(400).json({ error: 'bad shot' });
    const x = await store.get(id);
    const b64 = x && x.result && x.result.shots && x.result.shots[req.params.which] && x.result.shots[req.params.which][req.params.size];
    if (!b64) return res.status(404).json({ error: 'no such screenshot' });
    res.type('png').send(Buffer.from(b64, 'base64'));
  });

  r.post('/api/web/requests/:id/publish', async (req, res) => {
    const p = who(req, res); if (!p) return; const id = idOf(req, res); if (!id) return;
    const x = await store.get(id);
    if (!x) return res.status(404).json({ error: 'no such upload' });
    if (!P.publishOn(env)) {
      await store.log({ request_id: id, site: x.site, action: 'publish refused', post_id: x.result && x.result.draft_id, detail: 'switch OFF', who: p });
      return res.status(409).json(P.refusal());
    }
    const q = await store.requestPublish(id, p);
    if (!q) return res.status(409).json({ error: 'Only a finished draft can be published.' });
    await store.log({ request_id: id, site: x.site, action: 'publish requested', post_id: x.result && x.result.draft_id, who: p });
    res.json({ queued: true });
  });

  return r;
}

module.exports = { createWebRouter, checkRequest, BODY_LIMIT };
