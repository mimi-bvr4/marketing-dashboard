// lib/session_life.js: ORDER #1318 (10.05.2026). How long a Marketing
// sign-in through Infinity lasts.
//
// REPLY #1314 found Marketing was one of the two places on the main nav that
// still sent a person through Google: /api/auth/sso minted a fixed 12-hour
// mkt_session and nothing ever renewed it, so the next morning was a Google
// round trip.
//
// Mimi ruled the answer on 09.27.2026 (RULINGS_LEDGER, #927) and planning got
// it in #933 (planning server/auth.js renewIfDue). This is that shape here:
//   * an SSO sign-in lasts SESSION_DAYS;
//   * once it is RENEW_AFTER_MS old it is renewed only after Dispatch's
//     /api/brain/portal/staff-identity says the person is active staff, and
//     ended if Dispatch answers without saying so;
//   * a Dispatch blip keeps it unrenewed: never extended, never ended;
//   * where the check can never run (no DISPATCH_BRIDGE_TOKEN on this
//     service, or a session with no email) the session is the 12 hours it was
//     on main. A longer session with no offboarding check is longer access
//     after someone leaves, and nobody ruled for that.
//
// Only the SSO session (role 'sso', in the mkt_session cookie) is touched.
// The marketing-password session and the Bearer header path keep their own
// 12 hours, unchanged. No change to who can sign in.
const jwt = require('jsonwebtoken');
const { dispatchBase } = require('./sso');

const SESSION_COOKIE = 'mkt_session';
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 12 * 60 * 60 * 1000;
const FALLBACK_MS = 12 * 60 * 60 * 1000;   // main's life, when the check cannot run

const SECRET = () => process.env.JWT_SECRET || 'dev-insecure-change-me';

// Read at CALL time so a test can set it without re-requiring. The same name
// planning uses for the same thing (= BRAIN_BRIDGE_TOKEN on Dispatch).
function canCheck(email) {
  return !!email && !!process.env.DISPATCH_BRIDGE_TOKEN;
}

function cookieFor(token, maxAgeMs) {
  return SESSION_COOKIE + '=' + encodeURIComponent(token)
    + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(maxAgeMs / 1000)
    + (process.env.NODE_ENV === 'production' ? '; Secure' : '');
}

// The SSO session's token and its Set-Cookie line, together, so the JWT and
// the cookie can never disagree about how long it lasts.
function issueSso(claims) {
  const life = canCheck(claims.email) ? SESSION_MS : FALLBACK_MS;
  const token = jwt.sign({ role: 'sso', name: claims.name || claims.email, email: claims.email },
    SECRET(), { expiresIn: Math.floor(life / 1000) });
  return { token, cookie: cookieFor(token, life) };
}

async function staffIdentity(email) {
  const url = dispatchBase() + '/api/brain/portal/staff-identity?email='
    + encodeURIComponent(String(email).trim().toLowerCase());
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.DISPATCH_BRIDGE_TOKEN } });
  if (!r.ok) throw new Error('staff-identity answered ' + r.status);
  return r.json();
}

// What happened, for the gate and the tests:
//   'fresh'   younger than RENEW_AFTER_MS, nothing asked, nothing written;
//   'renewed' Dispatch says active, a new 30-day mkt_session was appended;
//   'ended'   the cookie is cleared: Dispatch answered without saying active,
//             or the check can never run here (the 12-hour life of main);
//   'kept'    Dispatch could not be asked: not renewed, not ended.
// Never throws: the gate is Express 4 middleware, and a rejected promise there
// hangs the request.
async function renewIfDue(res, claims) {
  try {
    const ageMs = Date.now() - Number(claims.iat || 0) * 1000;
    if (ageMs < RENEW_AFTER_MS) return 'fresh';
    if (!canCheck(claims.email)) {
      res.append('Set-Cookie', SESSION_COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax');
      return 'ended';
    }
    let who;
    try {
      who = await staffIdentity(claims.email);
    } catch (err) {
      console.warn('[auth] #1318 staff check failed, session kept unrenewed: ' + err.message);
      return 'kept';
    }
    if (!who || who.active !== true) {
      res.append('Set-Cookie', SESSION_COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax');
      console.warn('[auth] #1318 session ended at renewal: Dispatch does not list this person as active staff.');
      return 'ended';
    }
    res.append('Set-Cookie', issueSso(claims).cookie);
    return 'renewed';
  } catch (err) {
    console.warn('[auth] #1318 renewal skipped: ' + err.message);
    return 'kept';
  }
}

module.exports = { issueSso, renewIfDue, canCheck, SESSION_COOKIE, SESSION_DAYS, SESSION_MS, RENEW_AFTER_MS };
