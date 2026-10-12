// ORDER #1666: the Scout's competitor watch. Katherine lists competitor
// websites on the Scout's profile; each Monday the Scout reads up to a dozen
// pages per site and reports only what changed since last week.
//
// Read-only and polite: public pages only, one request at a time, the same
// named user agent as Site Health, and nothing behind a login.
'use strict';

const crypto = require('crypto');

const MAX_WATCH = 15;
const MAX_TEXT = 30000;
const MAX_ADDED = 6;
// Pages most likely to carry news a competitor would make: listed first.
const PRIORITY = /(pric|package|rate|investment|wedding|venue|event|special|offer|promo|tour|faq|space|menu|catering|book)/i;

// "www.Example.com/weddings" or "https://example.com" -> "example.com".
function checkSite(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return { error: 'type a website, like example.com' };
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '').replace(/:\d+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) || !/\.[a-z]{2,}$/.test(s)) {
    return { error: `"${String(raw).slice(0, 60)}" is not a website address` };
  }
  if (/(^|\.)(localhost|local|internal|test)$/.test(s)) return { error: 'that is not a public website' };
  return { site: s };
}

const hash = (t) => crypto.createHash('sha1').update(t).digest('hex');

// Sentences, so a change reads as "these lines are new" rather than a raw diff.
function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\s{2,}|\s+\|\s+/).map((x) => x.trim()).filter((x) => x.length >= 25 && x.length <= 400);
}

function pickPages(site, urls, per) {
  const home = `https://${site}/`;
  const rest = [...new Set(urls)].filter((u) => {
    try { const h = new URL(u).hostname.replace(/^www\./, ''); return h === site && u.replace(/\/$/, '') !== `https://${site}` && u.replace(/\/$/, '') !== `https://www.${site}`; } catch (e) { return false; }
  }).sort();
  const first = rest.filter((u) => PRIORITY.test(new URL(u).pathname));
  const then = rest.filter((u) => !PRIORITY.test(new URL(u).pathname));
  return [home, ...first, ...then].slice(0, per);
}

// old: [{ path, title, hash, text }], now: [{ path, title, hash, text }], listed: every path in the sitemap (or null)
function compare(old, now, listed) {
  const before = new Map(old.map((p) => [p.path, p]));
  const out = { added: [], changed: [], gone: [] };
  for (const p of now) {
    const o = before.get(p.path);
    if (!o) { out.added.push({ path: p.path, title: p.title }); continue; }
    if (o.hash === p.hash) continue;
    const had = new Set(sentences(o.text));
    const has = new Set(sentences(p.text));
    const lines = [...has].filter((x) => !had.has(x));
    const removed = [...had].filter((x) => !has.has(x)).length;
    if (!lines.length && !removed && o.title === p.title) continue;
    out.changed.push({ path: p.path, title: p.title, was: o.title !== p.title ? o.title : null, lines: lines.slice(0, MAX_ADDED), more: Math.max(0, lines.length - MAX_ADDED), removed });
  }
  if (listed) {
    const live = new Set(listed);
    for (const o of old) if (!live.has(o.path) && !now.some((p) => p.path === o.path)) out.gone.push(o.path);
  }
  return out;
}

module.exports = { checkSite, sentences, pickPages, compare, hash, MAX_WATCH, MAX_TEXT, PRIORITY };
