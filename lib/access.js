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

// ORDER #3070 (Mimi ruled B on credential-3051-marketing-zz-test-user,
// 11.06.2026 19:03 CT): "Build MKT_TEST_PERSON_IDS so the ZZ_TEST canary gets
// Katherine's role on the dashboard and exec routes still refuse it."
// FEATURE FLAG: MKT_TEST_PERSON_IDS default OFF (unset/empty admits nobody).
// Comma-separated People spine person ids, trimmed, blanks dropped, read at
// CALL time. A listed id gets exactly Katherine's seat: it is unioned with
// ALLOWED_PERSON_IDS here and nowhere else, so every exec check (rung 3, e.g.
// routes/agents.js isExec) still refuses it. It never raises a rung.
function testPersonIds() {
  return String(process.env.MKT_TEST_PERSON_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

// The one decision. Active staff, and exec or a named person id. Anything
// missing (no rung, no person id, a clearance lookup Dispatch could not do)
// is a no.
function isAllowed(who) {
  if (!who || who.active !== true) return false;
  if (Number(who.rung) >= EXEC_RUNG) return true;
  if (!who.person_id) return false;
  const id = String(who.person_id);
  return ALLOWED_PERSON_IDS.has(id) || testPersonIds().includes(id);
}

// ORDER #3165 (Mimi, 11.09.2026): "Mary gets a login to /handoff, plus a
// read-only view of Review for context." A SEAT, not the dashboard: a person
// listed here who is not otherwise allowed gets a session marked
// mkt_seat 'handoff', and middleware/page-gate.js lets that session reach ONLY
// HANDOFF_SEAT_PATHS below. Every other page and every other /api/ route (spend,
// HubSpot search, the Agents page, Review's buttons) answers 403 for it.
// Mary Topp, Director of Revenue Operations, by People spine person id.
const HANDOFF_SEAT_PERSON_IDS = new Set(['person_325956f2f429']);
const HANDOFF_SEAT = 'handoff';

// 'full' (exec or an allowed person id, unchanged), 'handoff', or null.
function seatOf(who) {
  if (isAllowed(who)) return 'full';
  if (who && who.active === true && who.person_id && HANDOFF_SEAT_PERSON_IDS.has(String(who.person_id))) return HANDOFF_SEAT;
  return null;
}

// What the hand-off seat may reach. GET-only on Review (read only, for
// context); the desk's own two buttons are the only POSTs.
const HANDOFF_SEAT_GET = new Set(['/handoff', '/handoff.html', '/api/handoff', '/review', '/review.html',
  '/api/review/cards', '/api/review/runs', '/api/review/handover', '/api/review/ai-tell-cards', '/review-ai-tell.js',
  '/favicon.ico', '/favicon-32.png', '/favicon-16.png', '/apple-touch-icon.png']);
const HANDOFF_SEAT_POST = new Set(['/api/handoff/assign', '/api/handoff/send-back']);
function handoffSeatMay(method, p) {
  const m = String(method || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return HANDOFF_SEAT_GET.has(p);
  if (m === 'POST') return HANDOFF_SEAT_POST.has(p);
  return false;
}

// The leadership page. No data, no sign-in form, no password box.
const DENIED_PAGE = `<!doctype html><meta charset="utf-8"><title>Marketing Dashboard</title>
<link rel="stylesheet" href="https://dispatch.infinityhospitalitygroup.com/ihg.css">
<body style="font-family:system-ui;max-width:420px;margin:12vh auto;padding:0 20px">
<h1 style="font-size:20px">Marketing Dashboard</h1>
<p style="color:#6D6E71;font-size:14px">${DENIED_MESSAGE}</p>
<p><a href="https://dispatch.infinityhospitalitygroup.com/hub">Back to the Hub</a></p>`;

module.exports = { isAllowed, testPersonIds, staffIdentity, canCheck, DENIED_MESSAGE, DENIED_PAGE,
                   EXEC_RUNG, KATHERINE_PERSON_ID, seatOf, handoffSeatMay, HANDOFF_SEAT, HANDOFF_SEAT_PERSON_IDS };
