// ORDER #3581 (#3579 follow-on): the Concierge's Google reviews reach planning
// WHOLE, so a designer can confirm which event a review is about.
//
// Each review is taken from Google's API answer ITSELF, the same GET answer
// the Concierge already reads each morning (no second read of Google). It is
// never built from reviewRow() (that copy is cut at 600 characters with
// " [cut]" and has its line breaks folded, which is fine for a prompt and
// wrong for a stored review) and never from a reply card.
//
// Where it goes: planning's machine intake, POST /api/reviews-arrive/intake,
// Bearer REVIEW_FEED_WRITE_TOKEN (its own credential, write-only on planning's
// side, which keeps a review word for word and never replaces a kept one).
//
// FEATURE FLAG: REVIEW_FEED_TO_PLANNING default OFF ('on' sends; anything else
// sends nothing). Also needs PLANNING_REVIEW_FEED_URL and
// REVIEW_FEED_WRITE_TOKEN in the environment; the token is never written to
// this tree, never logged and never returned.
//
// 🔴 The Concierge's law is unchanged: every call to Google stays a GET
// (lib/gbp-reviews.js). This module's one POST goes only to a planning
// intake URL, checked before anything is sent. Nothing goes to a client.
'use strict';

const { STARS } = require('./gbp-reviews');

const SWITCH = 'REVIEW_FEED_TO_PLANNING';
const BATCH = 100; // planning's INTAKE_MAX
const INTAKE_PATH = '/api/reviews-arrive/intake';

function feedOn(env = process.env) {
  return String((env && env[SWITCH]) || '').trim().toLowerCase() === 'on';
}

// The day the review was posted, in Nashville (createTime is UTC).
function chicagoDay(t) {
  const d = new Date(t);
  if (!t || Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// One v4 review, exactly as Google gave it, in planning's intake shape.
function wholeReview(r, profileTitle) {
  return {
    source: 'google',
    source_review_id: r.reviewId || String(r.name || '').split('/').pop(),
    venue_name: String(profileTitle == null ? '' : profileTitle),
    posted_on: chicagoDay(r.createTime),
    reviewer_name: r.reviewer && typeof r.reviewer.displayName === 'string' ? r.reviewer.displayName : '',
    rating: STARS[r.starRating] || null,
    text: typeof r.comment === 'string' ? r.comment : '',
  };
}

function intakeUrlOk(u) {
  let url;
  try { url = new URL(String(u || '')); } catch (e) { return false; }
  if (url.pathname !== INTAKE_PATH || url.search || url.username || url.password) return false;
  if (/(^|\.)googleapis\.com$|(^|\.)google\.com$/i.test(url.hostname)) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

/**
 * profiles: [{ title, reviews: [raw v4 review, ...] }]
 * -> { ok, sent, refused: [{ source_review_id, why }], why? }
 * Never throws; a failure is a `why`, so the morning read is never broken.
 */
async function sendFeed({ profiles, env = process.env, fetchImpl = globalThis.fetch }) {
  if (!feedOn(env)) return { ok: false, off: true, why: `${SWITCH} is off` };
  const url = String((env && env.PLANNING_REVIEW_FEED_URL) || '').trim();
  const token = String((env && env.REVIEW_FEED_WRITE_TOKEN) || '').trim();
  if (!url || !token) return { ok: false, why: 'PLANNING_REVIEW_FEED_URL and REVIEW_FEED_WRITE_TOKEN must both be set on this machine' };
  if (!intakeUrlOk(url)) return { ok: false, why: `PLANNING_REVIEW_FEED_URL must be an https planning address ending ${INTAKE_PATH}` };
  const rows = [];
  for (const p of profiles || []) for (const r of (p && p.reviews) || []) rows.push(wholeReview(r, p.title));
  let sent = 0; const refused = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    let res; let body;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ reviews: chunk }) });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      return { ok: false, sent, refused, why: `planning could not be reached: ${String(e.message).slice(0, 120)}` };
    }
    if (!res.ok) return { ok: false, sent, refused, why: `planning answered ${res.status}` };
    sent += chunk.length;
    for (const x of (body && body.results) || []) if (x && x.result === 'refused') refused.push({ source_review_id: x.source_review_id, why: x.why || '' });
  }
  return { ok: true, sent, refused };
}

module.exports = { SWITCH, BATCH, INTAKE_PATH, feedOn, chicagoDay, wholeReview, intakeUrlOk, sendFeed };
