// ORDER #3798 (Mimi, 11.24.2026): PR Patty runs ONCE a day, on the 3 HARO
// emails. All 3 arrive by 6 PM CT. She runs once, right after the third has
// landed, or at 6:15 PM CT if fewer arrive. No other scheduled runs.
//
// This file is the rule, pure and testable: the switch, the Nashville clock,
// how many HARO editions reached brain@ today, and the one decision. The job
// that acts on it is jobs/patty_evening.js (com.infinitybrain.pr-patty-evening).
//
// FEATURE FLAG: PATTY_EVENING_RUN default OFF. Off, nothing changes: Patty
// stays in the 06:00 run and the evening job does nothing. On (set in BOTH
// plists, marketing-agents and pr-patty-evening), the 06:00 run leaves Patty
// out and the evening job runs her once. Turning it on is Mimi's popup.
'use strict';

const FLAG = 'PATTY_EVENING_RUN';
const SLUG = 'pr-patty';
const HARO_EDITIONS = 3;
const FALLBACK = '18:15'; // 6:15 PM CT
// The producer_log "why" of the evening run starts with this, so a second fire
// the same day can see the first one (once a day, ran or failed).
const TAG = 'evening HARO run';

function eveningOn(env = process.env) {
  return /^(1|on|true|yes)$/i.test(String((env || {})[FLAG] || '').trim());
}

// The 06:00 run's list without Patty while the evening run owns her.
function withoutEveningAgents(slugs, env = process.env) {
  return eveningOn(env) ? slugs.filter((s) => s !== SLUG) : slugs;
}

function nashvilleYmd(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function nashvilleHm(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`;
}

// Seconds since 1970 at Nashville midnight starting that day (CST or CDT).
function chicagoMidnightEpoch(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  for (const h of [5, 6]) {
    const t = Date.UTC(y, m - 1, d, h);
    if (nashvilleHm(new Date(t)) === '00:00') return Math.floor(t / 1000);
  }
  throw new Error(`no Nashville midnight found for ${ymd}`);
}

// Gmail search for today's HARO editions (Nashville day).
function haroQuery(ymd) {
  return `after:${chicagoMidnightEpoch(ymd)} {haro "help a reporter"}`;
}

// One HARO edition, however many copies reached the inbox (the original and
// Katherine's forward count once). Subjects that are not HARO editions do not count.
function editionKey(subject) {
  const s = String(subject || '').replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!/\bharo\b|help a reporter/.test(s)) return null;
  return s;
}

function countEditions(subjects) {
  return new Set(subjects.map(editionKey).filter(Boolean)).size;
}

const mins = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

// The one decision. Pure.
function decide({ now = new Date(), editions, ranToday, countError = null }) {
  if (ranToday) return { run: false, why: 'already ran today (once a day)' };
  if (editions >= HARO_EDITIONS) return { run: true, why: `all ${HARO_EDITIONS} HARO emails are in` };
  const hm = nashvilleHm(now);
  const have = countError ? `HARO emails could not be counted (${countError})` : `${editions || 0} of ${HARO_EDITIONS} HARO emails in`;
  if (mins(hm) >= mins(FALLBACK)) return { run: true, why: `6:15 PM CT fallback: ${have}` };
  return { run: false, why: `waiting: ${have} at ${hm} CT; runs on the third or at 6:15 PM CT` };
}

function ranTodayFrom(rows) {
  return (rows || []).some((r) => r.agent === SLUG && String(r.why || '').startsWith(TAG));
}

module.exports = { FLAG, SLUG, HARO_EDITIONS, FALLBACK, TAG, eveningOn, withoutEveningAgents, nashvilleYmd, nashvilleHm,
  chicagoMidnightEpoch, haroQuery, editionKey, countEditions, decide, ranTodayFrom };
