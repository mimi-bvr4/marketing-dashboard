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

// The read-only mkt_ key: env first, then the Box Keychain item 'marketing-fleet-key'.
function fleetKey(env, keychain) {
  if (env.MARKETING_FLEET_KEY) return env.MARKETING_FLEET_KEY;
  try {
    const run = keychain || ((svc) => require('child_process').execFileSync('security', ['find-generic-password', '-s', svc, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const k = String(run('marketing-fleet-key') || '').trim();
    return /^mkt_/.test(k) ? k : null;
  } catch (e) { return null; }
}

async function dashboardSource(src, ctx) {
  const key = fleetKey(ctx.env, ctx.keychain);
  if (!key) return { ok: false, why: "no read-only marketing key on this machine (Keychain item 'marketing-fleet-key', minted at /settings/api-tokens)" };
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

// ------------------------------------------------------------ AI assistant answers (ORDER #1663)
//
// Mimi's ruling 10.12.2026: "Citations checks ChatGPT, Gemini, Perplexity and
// Claude, monthly on the 15th." Each assistant gets at most two questions per
// venue (what the venue is, and one category question). A missing key skips
// that assistant; it never fails the run. The mismatch scan against the
// canonical venue facts is the model's job in the agent prompt, not code here.

const ANSWER_CHARS = 1500;
const MAX_QUESTIONS_PER_VENUE = 2;
const DEFAULT_ASSISTANTS = ['claude', 'chatgpt', 'gemini', 'perplexity'];

function keychainRead(ctx) {
  return ctx.keychain || ((svc) => {
    try {
      return require('child_process').execFileSync('security', ['find-generic-password', '-s', svc, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim() || null;
    } catch (e) { return null; }
  });
}

function keyFor(name, env, kc) {
  const spec = { chatgpt: ['OPENAI_API_KEY', 'openai-api-key'], gemini: ['GEMINI_API_KEY', 'gemini-api-key'],
    perplexity: ['PERPLEXITY_API_KEY', 'perplexity-api-key'] }[name];
  if (!spec) return null;
  if (env[spec[0]]) return env[spec[0]];
  const k = kc(spec[1]);
  return k ? String(k).trim() || null : null;
}

async function postJson(ctx, url, headers, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ctx.timeoutMs || 60000);
  try {
    const r = await ctx.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}

const chatText = (j) => (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';

// One asker per assistant that has a key: (question, count) -> answer text, or throws.
// `count()` is called once per HTTP request so the run's call total is exact.
function askers(ctx, cfg, count) {
  const env = ctx.env || {};
  const kc = keychainRead(ctx);
  const out = {};
  // Claude: the key the agents already use (env ANTHROPIC_API_KEY, then Keychain anthropic-api-key, then the brain config file).
  const find = ctx.findApiKey || require('./photo-tagger').findApiKey;
  const ak = find({ env, keychain: kc, ...(ctx.configFile ? { configFile: ctx.configFile } : {}) });
  if (ak) {
    const model = env.AGENT_MODEL || require('./agent-llm').DEFAULT_MODEL;
    const headers = { 'x-api-key': ak.key, 'anthropic-version': '2023-06-01' };
    let search = cfg.claude_web_search !== false;
    out.claude = async (q) => {
      const body = { model, max_tokens: 1024, messages: [{ role: 'user', content: q }] };
      if (search) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
      count();
      let r = await postJson(ctx, 'https://api.anthropic.com/v1/messages', headers, body);
      if (r.status === 400 && search) {          // web search refused for this key: ask plain from now on
        search = false; delete body.tools; count();
        r = await postJson(ctx, 'https://api.anthropic.com/v1/messages', headers, body);
      }
      if (r.status !== 200) throw new Error(`answered ${r.status}`);
      return ((r.json && r.json.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    };
  }
  const ok = keyFor('chatgpt', env, kc);
  if (ok) out.chatgpt = async (q) => {
    count();
    const r = await postJson(ctx, 'https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${ok}` },
      { model: env.CITATIONS_OPENAI_MODEL || cfg.openai_model || 'gpt-4o', messages: [{ role: 'user', content: q }] });
    if (r.status !== 200) throw new Error(`answered ${r.status}`);
    return chatText(r.json);
  };
  const gk = keyFor('gemini', env, kc);
  if (gk) out.gemini = async (q) => {
    count();
    const model = env.CITATIONS_GEMINI_MODEL || cfg.gemini_model || 'gemini-2.5-flash';
    const r = await postJson(ctx, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { 'x-goog-api-key': gk },
      { contents: [{ parts: [{ text: q }] }], tools: [{ google_search: {} }] });
    if (r.status !== 200) throw new Error(`answered ${r.status}`);
    const c = r.json && r.json.candidates && r.json.candidates[0];
    return ((c && c.content && c.content.parts) || []).map((p) => p.text || '').join('');
  };
  const pk = keyFor('perplexity', env, kc);
  if (pk) out.perplexity = async (q) => {
    count();
    const r = await postJson(ctx, 'https://api.perplexity.ai/chat/completions', { Authorization: `Bearer ${pk}` },
      { model: env.CITATIONS_PERPLEXITY_MODEL || cfg.perplexity_model || 'sonar', messages: [{ role: 'user', content: q }] });
    if (r.status !== 200) throw new Error(`answered ${r.status}`);
    return chatText(r.json);
  };
  return out;
}

function venueQuestions(v) {
  const qs = [`What is ${v.name} in Nashville and what kind of events is it known for?`];
  if (v.category) qs.push(`What are the best ${v.category}?`);
  return qs.slice(0, MAX_QUESTIONS_PER_VENUE);
}

async function aiAnswersSource(src, ctx) {
  const assistants = src.assistants || DEFAULT_ASSISTANTS;
  const venues = src.venues || [];
  if (!venues.length) return { ok: false, why: 'no venues listed for the AI answer checks' };
  let calls = 0;
  const ask = askers(ctx, src, () => { calls++; });
  const blocks = [];
  const rows = [];
  for (const a of assistants) {
    if (!ask[a]) { rows.push({ a, skipped: true, why: 'no key' }); continue; }
    let answered = 0; let failed = 0;
    for (const v of venues) {
      for (const q of venueQuestions(v)) {
        try {
          const t = String((await ask[a](q)) || '').trim();
          answered++;
          blocks.push(`### ${a} | ${v.code} | ${q}\n${t.length > ANSWER_CHARS ? t.slice(0, ANSWER_CHARS) + ' [truncated]' : t || '(empty answer)'}`);
        } catch (e) {
          failed++;
          blocks.push(`### ${a} | ${v.code} | ${q}\n(no answer: ${e.name === 'AbortError' ? 'timed out' : e.message})`);
        }
      }
    }
    rows.push({ a, answered, failed });
  }
  const table = '| Assistant | Answers | Failed | Note |\n|---|---|---|---|\n'
    + rows.map((r) => (r.skipped ? `| ${r.a} | 0 | 0 | skipped: ${r.why} |` : `| ${r.a} | ${r.answered} | ${r.failed} | |`)).join('\n');
  const skipped = rows.filter((r) => r.skipped).map((r) => ({ assistant: r.a, skipped: true, why: r.why }));
  if (!blocks.length) return { ok: false, why: `no assistant could be asked (${skipped.map((s) => `${s.assistant}: ${s.why}`).join(', ')})`, skipped, calls };
  const text = `AI assistant answers. Each block is: assistant | venue code | question, then the answer as given (cut at ${ANSWER_CHARS} characters).\n`
    + 'Compare each answer with the canonical venue facts source (name, city, and anything else listed there). Report wrong names, wrong cities, wrong venue types, and venues an assistant did not know. Never repeat a claim from an answer as fact.\n\n'
    + table + '\n\n' + blocks.join('\n\n');
  return { ok: true, text, table, skipped, calls };
}

// ------------------------------------------------------------ the Scout (ORDER #1666)
//
// competitor_watch: the sites Katherine listed on the Scout's profile. Reads up
// to `pages_per_site` public pages each (home, then pricing/package/wedding
// pages first) and compares them with what the Scout saw last run. The first
// run on a site takes a baseline and says so; it never reports a baseline as news.
// web_trends: Claude with web search, asked for what is new in weddings and
// events in the last 14 days, with the link for every item.

async function competitorWatchSource(src, ctx) {
  const W = require('./agent-watch');
  const store = ctx.store;
  if (!store || !store.watchlist) return { ok: false, why: 'no database on this run (the watch list lives in the marketing database)' };
  // #1668: the sites Katherine typed on the Scout's profile, plus every TOP
  // competitor from her competitor sheet (synced just before this run).
  const list = (await store.watchlist(ctx.agent)).slice();
  if (store.competitors) {
    const have = new Set(list.map((w) => w.site));
    for (const c of await store.competitors()) {
      if (!c.top || have.has(c.site)) continue;
      list.push({ site: c.site, label: c.name, from_sheet: true });
      have.add(c.site);
      if (list.length >= W.MAX_WATCH + 20) break;
    }
  }
  if (!list.length) return { ok: false, why: "no competitors listed yet: Katherine adds them on the Scout's profile page or her competitor sheet" };
  const per = src.pages_per_site || 12;
  const rows = [];
  const blocks = [];
  let reached = 0;
  for (const w of list) {
    const name = w.label ? `${w.label} (${w.site})` : w.site;
    const home = await get(`https://${w.site}/`, ctx);
    if (home.status === 0 || home.status >= 400) { rows.push(`| ${name} | not reached (${home.status || home.error}) | | | |`); continue; }
    reached++;
    const sm = await sitemapUrls(w.site, ctx);
    const urls = W.pickPages(w.site, sm.urls, per);
    const now = [];
    for (const u of urls) {
      const r = u === `https://${w.site}/` ? home : await get(u, ctx);
      if (r.status === 0 || r.status >= 400) continue;
      const f = pageFacts(r.body);
      const text = f.text.slice(0, W.MAX_TEXT);
      now.push({ path: new URL(u).pathname || '/', title: f.title, hash: W.hash(f.title + '\n' + text), text });
    }
    const old = await store.snapshots(ctx.agent, w.site);
    const listed = sm.from ? sm.urls.map((u) => { try { return new URL(u).pathname || '/'; } catch (e) { return null; } }).filter(Boolean).concat('/') : null;
    if (!old.length) {
      rows.push(`| ${name} | baseline taken | ${now.length} | | |`);
      blocks.push(`### ${name}\nFirst look: ${now.length} pages saved as the baseline. Changes are reported from the next run. Pages read: ${now.map((p) => p.path).join(', ')}`);
    } else {
      const d = W.compare(old, now, listed);
      rows.push(`| ${name} | read | ${now.length} | ${d.added.length} new, ${d.changed.length} changed | ${d.gone.length} |`);
      const parts = [];
      for (const a of d.added) parts.push(`- NEW PAGE ${a.path}${a.title ? ` "${a.title}"` : ''}`);
      for (const c of d.changed) {
        parts.push(`- CHANGED ${c.path}${c.was ? ` (title was "${c.was}", now "${c.title}")` : ''}: ${c.lines.length} new line(s)${c.more ? ` (+${c.more} more)` : ''}, ${c.removed} line(s) gone`);
        for (const l of c.lines) parts.push(`    > ${l}`);
      }
      for (const g of d.gone) parts.push(`- PAGE GONE ${g}`);
      blocks.push(`### ${name}\n${parts.length ? parts.join('\n') : 'No change since last run.'}`);
      // #1668: the profile writer reads what changed on each site.
      if (!ctx.dryRun && store.setCompetitorChanges) await store.setCompetitorChanges(w.site, parts.length ? parts.join('\n').slice(0, 4000) : 'No change since last run.');
      if (!ctx.dryRun) await store.saveSnapshots(ctx.agent, w.site, now, d.gone);
      continue;
    }
    if (!ctx.dryRun) await store.saveSnapshots(ctx.agent, w.site, now, []);
  }
  if (!reached) return { ok: false, why: 'no competitor site answered' };
  const table = '| Competitor | This run | Pages read | Changes | Pages gone |\n|---|---|---|---|---|\n' + rows.join('\n');
  return { ok: true, table, text: 'Competitor sites, compared with the last run. Lines starting ">" are text that is new on that page this week, quoted as found.\n\n'
    + table + '\n\n' + blocks.join('\n\n') };
}

async function webTrendsSource(src, ctx) {
  let calls = 0;
  const ask = askers(ctx, { claude_web_search: true }, () => { calls++; }).claude;
  if (!ask) return { ok: false, why: 'no Claude key on this machine for web search' };
  const today = (ctx.now ? ctx.now() : new Date()).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' });
  const blocks = [];
  let answered = 0;
  for (const q of (src.queries || [])) {
    const prompt = `Today is ${today}. Search the web for: ${q}\n\nOnly use things published in the last 14 days. For each item give: what it is in one sentence, the publication, the date, and the link. If you find nothing from the last 14 days, say "nothing new found". Never list an item without a link you actually found.`;
    try { const t = String((await ask(prompt)) || '').trim(); answered++; blocks.push(`### ${q}\n${t.slice(0, 4000) || '(empty answer)'}`); }
    catch (e) { blocks.push(`### ${q}\n(no answer: ${e.name === 'AbortError' ? 'timed out' : e.message})`); }
  }
  if (!answered) return { ok: false, why: 'web search did not answer' };
  return { ok: true, text: `Web searches run ${today} (Claude with web search; ${calls} request${calls === 1 ? '' : 's'}). Only items with a link count.\n\n${blocks.join('\n\n')}` };
}

const REGISTRY = { file: fileSource, request: requestSource, pending: pendingSource, site_crawl: siteCrawlSource,
  wp_posts: wpPostsSource, dashboard: dashboardSource, ai_answers: aiAnswersSource,
  competitor_watch: competitorWatchSource, web_trends: webTrendsSource };

function sourceLabel(src) {
  if (src.label) return src.label;
  if (src.type === 'file') return src.path || `newest ${src.newest}*.md`;
  if (src.type === 'site_crawl') return `crawl of ${src.sites.length} sites`;
  if (src.type === 'wp_posts') return `public posts on ${src.sites.length} WordPress sites`;
  if (src.type === 'dashboard') return `Marketing Dashboard ${src.paths.join(', ')}`;
  if (src.type === 'ai_answers') return `AI assistant answers (${(src.assistants || ['claude', 'chatgpt', 'gemini', 'perplexity']).join(', ')})`;
  if (src.type === 'competitor_watch') return 'competitor websites Katherine listed';
  if (src.type === 'web_trends') return 'web search for new wedding and event trends';
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

module.exports = { gather, REGISTRY, pageFacts, treeRoot, sourceLabel, aiAnswersSource, MAX_QUESTIONS_PER_VENUE, DEFAULT_ASSISTANTS };
