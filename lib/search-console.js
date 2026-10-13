// ORDER #1704: what Google Search Console says about our sites, for the SEO
// agent. Read-only (webmasters.readonly). Every number on the SEO agent's card
// comes from here, measured; the model never writes a ranking or a count.
//
// The method is the one in BLOG_AGENT_SPEC_10.09.2026.md (learned from the
// Wedding SEO Bootcamp Katherine shared): the quickest wins are searches where
// we already show up but sit on page 2 to 5, or get seen with almost no clicks;
// and two of our own pages must never compete for the same search.
'use strict';

const API = 'https://www.googleapis.com/webmasters/v3';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const LAG_DAYS = 3;          // Search Console data settles about 3 days late
const WINDOW_DAYS = 28;

const RULES = {
  page2to5: { minPos: 10.5, maxPos: 50, minImpr: 20 },
  lowCtr: { maxPos: 10.5, minImpr: 100, maxCtr: 0.01 },
  compete: { minImprEach: 10 },
  dropped: { positions: 5, minImpr: 20 },
};

function ymd(d) { return d.toISOString().slice(0, 10); }
function windows(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - LAG_DAYS));
  const start = new Date(end); start.setUTCDate(end.getUTCDate() - (WINDOW_DAYS - 1));
  const pEnd = new Date(start); pEnd.setUTCDate(start.getUTCDate() - 1);
  const pStart = new Date(pEnd); pStart.setUTCDate(pEnd.getUTCDate() - (WINDOW_DAYS - 1));
  return { cur: { startDate: ymd(start), endDate: ymd(end) }, prev: { startDate: ymd(pStart), endDate: ymd(pEnd) } };
}

const bare = (s) => String(s || '').toLowerCase().replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

// Which Search Console property (if any) the Box can read for each of our domains.
function matchProperties(domains, siteEntries) {
  const readable = (siteEntries || []).filter((s) => s.permissionLevel && s.permissionLevel !== 'siteUnverifiedUser');
  const out = {};
  for (const d of domains) {
    const hits = readable.filter((s) => bare(s.siteUrl) === bare(d));
    out[d] = (hits.find((s) => s.siteUrl.startsWith('sc-domain:')) || hits[0] || {}).siteUrl || null;
  }
  return out;
}

const normQ = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
  .map((w) => w.replace(/s$/, '')).sort().join(' ');

// rows: [{ site, query, page, clicks, impressions, ctr, position }]; prev: same shape for the window before.
function analyse(rows, prev = []) {
  const r2 = RULES.page2to5, rc = RULES.lowCtr;
  const page2to5 = rows.filter((r) => r.position >= r2.minPos && r.position <= r2.maxPos && r.impressions >= r2.minImpr)
    .sort((a, b) => b.impressions - a.impressions);
  const lowCtr = rows.filter((r) => r.position < rc.maxPos && r.impressions >= rc.minImpr && r.ctr < rc.maxCtr)
    .sort((a, b) => b.impressions - a.impressions);

  const byQ = new Map();
  for (const r of rows) {
    if (r.impressions < RULES.compete.minImprEach) continue;
    const k = normQ(r.query);
    if (!byQ.has(k)) byQ.set(k, []);
    byQ.get(k).push(r);
  }
  const competing = [...byQ.values()].map((list) => {
    const pages = new Map();
    for (const r of list) { const p = pages.get(r.page) || { site: r.site, page: r.page, impressions: 0, position: r.position, query: r.query }; p.impressions += r.impressions; pages.set(r.page, p); }
    return [...pages.values()];
  }).filter((pages) => pages.length >= 2).sort((a, b) => b.reduce((s, p) => s + p.impressions, 0) - a.reduce((s, p) => s + p.impressions, 0));

  const before = new Map(prev.map((r) => [`${r.page}\u0000${r.query}`, r]));
  const dropped = rows.map((r) => ({ r, was: before.get(`${r.page}\u0000${r.query}`) }))
    .filter(({ r, was }) => was && r.impressions >= RULES.dropped.minImpr && r.position - was.position >= RULES.dropped.positions)
    .map(({ r, was }) => ({ ...r, wasPosition: was.position }))
    .sort((a, b) => (b.position - b.wasPosition) - (a.position - a.wasPosition));
  return { page2to5, lowCtr, competing, dropped };
}

const pos = (n) => Number(n).toFixed(1);
const pct = (n) => (n * 100).toFixed(1) + '%';
const cell = (s) => String(s).replace(/\|/g, '/');

function tables(a, { limit = 10, facts = {} } = {}) {
  const t = [];
  const factCols = (p) => { const f = facts[p]; return f ? `${cell(f.title || '(no title)')} | ${cell(f.description || '(no description)')}` : '(not read) | (not read)'; };
  t.push('#### Page 2 to 5: we show up, but too low to be clicked\n| Site | Search | Our page | Position | Impressions | Clicks | Title now | Description now |\n|---|---|---|---|---|---|---|---|');
  t.push(...(a.page2to5.slice(0, limit).map((r) => `| ${r.site} | ${cell(r.query)} | ${r.page} | ${pos(r.position)} | ${r.impressions} | ${r.clicks} | ${factCols(r.page)} |`)));
  if (!a.page2to5.length) t.push('| (none this window) | | | | | | | |');
  t.push('\n#### Seen on page 1, almost never clicked\n| Site | Search | Our page | Position | Impressions | CTR | Title now | Description now |\n|---|---|---|---|---|---|---|---|');
  t.push(...(a.lowCtr.slice(0, limit).map((r) => `| ${r.site} | ${cell(r.query)} | ${r.page} | ${pos(r.position)} | ${r.impressions} | ${pct(r.ctr)} | ${factCols(r.page)} |`)));
  if (!a.lowCtr.length) t.push('| (none this window) | | | | | | | |');
  t.push('\n#### Our own pages competing for the same search\n| Search | Pages (impressions, position) |\n|---|---|');
  t.push(...(a.competing.slice(0, limit).map((ps) => `| ${cell(ps[0].query)} | ${ps.map((p) => `${p.page} (${p.impressions}, ${pos(p.position)})`).join('; ')} |`)));
  if (!a.competing.length) t.push('| (none this window) | |');
  t.push('\n#### Dropped 5 or more places since the 28 days before\n| Site | Search | Our page | Was | Now | Impressions |\n|---|---|---|---|---|---|');
  t.push(...(a.dropped.slice(0, limit).map((r) => `| ${r.site} | ${cell(r.query)} | ${r.page} | ${pos(r.wasPosition)} | ${pos(r.position)} | ${r.impressions} |`)));
  if (!a.dropped.length) t.push('| (none this window) | | | | | |');
  return t.join('\n');
}

function createClient({ token, fetchImpl = globalThis.fetch }) {
  const h = { Authorization: `Bearer ${token}` };
  async function sites() {
    const r = await fetchImpl(`${API}/sites`, { headers: h });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || `Search Console answered ${r.status}`);
    return j.siteEntry || [];
  }
  // searchAnalytics.query is a POST in Google's API but only reads. It is the
  // only POST this client can make, and only to that path.
  async function query(siteUrl, range, rowLimit = 1000) {
    const url = `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    if (!/\/searchAnalytics\/query$/.test(url)) throw new Error('refused');
    const r = await fetchImpl(url, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...range, dimensions: ['query', 'page'], rowLimit }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || `Search Console answered ${r.status}`);
    return (j.rows || []).map((x) => ({ query: x.keys[0], page: x.keys[1], clicks: x.clicks, impressions: x.impressions, ctr: x.ctr, position: x.position }));
  }
  return { sites, query };
}

module.exports = { analyse, tables, windows, matchProperties, normQ, createClient, RULES, SCOPE, LAG_DAYS, WINDOW_DAYS };
