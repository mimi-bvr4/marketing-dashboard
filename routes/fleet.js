const express = require('express');
const router = express.Router();
const { pool, hasDb } = require('../db');
const jwt = require('jsonwebtoken');
const { requireAuth, sign } = require('../middleware/auth');
// ORDER #654: named here so the gate in server.js and the login that satisfies
// it cannot drift apart on the cookie's name.
const SESSION_COOKIE_NAME = 'mkt_session';
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000,
                      secure: process.env.NODE_ENV === 'production' };
const { mintRaw } = require('../lib/fleet-tokens');
function baseUrl(req){
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}
router.get('/.well-known/agent-contract', (req, res) => {
  const base = baseUrl(req);
  let version = '1.0.0'; try { version = require('../package.json').version || version; } catch(_){}
  res.json({ name:'marketing-dashboard', version, contract_version:'v0',
    contract_url:`${base}/api/contract`, health_url:`${base}/health`,
    auth:{scheme:'bearer-v1',scope:'read'}, token_mint_url:`${base}/settings/api-tokens` });
});
router.get('/health', (req,res)=> res.json({ status:'ok', service:'marketing-dashboard' }));
router.get('/api/contract', (req,res)=>{
  const base = baseUrl(req);
  res.json({ service:'marketing-dashboard', contract_version:'v0',
    auth:{ scheme:'bearer-v1', scope:'read', how:'Bearer <mkt_… token>. Mint at '+base+'/settings/api-tokens (admin login). GET/HEAD/OPTIONS only, else 403.' },
    notes:'Read surface = marketing spend + GA4 revenue/session metrics. Write endpoints (POST) are refused to fleet tokens.',
    read_endpoints:[
      {method:'GET',path:'/health',desc:'Liveness.'},
      {method:'GET',path:'/api/spend',desc:'Marketing spend by source.'},
      {method:'GET',path:'/api/ga4/summary',desc:'GA4 revenue/sessions summary.'},
      {method:'GET',path:'/api/ga4/sessions',desc:'GA4 sessions detail.'} ] });
});
// simple admin login -> short-lived JWT (bearer) used by the mint page
// ═══════════════════════════════════════════════════════════════════════════
// ORDER #656 — CONSUME THE ESTATE'S EXISTING CROSS-APP SSO. NOT A NEW SCHEME.
// ═══════════════════════════════════════════════════════════════════════════
//
// Mimi: "we already talked about not having to do the google login between
// dispatch and planning last week... this is the same shape." She is right, and
// #654's reply was wrong to say the hand-off does not exist -- it exists
// estate-wide and marketing was simply never wired into it.
//
// THE MECHANISM, and all three pieces are copied from planning/sales-brain
// rather than invented:
//   1. GET  /api/auth/sso-url  -> the bounce. Points at dispatch's
//      /api/auth/google?return_to=<this app>/sso-complete.html. Dispatch checks
//      that origin against SSO_RETURN_TO_ORIGINS on the way in AND out.
//   2. public/sso-complete.html -> dispatch lands here with the token in the URL
//      FRAGMENT; the page POSTs it to (3).
//   3. POST /api/auth/sso      -> verifies the DISPATCH-signed token and mints
//      this app's own session cookie.
//
// 🔴 TWO SECRETS, NOT ONE, AND DELIBERATELY SO. planning verifies dispatch's
// token with its OWN JWT_SECRET, which means the two apps must share one secret
// and the secret that signs a local session is the same one that vouches for a
// remote identity. The Sales Brain kept them separate (DISPATCH_JWT_SECRET) and
// that is the shape copied here: JWT_SECRET still signs THIS app's session,
// DISPATCH_JWT_SECRET only ever verifies dispatch's. Rotating one does not
// silently widen the other.
//
// FAILS CLOSED, never open: with DISPATCH_JWT_SECRET unset this route returns
// 503 and nothing is trusted -- the same refusal the Sales Brain's does, so an
// unconfigured deploy cannot quietly accept an unverifiable token.
//
// WHAT MIMI MUST SET (named, not invented, and not settable from here):
//   * DISPATCH_JWT_SECRET on the marketing-dashboard service, equal to
//     dispatch's own JWT_SECRET
//   * https://marketing.infinityhospitalitygroup.com on dispatch's
//     SSO_RETURN_TO_ORIGINS -- without it dispatch silently DROPS the return_to
//     and the user lands on dispatch's own page instead of coming back here
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL
  || 'https://marketing.infinityhospitalitygroup.com').replace(/\/$/, '');
const DISPATCH_BASE = (process.env.DISPATCH_BRIDGE_URL
  || 'https://dispatch.infinityhospitalitygroup.com').replace(/\/$/, '');

function isSameOriginPath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//');
}

router.get('/api/auth/sso-url', (req, res) => {
  // 🔴 BUILT FROM THE PINNED PUBLIC BASE URL, NEVER req.hostname. planning's
  // equivalent uses `https://${req.hostname}` and ORDER #634 exists because of
  // exactly that defect -- a link that becomes whichever host the browser
  // happened to be on. #634 deliberately left planning's alone because the
  // allowlist did not yet carry the custom domain; this one is new, so it does
  // not inherit the problem.
  const next = req.query.next;
  const suffix = isSameOriginPath(next) ? ('?next=' + encodeURIComponent(next)) : '';
  const returnTo = PUBLIC_BASE_URL + '/sso-complete.html' + suffix;
  const url = DISPATCH_BASE + '/api/auth/google?return_to=' + encodeURIComponent(returnTo);
  res.json({ url });
});

router.post('/api/auth/sso', (req, res) => {
  const secret = process.env.DISPATCH_JWT_SECRET;
  if (!secret) return res.status(503).json({ error: 'SSO not configured on this deploy' });
  const token = String((req.body && req.body.token) || '');
  if (!token) return res.status(400).json({ error: 'token required' });
  let claims;
  try { claims = jwt.verify(token, secret); }
  catch (e) { return res.status(401).json({ error: 'Invalid or expired token' }); }
  if (!claims || !claims.email) {
    return res.status(401).json({ error: 'Token carries no identity to accept' });
  }
  // The session this mints is THIS app's own, signed with THIS app's secret.
  const session = sign({ role: 'sso', name: claims.name || claims.email, email: claims.email });
  res.setHeader('Set-Cookie', SESSION_COOKIE_NAME + '=' + encodeURIComponent(session)
    + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200'
    + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
  res.json({ ok: true, name: claims.name || claims.email, email: claims.email });
});

router.post('/api/login', (req,res)=>{
  const pw = String((req.body && req.body.password) || '');
  const expected = process.env.MARKETING_ADMIN_PASSWORD;
  if(!expected) return res.status(503).json({ error: 'Login not configured (set MARKETING_ADMIN_PASSWORD).' });
  if(pw !== expected) return res.status(401).json({ error: 'Wrong password' });
  // ORDER #654: the same JWT also goes into an httpOnly cookie, because a
  // browser NAVIGATING to the dashboard page cannot send an Authorization
  // header. The header path is unchanged for the token-admin page's fetches.
  const token = sign({ role:'admin', name:'marketing-admin' });
  res.cookie
    ? res.cookie(SESSION_COOKIE_NAME, token, COOKIE_OPTS)
    : res.setHeader('Set-Cookie', SESSION_COOKIE_NAME + '=' + encodeURIComponent(token)
        + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200'
        + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
  res.json({ token });
});
router.post('/api/tokens', requireAuth, async (req,res)=>{
  if(!hasDb) return res.status(503).json({ error:'Token store not configured (add a Postgres + DATABASE_URL).' });
  try{
    const label = (req.body && typeof req.body.label==='string' && req.body.label.trim()) ? req.body.label.trim().slice(0,120) : null;
    const { raw, hash, display } = mintRaw();
    const r = await pool.query(`INSERT INTO api_tokens (token_hash,token_prefix,label,created_by,scope) VALUES ($1,$2,$3,$4,'read') RETURNING id,created_at`,
      [hash, display, label, (req.user&&req.user.name)||'admin']);
    res.json({ id:r.rows[0].id, token:raw, label, scope:'read', created_at:r.rows[0].created_at, warning:'Copy this now — it will never be shown again.' });
  }catch(e){ res.status(500).json({ error:'Could not mint token' }); }
});
router.get('/api/tokens', requireAuth, async (req,res)=>{
  if(!hasDb) return res.status(503).json({ error:'Token store not configured.' });
  try{ const { rows } = await pool.query('SELECT id,token_prefix,label,created_by,scope,created_at,last_used_at,revoked_at FROM api_tokens ORDER BY created_at DESC'); res.json(rows); }
  catch(e){ res.status(500).json({ error:'Could not list tokens' }); }
});
router.post('/api/tokens/:id/revoke', requireAuth, async (req,res)=>{
  if(!hasDb) return res.status(503).json({ error:'Token store not configured.' });
  try{ const r = await pool.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id',[req.params.id]); res.json({ revoked:r.rowCount>0, id:Number(req.params.id) }); }
  catch(e){ res.status(500).json({ error:'Could not revoke token' }); }
});
module.exports = router;
