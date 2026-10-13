// ORDER #1668: the Competitors page. Katherine's competitor sheet, the Scout's
// weekly read and a profile for every top competitor.
//
//   GET  /competitors                    the page
//   GET  /api/competitors                every competitor on the sheet (top first)
//   GET  /api/competitors/:site          one, with its profile and past versions
//   PUT  /api/competitors/:site/notes    { notes }  Katherine's own notes (fed to next week's profile)
//
// ACCESS: below the #654/#1370 page gate, signed-in leadership only
// (req.mktUser), same as Review and Katherine's Team. Read-only apart from the
// notes, which are recorded with who wrote them.
'use strict';

const express = require('express');
const path = require('path');
const { personOf } = require('./review');
const { checkSite } = require('../lib/agent-watch');

const PAGE = path.join(__dirname, '..', 'public', 'competitors.html');

const view = (c) => ({
  site: c.site, name: c.name, brands: c.brands || [], segments: c.segments || [], sheet_notes: c.sheet_notes || [],
  top: !!c.top, last_changes: c.last_changes || null, changes_at: c.changes_at || null,
  has_profile: !!c.profile_md, profile_version: c.profile_version || 0, profile_at: c.profile_at || null,
  kh_notes: c.kh_notes || null, kh_notes_by: c.kh_notes_by || null, kh_notes_at: c.kh_notes_at || null,
});

function createCompetitorsRouter({ store }) {
  const r = express.Router();
  const who = (req, res) => { const p = personOf(req); if (!p) res.status(403).json({ error: 'Signed-in leadership only.' }); return p; };
  const siteOf = (req, res) => { const s = checkSite(req.params.site); if (s.error) { res.status(400).json({ error: s.error }); return null; } return s.site; };

  r.get(['/competitors', '/competitors.html'], (req, res) => (personOf(req) ? res.sendFile(PAGE) : res.status(403).send('Signed-in leadership only.')));

  r.get('/api/competitors', async (req, res) => {
    if (!who(req, res)) return;
    const list = (await store.competitors()).map(view);
    res.json({ competitors: list, top: list.filter((c) => c.top).length });
  });

  r.get('/api/competitors/:site', async (req, res) => {
    if (!who(req, res)) return;
    const site = siteOf(req, res); if (!site) return;
    const c = await store.competitor(site);
    if (!c) return res.status(404).json({ error: 'not on the competitor list' });
    const versions = await store.profileVersions(site, 20);
    res.json({ competitor: view(c), profile_md: c.profile_md || null,
      versions: versions.map((v) => ({ version: v.version, created_at: v.created_at, profile_md: v.profile_md })) });
  });

  r.put('/api/competitors/:site/notes', async (req, res) => {
    const p = who(req, res); if (!p) return;
    const site = siteOf(req, res); if (!site) return;
    const out = await store.setKhNotes(site, (req.body || {}).notes, p);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json(out);
  });

  return r;
}

module.exports = { createCompetitorsRouter };
