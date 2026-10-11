// ORDER #1015 Part 5 "source registry": every agent declares its sources in
// agents/<slug>/agent.json. Each source answers { ok: true, text, table } or
// { ok: false, why }. A source that cannot be reached is reported on the card
// as "(source unavailable)"; the agent never guesses around it.
//
// `table` is MEASURED evidence (markdown). The runner appends it to the card
// under the model's words, so the numbers on a card are never model-written.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILE = 60000;
const UA = 'IHG-Brain-SiteHealth/1.0 (+brain@infinityhospitality.net)';

function treeRoot(env = process.env) {
  const c = [env.IHG_TREE, path.join(os.homedir(), 'Full_IH_Project'), path.join(os.homedir(), 'Desktop', 'Full_IH_Project')].filter(Boolean);
  return c.find((p) => fs.existsSync(p)) || null;
}

async function fileSource(src, ctx) {
  const root = treeRoot(ctx.env);
  if (!root) return { ok: false, why: 'project tree not found on this machine' };
  let rel = src.path;
  if (src.newest) {                       // e.g. "07_Marketing_and_Brand/Venue_Review_Pulse_" -> the newest such .md
    const inDir = src.newest.endsWith('/');
    const relDir = inDir ? src.newest.slice(0, -1) : path.dirname(src.newest);
    const dir = path.join(root, relDir);
    const stem = inDir ? '' : path.basename(src.newest);
    const hits = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(stem) && f.endsWith('.md')).sort() : [];
    if (!hits.length) return { ok: false, why: `no ${src.newest}*.md found` };
    rel = path.join(relDir, hits[hits.length - 1]);
  }
  const p = path.join(root, rel);
  if (!p.startsWith(root)) return { ok: false, why: 'path outside the tree' };
  if (!fs.existsSync(p)) return { ok: false, why: `${rel} not found` };
  const t = fs.readFileSync(p, 'utf8');
  return { ok: true, text: t.length > MAX_FILE ? t.slice(0, MAX_FILE) + '\n[truncated]' : t };
}

async function requestSource(src, ctx) {
  if (!ctx.ask) return { ok: false, why: src.optional ? 'no request given (optional)' : 'this agent needs a request (--ask)' };
  return { ok: true, text: ctx.ask };
}

async function pendingSource(src) { return { ok: false, why: src.why || 'not connected yet' }; }

// ------------------------------------------------------------ site crawl

const pick = (re, html) => { const m = html.match(re); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };

function pageFacts(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  const text = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i, html),
    description: pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i, html)
      || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i, html),
    h1: (body.match(/<h1[\s>]/gi) || []).length,
    words: (text.match(/\S+/g) || []).length,
    text,
  };
}

async function get(url, ctx) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ctx.timeoutMs || 20000);
  try {
    const r = await ctx.fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctl.signal });
    const body = (r.headers.get('content-type') || '').includes('html') || url.endsWith('.xml') ? await r.text() : '';
    return { status: r.status, url: r.url || url, body };
  } catch (e) {
    return { status: 0, url, body: '', error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(t); }
}

async function sitemapUrls(site, ctx) {
  for (const p of ['/sitemap.xml', '/wp-sitemap.xml', '/sitemap_index.xml']) {
    const r = await get(`https://${site}${p}`, ctx);
    if (r.status !== 200 || !r.body.includes('<loc>')) continue;
    let locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    const subs = locs.filter((u) => /sitemap[^/]*\.xml$/i.test(u));
    if (subs.length) {
      locs = locs.filter((u) => !subs.includes(u));
      for (const s of subs.slice(0, 6)) {
        const sr = await get(s, ctx);
        if (sr.status === 200) locs.push(...[...sr.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]));
      }
    }
    return { from: p, urls: [...new Set(locs)] };
  }
  return { from: null, urls: [] };
}

async function siteCrawlSource(src, ctx) {
  const lint = ctx.lint;
  const per = src.pages_per_site || 15;
  const rows = [];
  const problems = [];
  const titles = new Map();
  let reached = 0;
  for (const site of src.sites) {
    const home = await get(`https://${site}/`, ctx);
    if (home.status === 0 || home.status >= 400) {
      problems.push(`| ${site} | / | home page ${home.status || home.error} |`);
      rows.push({ site, reached: false });
      continue;
    }
    reached++;
    const sm = await sitemapUrls(site, ctx);
    if (!sm.from) problems.push(`| ${site} | sitemap | no sitemap.xml, wp-sitemap.xml or sitemap_index.xml |`);
    const urls = [`https://${site}/`, ...sm.urls.filter((u) => u.replace(/\/$/, '') !== `https://${site}`)].slice(0, per);
    let hits = 0;
    for (const u of urls) {
      const r = u === `https://${site}/` ? home : await get(u, ctx);
      const short = u.replace(/^https?:\/\/[^/]+/, '') || '/';
      if (r.status === 0 || r.status >= 400) { problems.push(`| ${site} | ${short} | ${r.status || r.error} |`); continue; }
      if (r.url && !r.url.includes(site)) problems.push(`| ${site} | ${short} | redirects off-site to ${r.url} |`);
      const f = pageFacts(r.body);
      if (!f.title) problems.push(`| ${site} | ${short} | no <title> |`);
      if (!f.description) problems.push(`| ${site} | ${short} | no meta description |`);
      if (f.h1 !== 1) problems.push(`| ${site} | ${short} | ${f.h1} H1 tags |`);
      if (f.title) titles.set(f.title, [...(titles.get(f.title) || []), `${site}${short}`]);
      const l = lint(f.text);
      if (l.fails.length) problems.push(`| ${site} | ${short} | ${l.fails.length} em/en dash${l.fails.length === 1 ? '' : 'es'} in page copy |`);
      const phrases = [...new Set(l.flags.filter((x) => x.phrase).map((x) => x.phrase))].slice(0, 4);
      if (phrases.length) problems.push(`| ${site} | ${short} | AI-tell words: ${phrases.join(', ')} |`);
      hits++;
    }
    rows.push({ site, reached: true, sitemap: sm.from, sitemapCount: sm.urls.length, checked: hits });
  }
  for (const [t, where] of titles) if (where.length > 1) problems.push(`| ${where.length} pages | same title | "${t.slice(0, 60)}" on ${where.slice(0, 3).join(', ')} |`);
  if (!reached) return { ok: false, why: 'no site answered (network refused or every site down)' };
  const header = '| Site | Sitemap | Pages in sitemap | Pages checked |\n|---|---|---|---|\n'
    + rows.map((r) => r.reached ? `| ${r.site} | ${r.sitemap || 'none'} | ${r.sitemapCount} | ${r.checked} |` : `| ${r.site} | unreachable | 0 | 0 |`).join('\n');
  const table = header + '\n\n' + (problems.length
    ? '| Site | Page | Problem |\n|---|---|---|\n' + problems.slice(0, 150).join('\n') + (problems.length > 150 ? `\n\n(${problems.length - 150} more not shown)` : '')
    : 'No problems found on the pages checked.');
  return { ok: true, text: `Crawl of ${src.sites.length} sites, up to ${per} pages each.\n\n${table}`, table };
}

// ------------------------------------------------------------ public WordPress posts

async function wpPostsSource(src, ctx) {
  const out = [];
  const miss = [];
  for (const site of src.sites) {
    const r = await get(`https://${site}/wp-json/wp/v2/posts?per_page=100&_fields=link,title,date,slug`, { ...ctx });
    if (r.status !== 200) { miss.push(`${site} (${r.status || r.error})`); continue; }
    let posts = [];
    try { posts = JSON.parse(r.body || '[]'); } catch (e) { miss.push(`${site} (not JSON)`); continue; }
    for (const p of posts) out.push(`${site} | ${String(p.date || '').slice(0, 10)} | ${p.slug} | ${(p.title && p.title.rendered) || ''}`);
  }
  if (!out.length) return { ok: false, why: `no public posts read (${miss.join(', ') || 'none listed'})` };
  return { ok: true, text: `Published posts (public REST), site | date | slug | title:\n${out.join('\n')}${miss.length ? `\n\nNot read: ${miss.join(', ')}` : ''}` };
}

// ------------------------------------------------------------ the live dashboard (fleet key, GA4 only)

async function dashboardSource(src, ctx) {
  const key = ctx.env.MARKETING_FLEET_KEY;
  if (!key) return { ok: false, why: 'MARKETING_FLEET_KEY not set on this machine (a read-only mkt_ key from /settings/api-tokens)' };
  const base = ctx.env.MARKETING_BASE_URL || 'https://marketing.infinityhospitalitygroup.com';
  const out = [];
  for (const p of src.paths) {
    try {
      const r = await ctx.fetch(base + p, { headers: { Authorization: `Bearer ${key}` } });
      out.push(`${p}: ${r.status === 200 ? JSON.stringify(await r.json()).slice(0, 8000) : 'answered ' + r.status}`);
    } catch (e) { out.push(`${p}: ${e.message}`); }
  }
  return { ok: true, text: out.join('\n\n') };
}

const REGISTRY = { file: fileSource, request: requestSource, pending: pendingSource, site_crawl: siteCrawlSource,
  wp_posts: wpPostsSource, dashboard: dashboardSource };

function sourceLabel(src) {
  if (src.label) return src.label;
  if (src.type === 'file') return src.path || `newest ${src.newest}*.md`;
  if (src.type === 'site_crawl') return `crawl of ${src.sites.length} sites`;
  if (src.type === 'wp_posts') return `public posts on ${src.sites.length} WordPress sites`;
  if (src.type === 'dashboard') return `Marketing Dashboard ${src.paths.join(', ')}`;
  return src.type;
}

async function gather(sources, ctx) {
  const got = [];
  const unavailable = [];
  for (const src of sources) {
    const fn = REGISTRY[src.type];
    const label = sourceLabel(src);
    let r;
    try { r = fn ? await fn(src, ctx) : { ok: false, why: `unknown source type ${src.type}` }; }
    catch (e) { r = { ok: false, why: e.message }; }
    if (r.ok) got.push({ label, text: r.text, table: r.table || null });
    else if (!(src.optional && src.type === 'request')) unavailable.push({ label, why: r.why });
  }
  return { got, unavailable };
}

module.exports = { gather, REGISTRY, pageFacts, treeRoot, sourceLabel };
