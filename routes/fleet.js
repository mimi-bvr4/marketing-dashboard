const express = require('express');
const router = express.Router();
const { pool, hasDb } = require('../db');
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
