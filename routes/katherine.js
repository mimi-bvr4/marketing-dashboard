// ORDER #1717: Katherine's own dashboards, inside ours.
//
//   GET /her-numbers              the page (Spend, Leads, Followers, her Looker reports)
//   GET /api/her-numbers          the last nightly read of her two files
//
// ACCESS: below the #654/#1370 page gate (exec + Katherine only), and signed-in
// leadership only here too. Not on the fleet-key allow list (#1390), so a
// machine key never reads spend. Read-only: there is no write route.
'use strict';

const express = require('express');
const path = require('path');
const { personOf } = require('./review');
const { LOOKER_REPORTS, MASTER_XLSX_ID, FOLLOWERS_SHEET_ID } = require('../lib/katherine-files');

const PAGE = path.join(__dirname, '..', 'public', 'her-numbers.html');

const meta = (row) => (row ? { source_name: row.source_name, source_modified: row.source_modified, read_at: row.read_at } : null);

function createKatherineRouter({ store }) {
  const r = express.Router();

  r.get(['/her-numbers', '/her-numbers.html'], (req, res) => (personOf(req) ? res.sendFile(PAGE) : res.status(403).send('Signed-in leadership only.')));

  r.get('/api/her-numbers', async (req, res) => {
    if (!personOf(req)) return res.status(403).json({ error: 'Signed-in leadership only.' });
    const [master, followers] = await Promise.all([store.get('master'), store.get('followers')]);
    res.json({
      master: master ? { ...meta(master), blocks: master.payload.blocks } : null,
      followers: followers ? { ...meta(followers), ...followers.payload } : null,
      looker: LOOKER_REPORTS,
      files: {
        master: `https://drive.google.com/file/d/${MASTER_XLSX_ID}/view`,
        followers: `https://docs.google.com/spreadsheets/d/${FOLLOWERS_SHEET_ID}/edit`,
      },
    });
  });

  return r;
}

module.exports = { createKatherineRouter };
