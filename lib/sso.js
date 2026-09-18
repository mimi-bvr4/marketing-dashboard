// lib/sso.js — ORDER #661 (09.18.2026). THE ONE BOUNCE URL BUILDER.
//
// It was inline in routes/fleet.js, which is mounted BELOW the gate, so the
// gate could not reach it. The order's constraint is explicit -- "reuse the
// existing bounce URL builder, no second SSO scheme" -- so it moves here and
// fleet.js requires it. Same string, one definition, two callers.
//
// 🔴 BUILT FROM THE PINNED PUBLIC BASE URL, NEVER req.hostname. ORDER #634
// exists because a link built from whatever host the browser happened to be on
// sent a vendor a railway.app address. The lookup is done at CALL time, not at
// module load, so a test can set the variable without re-requiring the module.
function publicBase() {
  return (process.env.PUBLIC_BASE_URL
    || 'https://marketing.infinityhospitalitygroup.com').replace(/\/$/, '');
}

function dispatchBase() {
  return (process.env.DISPATCH_BRIDGE_URL
    || 'https://dispatch.infinityhospitalitygroup.com').replace(/\/$/, '');
}

// A `next` is only carried when it is a path on THIS origin. An absolute URL,
// a protocol-relative `//evil.example`, or anything that is not a string is
// dropped rather than rejected -- the person still lands, just on the root.
function isSameOriginPath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//');
}

// ORDER #661 item 2's loop guard, and it is the whole reason this is safe to
// do automatically. If dispatch bounces someone back without a session -- they
// are not signed in to dispatch at all -- an automatic redirect would send them
// straight back to dispatch, forever. The marker cookie is #500's shape: set
// when we bounce, read before we bounce again, so the SECOND arrival in a row
// shows the wall instead. Cleared by /api/auth/sso on success.
const BOUNCE_MARKER = 'mkt_sso_tried';

function ssoBounceUrl(nextPath) {
  const suffix = isSameOriginPath(nextPath) ? ('?next=' + encodeURIComponent(nextPath)) : '';
  const returnTo = publicBase() + '/sso-complete.html' + suffix;
  return dispatchBase() + '/api/auth/google?return_to=' + encodeURIComponent(returnTo);
}

// Read off the raw Cookie header, never req.cookies: this app mounts no cookie
// parser, and #500's landmine was a guard that read a parser that was not
// there and therefore never saw the marker it was checking for.
function hasBounceMarker(req) {
  const raw = (req && req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const [k] = part.trim().split('=');
    if (k === BOUNCE_MARKER) return true;
  }
  return false;
}

module.exports = { ssoBounceUrl, isSameOriginPath, hasBounceMarker, BOUNCE_MARKER,
                   publicBase, dispatchBase };
