// ORDER #1873: the Web Agent's WordPress writes. DRAFTS ONLY.
//
// 🔴 THE FENCE (same as #1658's wp-draft.js). The only page status this file
// ever sends is the constant DRAFT. It creates a NEW page (POST /pages, no id)
// and uploads cleared photos (POST /media); it never POSTs to an existing page
// id, so the live page, menus, theme, plugins and Brizy cannot be touched from
// here. A test greps this file for both rules. Replacing an existing page means
// a new draft titled "... (replaces page N)": Katherine publishes it from
// WordPress herself until Mimi turns on lib/web-publish.js.
//
// Every write is logged with its post id. Before and after each request the
// site's pages are snapshotted by modified_gmt, and the read-back proof is that
// the only page ids changed or new are the draft's own.
//
// Credentials: the Box Keychain item `wp-app-password-<domain>` (#1646/#1648),
// read in this process by wp-draft.js's keychainLogin, never printed or stored.
'use strict';

const { keychainLogin, normalizeSite, WP_SITES } = require('./wp-draft');

const DRAFT = 'draft';

// Site codes Katherine picks from. Every domain is one of wp-draft.js's 8
// measured WordPress sites. The Elle sites are Squarespace: no page API.
const SITES = {
  TBB: { domain: 'thebridgebuilding.com', name: 'The Bridge Building' },
  TBT: { domain: 'thebelltower.com', name: 'The Bell Tower' },
  ECD: { domain: 'cherokeedock.com', name: 'Estate at Cherokee Dock' },
  SWF: { domain: 'saddlewoodsfarm.com', name: 'Saddle Woods Farm' },
  NEB: { domain: 'nashvilleeventbartending.com', name: 'Nashville Event Bartending' },
  IHG: { domain: 'infinityhospitalitygroup.com', name: 'Infinity Hospitality Group' },
  DEC: { domain: 'dreameventsandcatering.com', name: 'Dream Events & Catering' },
  DD: { domain: 'dailydishcatering.com', name: 'DailyDish' },
};
const SQUARESPACE = { STE: 'thesaintelle.com', COR: 'thecordelle.com', EST: 'estellenashville.com' };
for (const s of Object.values(SITES)) if (!WP_SITES.has(s.domain)) throw new Error(`web-wp: ${s.domain} is not a measured WordPress site`);

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function siteOf(code) {
  const c = String(code || '').toUpperCase();
  if (SITES[c]) return { code: c, ...SITES[c], origin: `https://${SITES[c].domain}` };
  if (SQUARESPACE[c]) return { code: c, squarespace: true, domain: SQUARESPACE[c] };
  return null;
}

function wpError(status, data, text) {
  if (data && (data.code || data.message)) return `HTTP ${status} ${data.code || ''}: ${data.message || ''}`.trim();
  return `HTTP ${status} ${String(text || '').slice(0, 200)}`;
}

function client({ site, fetchImpl = globalThis.fetch, login = keychainLogin }) {
  const s = siteOf(site);
  if (!s || s.squarespace) return { error: `${site} has no WordPress page API` };
  const auth = login(normalizeSite(s.domain));
  if (!auth) return { error: `no Keychain item wp-app-password-${s.domain} on this machine` };
  const headers = { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64'), 'User-Agent': 'IHG-Brain-WebAgent/1.0 (draft only)' };
  async function call(pathAndQuery, opts = {}) {
    const r = await fetchImpl(s.origin + '/wp-json/wp/v2' + pathAndQuery, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: r.status, data, text, total_pages: Number(r.headers && r.headers.get ? r.headers.get('x-wp-totalpages') : 0) || 1 };
  }
  return { site: s, get: (p) => call(p), post: (p, body, extra) => call(p, { method: 'POST', ...extra, body }) };
}

// Every page in every status, by modified_gmt. Read-only.
async function snapshot(c, maxPages = 10) {
  const pages = {};
  for (let n = 1; n <= maxPages; n++) {
    const r = await c.get(`/pages?context=edit&status=publish,future,draft,pending,private&per_page=100&page=${n}&_fields=id,status,modified_gmt`);
    if (r.status !== 200 || !Array.isArray(r.data)) return { ok: false, why: 'snapshot refused: ' + wpError(r.status, r.data, r.text), pages };
    for (const p of r.data) pages[p.id] = `${p.status}|${p.modified_gmt}`;
    if (n >= r.total_pages) break;
  }
  return { ok: true, pages };
}

function changedIds(before, after) {
  return Object.keys(after).filter((id) => before[id] !== after[id]).map(Number).sort((a, b) => a - b);
}

// One cleared photo into this site's Media Library, with its alt text.
async function uploadMedia(c, { name, type, data, alt }, log) {
  if (!IMAGE_TYPES[type]) return { ok: false, why: `${name}: ${type || 'unknown type'} is not a web photo type` };
  const buf = Buffer.from(String(data || ''), 'base64');
  const file = String(name).replace(/[^\w.-]+/g, '-').slice(0, 120);
  const r = await c.post('/media', buf, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${file}"` } });
  if (![200, 201].includes(r.status) || !r.data || !r.data.id) return { ok: false, why: `${name}: WordPress refused the upload: ${wpError(r.status, r.data, r.text)}` };
  await log({ action: 'media uploaded', post_id: r.data.id, detail: name });
  if (alt) {
    const a = await c.post(`/media/${r.data.id}`, JSON.stringify({ alt_text: String(alt).slice(0, 300) }), { headers: { 'Content-Type': 'application/json' } });
    if (a.status === 200) await log({ action: 'media alt text set', post_id: r.data.id, detail: String(alt).slice(0, 120) });
  }
  return { ok: true, id: r.data.id, url: r.data.source_url };
}

async function createDraftPage(c, { title, content, parent }, log) {
  const body = { title: String(title).slice(0, 200), content, status: DRAFT };
  if (parent) body.parent = Number(parent);
  const r = await c.post('/pages', JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  if (![200, 201].includes(r.status) || !r.data || !r.data.id) return { ok: false, why: 'WordPress refused the draft: ' + wpError(r.status, r.data, r.text) };
  const id = r.data.id;
  await log({ action: 'draft page created', post_id: id, detail: body.title });
  const back = await c.get(`/pages/${id}?context=edit`);
  const out = { id, edit_link: `${c.site.origin}/wp-admin/post.php?post=${id}&action=edit`, preview_link: `${c.site.origin}/?page_id=${id}&preview=true` };
  if (back.status !== 200 || !back.data) return { ok: true, ...out, status: 'unknown', note: 'read-back refused: ' + wpError(back.status, back.data, back.text) };
  if (back.data.status !== DRAFT) return { ok: false, alarm: true, ...out, status: back.data.status, why: `ALARM: read back with status "${back.data.status}", not draft` };
  return { ok: true, ...out, status: back.data.status, raw: back.data.content && back.data.content.raw, rendered: back.data.content && back.data.content.rendered };
}

// The live page Katherine's draft would replace (read-only).
async function readPage(c, id) {
  const r = await c.get(`/pages/${Number(id)}?context=edit`);
  if (r.status !== 200 || !r.data) return { ok: false, why: wpError(r.status, r.data, r.text) };
  return { ok: true, id: r.data.id, status: r.data.status, title: r.data.title && r.data.title.raw, link: r.data.link,
    parent: r.data.parent, modified_gmt: r.data.modified_gmt, raw: r.data.content && r.data.content.raw, rendered: r.data.content && r.data.content.rendered };
}

// Public page list for the picker (Railway side, no credential): published pages only.
async function publicPages(code, q, fetchImpl = globalThis.fetch) {
  const s = siteOf(code);
  if (!s || s.squarespace) return { error: `${code} has no WordPress page API` };
  const qs = `per_page=50&orderby=title&order=asc&_fields=id,title,link${q ? '&search=' + encodeURIComponent(String(q).slice(0, 80)) : ''}`;
  const r = await fetchImpl(`${s.origin}/wp-json/wp/v2/pages?${qs}`, { headers: { 'User-Agent': 'IHG-Brain-WebAgent/1.0 (read only)' } });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* not json */ }
  if (r.status !== 200 || !Array.isArray(data)) return { error: `${s.domain} answered ${r.status}` };
  return { pages: data.map((p) => ({ id: p.id, title: (p.title && p.title.rendered || '').replace(/<[^>]+>/g, '').replace(/&#8217;/g, "'").replace(/&amp;/g, '&'), link: p.link })) };
}

module.exports = { SITES, SQUARESPACE, IMAGE_TYPES, DRAFT, siteOf, client, snapshot, changedIds, uploadMedia, createDraftPage, readPage, publicPages };
