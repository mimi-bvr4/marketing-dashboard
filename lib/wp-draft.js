// ORDER #1658: put an APPROVED Bloggy Bob card into WordPress as an
// UNPUBLISHED draft, as brain@, and read it back.
//
// 🔴 THE FENCE. The status sent is the constant DRAFT. No argument, field or
// code path sends anything else, and a test greps this file for the other
// statuses. A read-back that is not 'draft' is an ALARM, reported on the card.
// Never edits or deletes an existing post. One card makes at most one post:
// a card that already carries a post id is skipped.
//
// Credentials: the Box Keychain item `wp-app-password-<domain>` (#1646/#1648),
// read in this process with `security`, never printed, never stored.
'use strict';

const { execFileSync } = require('child_process');
const { mdToHtml } = require('./md-html');

const DRAFT = 'draft';
const KEYCHAIN_PREFIX = 'wp-app-password-';

// The 8 WordPress sites (#1648 measured). Squarespace (Elle) sites have no
// post API; their cards stay copy-and-paste.
const WP_SITES = new Set(['infinityhospitalitygroup.com', 'dreameventsandcatering.com', 'dailydishcatering.com',
  'thebridgebuilding.com', 'thebelltower.com', 'cherokeedock.com', 'saddlewoodsfarm.com', 'nashvilleeventbartending.com']);

function normalizeSite(s) {
  return String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

function keychainLogin(domain, run = execFileSync) {
  const svc = KEYCHAIN_PREFIX + domain;
  try {
    const meta = run('security', ['find-generic-password', '-s', svc], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = String(meta).match(/"acct"<blob>="([^"]*)"/);
    const pw = String(run('security', ['find-generic-password', '-s', svc, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    if (!m || !m[1] || !pw) return null;
    return { user: m[1], pass: pw };
  } catch (e) { return null; }
}

function stripH1(md) { return String(md || '').replace(/^\s*#\s+[^\n]*\n+/, ''); }

function wpError(status, data, text) {
  if (data && (data.code || data.message)) return `HTTP ${status} ${data.code || ''}: ${data.message || ''}`.trim();
  return `HTTP ${status} ${String(text || '').slice(0, 200)}`;
}

async function createDraft({ post, fetchImpl = globalThis.fetch, login = keychainLogin }) {
  const site = normalizeSite(post.site);
  if (!WP_SITES.has(site)) return { ok: false, skip: true, why: `${site || 'no site'} is not one of our WordPress sites; copy the card by hand` };
  if (!post.title || !post.content_md) return { ok: false, why: 'the card has no post title or body' };
  const auth = login(site);
  if (!auth) return { ok: false, why: `no Keychain item ${KEYCHAIN_PREFIX}${site} on this machine` };
  const origin = `https://${site}`;
  const headers = { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64'),
    'Content-Type': 'application/json', 'User-Agent': 'IHG-Brain-Bob/1.0 (draft only)' };
  const body = { title: String(post.title), content: mdToHtml(stripH1(post.content_md)), status: DRAFT };
  if (post.slug) body.slug = String(post.slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 190);
  if (post.excerpt || post.seo_description) body.excerpt = String(post.excerpt || post.seo_description).slice(0, 400);
  let r = await fetchImpl(`${origin}/wp-json/wp/v2/posts`, { method: 'POST', headers, body: JSON.stringify(body) });
  let text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { /* not json */ }
  if (![200, 201].includes(r.status) || !data || !data.id) return { ok: false, why: 'WordPress refused: ' + wpError(r.status, data, text) };
  const id = data.id;
  const edit = `${origin}/wp-admin/post.php?post=${id}&action=edit`;
  r = await fetchImpl(`${origin}/wp-json/wp/v2/posts/${id}?context=edit`, { headers });
  text = await r.text();
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (r.status !== 200 || !data) return { ok: true, id, edit_link: edit, status: 'unknown', note: 'created; read-back refused: ' + wpError(r.status, data, text) };
  if (data.status !== DRAFT) return { ok: false, alarm: true, id, edit_link: edit, status: data.status, why: `ALARM: read back with status "${data.status}", not draft` };
  return { ok: true, id, edit_link: edit, status: data.status };
}

module.exports = { createDraft, keychainLogin, normalizeSite, WP_SITES, DRAFT, stripH1 };
