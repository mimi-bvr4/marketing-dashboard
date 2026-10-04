// ORDER #1239: the Drive client for the photo archive. RUNS ON THE BOX, never on
// Railway: Railway never holds a Drive credential (#1239 ARCHITECTURE).
//
// No googleapis dependency. A service-account JWT is signed with node's crypto
// and traded for a token at Google's token endpoint, the documented
// "service account, no client library" flow. `fetch` is injectable so every
// rule below is testable without a network.
//
// 🔴 THE LAWS THIS FILE CARRIES:
//   1. The JWT asks for DRIVE_SCOPES (drive.readonly) and nothing else
//      (#1008 Amendment A). The SA is fileOrganizer on the folder; read-only is
//      enforced HERE, so a bug cannot move, rename or trash a file.
//   2. Only GETs reach Drive. There is no method here that sends anything else.
//   3. A thumbnail is fetched from `thumbnailLink` sized =s400. Never the
//      original (`alt=media`), never a download link.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DRIVE_SCOPES } = require('./photo-archive');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DEFAULT_KEY_PATH = path.join(os.homedir(), '.config', 'brain', 'sa-key.json');
const THUMB_SIZE = 400;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// The signed assertion. `scope` is DRIVE_SCOPES joined, and only that.
function signedJwt(key, now = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: key.client_email, scope: DRIVE_SCOPES.join(' '), aud: TOKEN_URL,
    iat: now, exp: now + 3600,
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.createSign('RSA-SHA256').update(body).sign(key.private_key);
  return `${body}.${b64url(sig)}`;
}

function decodeClaims(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

// thumbnailLink ends in "=s220" (or carries no size). Ask for =s400, the long
// edge the DB stores. Anything that is not a thumbnail link is refused.
function thumbUrl(thumbnailLink, size = THUMB_SIZE) {
  if (!thumbnailLink) return null;
  const u = String(thumbnailLink);
  if (/alt=media|export=download|\/download\b/i.test(u)) throw new Error('refused: not a thumbnail link');
  return /=s\d+(-[a-z0-9-]+)?$/i.test(u) ? u.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${size}`) : `${u}=s${size}`;
}

// A JPEG's width and height from its SOF marker, without decoding it.
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function createDriveClient({ keyPath = process.env.PHOTO_SA_KEY || DEFAULT_KEY_PATH, key, fetchImpl = globalThis.fetch } = {}) {
  const sa = key || JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  let token = null;
  let tokenExp = 0;

  async function accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (token && now < tokenExp - 60) return token;
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJwt(sa, now),
      }).toString(),
    });
    const body = await res.json();
    if (!res.ok || !body.access_token) throw new Error(`token refused: ${res.status} ${body.error || ''} ${body.error_description || ''}`.trim());
    token = body.access_token;
    tokenExp = now + (body.expires_in || 3600);
    return token;
  }

  async function get(url) {
    const res = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) {
      let detail = '';
      try { const b = await res.json(); detail = (b.error && b.error.message) || ''; } catch (_) { /* not json */ }
      throw new Error(`Drive ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res;
  }

  const qs = (params) => new URLSearchParams(Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();

  return {
    serviceAccount: sa.client_email,
    // The `listPage` photo-archive.listAll pages through. listAll supplies the
    // shared-drive flags, fields and pageToken; pageSize is the API maximum.
    async listPage(params) {
      return (await get(`${DRIVE_API}/files?${qs({ pageSize: 1000, ...params })}`)).json();
    },
    async getFile(id, fields = 'id, name, mimeType, driveId, trashed') {
      return (await get(`${DRIVE_API}/files/${encodeURIComponent(id)}?${qs({ fields, supportsAllDrives: true })}`)).json();
    },
    async startPageToken(driveId) {
      const b = await (await get(`${DRIVE_API}/changes/startPageToken?${qs({ supportsAllDrives: true, driveId })}`)).json();
      return b.startPageToken;
    },
    // One page of the changes feed. Follows the same nextPageToken law: the
    // caller loops until newStartPageToken comes back.
    async changesPage(pageToken, driveId) {
      return (await get(`${DRIVE_API}/changes?${qs({
        pageToken, driveId, pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true,
        includeRemoved: true,
        fields: 'nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, size, '
          + 'md5Checksum, createdTime, parents, trashed, thumbnailLink, imageMediaMetadata(width, height, time), '
          + 'videoMediaMetadata(width, height)))',
      })}`)).json();
    },
    async thumbnail(file) {
      const url = thumbUrl(file.thumbnailLink);
      if (!url) return null;
      const buf = Buffer.from(await (await get(url)).arrayBuffer());
      const dims = jpegSize(buf);
      return { bytes: buf, w: dims ? dims.w : null, h: dims ? dims.h : null };
    },
  };
}

// Every change in the feed from `pageToken`, paged to the end.
async function allChanges(client, pageToken, driveId) {
  const changes = [];
  const seen = new Set();
  let tok = pageToken;
  for (;;) {
    const page = await client.changesPage(tok, driveId);
    changes.push(...(page.changes || []));
    if (page.newStartPageToken) return { changes, newStartPageToken: page.newStartPageToken };
    if (!page.nextPageToken || seen.has(page.nextPageToken)) throw new Error('changes feed ended without a newStartPageToken');
    seen.add(page.nextPageToken);
    tok = page.nextPageToken;
  }
}

module.exports = { createDriveClient, allChanges, signedJwt, decodeClaims, thumbUrl, jpegSize, TOKEN_URL, DRIVE_API, THUMB_SIZE };
