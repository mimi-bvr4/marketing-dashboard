// ORDERS #1704 + #1705: one service-account token helper for the two new
// read-only Google sources (Search Console for the SEO agent, the brain@
// inbox for PR Patty). RUNS ON THE BOX: the key never leaves ~/.config/brain.
//
// 🔴 LAW: only the read-only scopes in ALLOWED_SCOPES can be asked for. A scope
// that can write, send or delete is refused here, before anything is signed.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ALLOWED_SCOPES = new Set([
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
]);

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function keyPath(env = process.env) {
  return env.BRAIN_SA_KEY || path.join(os.homedir(), '.config', 'brain', 'sa-key.json');
}

function loadKey(env = process.env) {
  const p = keyPath(env);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function signedJwt(key, { scopes, subject, now = Math.floor(Date.now() / 1000) }) {
  for (const s of scopes) if (!ALLOWED_SCOPES.has(s)) throw new Error(`refused: scope ${s} is not read-only`);
  const claims = { iss: key.client_email, scope: scopes.join(' '), aud: TOKEN_URL, iat: now, exp: now + 3600 };
  if (subject) claims.sub = subject;
  const body = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.createSign('RSA-SHA256').update(body).sign(key.private_key);
  return `${body}.${b64url(sig)}`;
}

async function accessToken({ key, scopes, subject, fetchImpl = globalThis.fetch }) {
  const assertion = signedJwt(key, { scopes, subject });
  const r = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google refused the token: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

module.exports = { accessToken, signedJwt, loadKey, keyPath, ALLOWED_SCOPES, TOKEN_URL };
