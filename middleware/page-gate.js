// middleware/page-gate.js — the marketing dashboard's ONE gate.
//
// ORDER #654 built it (above express.static, so a cold navigate cannot be
// served index.html before any check runs). ORDER #661 moved it out of
// server.js unchanged, so the known-bads can drive THE REAL MIDDLEWARE through
// a real Express app instead of a copy of it. REPLY #657 §5 is the reason:
// a test that re-implements the thing it is testing grades its own copy, and
// a mutation that removes the guard passes.
//
const jwtLib = require('jsonwebtoken');
const SESSION_COOKIE = 'mkt_session';
const OPEN_PATHS = new Set([
  '/api/login', '/health', '/.well-known/agent-contract', '/api/contract',
  // ORDER #656: the cross-app SSO door. Both are part of getting a session, so
  // gating them would mean nobody arriving from the Hub could ever obtain one --
  // the same reason #652 left the Sales Brain's /sales/api/auth/sso open. The
  // verify route fails CLOSED (503) when DISPATCH_JWT_SECRET is unset, so an
  // open path here is not an open door.
  '/api/auth/sso-url', '/api/auth/sso', '/sso-complete.html',
]);

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function sessionUser(req) {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  const token = bearer || cookieToken(req);
  if (!token) return null;
  try { return jwtLib.verify(token, process.env.JWT_SECRET || 'dev-insecure-change-me'); }
  catch (e) { return null; }
}

// ORDER #661 item 3. The old copy said "Signed in to Infinity already? Use the
// Hub button" -- to a person who had JUST used the Hub button and landed here
// anyway. It told them to do the thing that had already failed, and it carried
// an em dash. This page is now only ever shown to someone dispatch does not
// know, or to someone whose automatic sign-in was refused, so it says that.
const SIGN_IN_PAGE = `<!doctype html><meta charset="utf-8"><title>Marketing Dashboard: sign in</title>
<link rel="stylesheet" href="https://dispatch.infinityhospitalitygroup.com/ihg.css">
<body style="font-family:system-ui;max-width:420px;margin:12vh auto;padding:0 20px">
<h1 style="font-size:20px">Marketing Dashboard</h1>
<p style="color:#6D6E71;font-size:14px">We could not sign you in from Infinity. Try again, or use the marketing password.</p>
<p><button onclick="sso()" style="padding:10px 16px">Continue with Infinity</button></p>
<p style="color:#6D6E71;font-size:13px">or sign in with the marketing password:</p>
<form onsubmit="go(event)"><input id="pw" type="password" placeholder="Password" style="width:100%;padding:10px;font-size:15px">
<button style="margin-top:10px;padding:10px 16px">Sign in</button></form>
<p id="err" style="color:#b00;font-size:13px"></p>
<script>async function sso(){const r=await fetch('/api/auth/sso-url');if(!r.ok){document.getElementById('err').textContent='Single sign-on is not configured on this deploy.';return;}location.href=(await r.json()).url;}
async function go(e){e.preventDefault();
 const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
 if(r.ok){location.reload();}else{document.getElementById('err').textContent=(await r.json()).error||'Sign in failed';}}</script>`;

// ORDER #661, on Mimi's ruling: "it should go straight to the marketing."
//
// WHAT SHE SAW: signed in to dispatch, clicked Marketing in the Hub, landed on
// a wall telling her to use the Hub button she had just used. Pressing
// "Continue with Infinity" then worked end to end with no Google screen. So
// #656's hand-off was never broken -- the route a human actually walks simply
// never triggered it. Same shape as the 09.11 #500 landmine: the mechanism
// proven, the supply on the real route not.
//
// THERE IS NO STOP NOW. An unauthenticated request for a PAGE is redirected
// straight into the bounce the button used to build, carrying `next` so the
// person lands on the page they asked for. Planning's unauthenticated visitor
// never sees a wall; this is that.
//
// 🔴 THE LOOP, AND WHY THE MARKER COOKIE IS NOT OPTIONAL. If dispatch does not
// know this person either, it returns them here with no token -- and an
// unconditional redirect would send them straight back, forever. The marker is
// set as we bounce and read before bouncing again, so the second cold arrival
// in a row gets the wall instead, once. /api/auth/sso expires it on success,
// which makes the guard self-healing rather than a one-shot.
//
// WHAT STILL NEVER REDIRECTS, each for its own reason:
//   * /api/*            an XHR cannot follow a cross-origin auth redirect in
//                       any useful way, and a 302 where JSON was expected is a
//                       worse failure than a 401. It keeps 401ing.
//   * OPEN_PATHS        the sign-in page's own fetches and the SSO completion
//                       page. Redirecting /sso-complete.html would bounce the
//                       person away from the page that is mid-sign-in.
//   * anything but GET  a POST cannot be replayed through a redirect; the body
//                       would be dropped silently.
const { ssoBounceUrl, hasBounceMarker, BOUNCE_MARKER } = require('../lib/sso');

function pageGate(req, res, next) {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.fleetClient) return next();          // a validated, read-only fleet token
  if (sessionUser(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method === 'GET' && !hasBounceMarker(req)) {
    const nextPath = req.originalUrl || req.path;
    res.setHeader('Set-Cookie',
      BOUNCE_MARKER + '=1; Path=/; Max-Age=300; SameSite=Lax'
      + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
    return res.redirect(302, ssoBounceUrl(nextPath));
  }
  return res.status(401).type('html').send(SIGN_IN_PAGE);
}

module.exports = { pageGate, sessionUser, cookieToken, OPEN_PATHS, SIGN_IN_PAGE,
                   SESSION_COOKIE };
