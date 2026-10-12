// ORDER #1664: each agent's name and portrait, set by Katherine (or an exec)
// on the Agents page. COSMETIC ONLY, by Mimi's ruling 10.12.2026: a name or a
// picture changes nothing about what an agent may read or do, so it saves
// straight away with no exec approval. Every change is logged.
//
// The checks are shared by the Postgres and memory stores.
'use strict';

const MAX_NAME = 40;
const MAX_PORTRAIT = 1.5 * 1024 * 1024;
const TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

// '' or null puts the default name back.
function checkName(raw) {
  if (raw == null) return { name: null };
  if (typeof raw !== 'string') return { error: 'the name must be text' };
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) return { name: null };
  if (name.length > MAX_NAME) return { error: `keep the name to ${MAX_NAME} characters` };
  return { name };
}

// The type comes from the bytes, never from what the browser claims.
function checkPortrait(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'no picture received' };
  if (buf.length > MAX_PORTRAIT) return { error: 'the picture is over 1.5 MB; save it smaller and try again' };
  for (const [type, magic] of Object.entries(TYPES)) {
    if (magic.every((b, i) => buf[i] === b)) {
      if (type === 'image/webp' && buf.slice(8, 12).toString('latin1') !== 'WEBP') continue;
      return { type };
    }
  }
  return { error: 'use a PNG, JPG or WebP picture' };
}

// What the page and Review show: her name if she set one, else the repo name.
function displayName(def, profile) {
  return (profile && profile.display_name) || def.name;
}

module.exports = { checkName, checkPortrait, displayName, MAX_NAME, MAX_PORTRAIT };
