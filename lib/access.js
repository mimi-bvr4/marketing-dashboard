// lib/access.js: ORDER #1370 (10.06.2026). WHO MAY OPEN THE MARKETING DASHBOARD.
//
// Mimi, 10.06.2026 (popup on the V046 record): "any signed in staff should not
// be able to reach the marketing dashboard, its exec only and katherine."
//
// Before this, ANY Infinity sign-in that Dispatch would vouch for got a
// session here, and the marketing password got one with no identity at all.
// /api/spend carries a named person's salary row, so that was an iron-rule
// exposure, not a preference.
//
// THE RULE, answered by Dispatch, never by a name string:
//   * exec: rung 3 on Dispatch's clearance ladder (the Exec bundle; the same
//     rung the Hub's exec cards and the marketing.dashboard floor use), or
//   * Katherine Howe, by her People spine person id.
// Dispatch's /api/brain/portal/staff-identity answers both (rung, person_id)
// for one email, behind DISPATCH_BRIDGE_TOKEN. It is the same call #1318's
// renewal already makes, so this adds no new door and no new secret.
//
// The #659 bundle grant (surface_access['marketing.dashboard']) is NOT used:
// it also admits every other Marketing-bundle seat, which is what the ruling
// takes away.
const { dispatchBase } = require('./sso');

const EXEC_RUNG = 3;
// Katherine Howe (Marketing & PR Director). Dispatch: scripts/order1211-preferred-headshots.js
// and server/lib/brain-section-tiers.js both carry this id for her.
const KATHERINE_PERSON_ID = 'person_57d0eb01e923';
const ALLOWED_PERSON_IDS = new Set([KATHERINE_PERSON_ID]);

const DENIED_MESSAGE = 'This dashboard is for Marketing leadership.';

// Read at CALL time so a test can set it without re-requiring.
function canCheck(email) {
  return !!email && !!process.env.DISPATCH_BRIDGE_TOKEN;
}

async function staffIdentity(email) {
  const url = dispatchBase() + '/api/brain/portal/staff-identity?email='
    + encodeURIComponent(String(email).trim().toLowerCase());
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.DISPATCH_BRIDGE_TOKEN } });
  if (!r.ok) throw new Error('staff-identity answered ' + r.status);
  return r.json();
}

// The one decision. Active staff, and exec or a named person id. Anything
// missing (no rung, no person id, a clearance lookup Dispatch could not do)
// is a no.
function isAllowed(who) {
  if (!who || who.active !== true) return false;
  if (Number(who.rung) >= EXEC_RUNG) return true;
  return !!who.person_id && ALLOWED_PERSON_IDS.has(String(who.person_id));
}

// The leadership page. No data, no sign-in form, no password box.
const DENIED_PAGE = `<!doctype html><meta charset="utf-8"><title>Marketing Dashboard</title>
<link rel="stylesheet" href="https://dispatch.infinityhospitalitygroup.com/ihg.css">
<body style="font-family:system-ui;max-width:420px;margin:12vh auto;padding:0 20px">
<h1 style="font-size:20px">Marketing Dashboard</h1>
<p style="color:#6D6E71;font-size:14px">${DENIED_MESSAGE}</p>
<p><a href="https://dispatch.infinityhospitalitygroup.com/hub">Back to the Hub</a></p>`;

module.exports = { isAllowed, staffIdentity, canCheck, DENIED_MESSAGE, DENIED_PAGE,
                   EXEC_RUNG, KATHERINE_PERSON_ID };
