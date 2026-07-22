const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { looksLikeFleetToken, validateFleetToken } = require('../lib/fleet-tokens');
const SECRET = () => process.env.JWT_SECRET || 'dev-insecure-change-me';
function sign(payload){ return jwt.sign(payload, SECRET(), { expiresIn: '12h' }); }

// Human login gate for mint/list/revoke (JWT from /api/login).
function requireAuth(req, res, next){
  const h = req.headers.authorization;
  if(!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const token = h.split(' ')[1];
  if(looksLikeFleetToken(token)) return res.status(403).json({ error: 'A fleet token cannot manage tokens.' });
  try { req.user = jwt.verify(token, SECRET()); return next(); }
  catch(e){ return res.status(401).json({ error: 'Invalid or expired token' }); }
}

// Global gate: if a mkt_ fleet token is presented, validate it + enforce read-only.
// No token / non-fleet token → pass through (existing open dashboard behavior preserved).
async function fleetGate(req, res, next){
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if(!m) return next();
  const token = m[1].trim();
  if(!looksLikeFleetToken(token)) return next();
  if(!pool) return res.status(503).json({ error: 'token store not configured' });
  try {
    const p = await validateFleetToken(pool, token);
    if(!p) return res.status(401).json({ error: 'Invalid or revoked token' });
    if(req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return res.status(403).json({ error: 'Read-only — this token can only read.' });
    req.fleetClient = p; return next();
  } catch(e){ return res.status(401).json({ error: 'Invalid token' }); }
}
module.exports = { requireAuth, fleetGate, sign };
