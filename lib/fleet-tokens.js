const crypto = require('crypto');
const PREFIX = 'mkt_';
function sha256(s){ return crypto.createHash('sha256').update(s).digest('hex'); }
function mintRaw(){ const raw = PREFIX + crypto.randomBytes(32).toString('base64url'); return { raw, hash: sha256(raw), display: raw.slice(0, PREFIX.length+6)+'…' }; }
function looksLikeFleetToken(t){ return typeof t === 'string' && t.startsWith(PREFIX); }
async function validateFleetToken(pool, raw){
  if(!pool) return null;
  const { rows } = await pool.query('SELECT id,label,user_id,revoked_at FROM api_tokens WHERE token_hash=$1',[sha256(raw)]);
  const tok = rows[0];
  if(!tok || tok.revoked_at) return null;
  pool.query('UPDATE api_tokens SET last_used_at=now() WHERE id=$1',[tok.id]).catch(()=>{});
  return { token_id: tok.id, label: tok.label, user_id: tok.user_id };
}
module.exports = { PREFIX, sha256, mintRaw, looksLikeFleetToken, validateFleetToken };
