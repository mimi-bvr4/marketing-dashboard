'use strict';
// ORDER #3801 (Mimi 11.24.2026): "Crawl limits are invisible right now. Show
// them." Each crawling agent states its pages-per-run cap and what it did not
// reach this run; Site Health walks every sitemap on a stated cycle; the
// rotation (agent x site x day) is on /agents.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CP = require('../lib/crawl-plan');
const R = require('../lib/competitor-rotation');
const { REGISTRY } = require('../lib/agent-sources');
const { lint } = require('../lib/ai-tells');
const { createMemoryStore } = require('../lib/agent-store');
const { parseSheet } = require('../lib/competitor-sheet');

const MON = new Date('2026-11-23T18:00:00Z');
const weeks = (n) => new Date(MON.getTime() + n * 7 * 86400000);
const urls = (site, n) => Array.from({ length: n }, (_, i) => `https://${site}/page-${String(i).padStart(4, '0')}/`);
const agentJson = (slug) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', slug, 'agent.json'), 'utf8'));

test('#3801 a big sitemap (162 pages, dreameventsandcatering.com on 11.25) is read in full within 4 weeks, each page once', () => {
  const rest = urls('dreameventsandcatering.com', 162);
  const seen = new Map();
  let w0;
  for (let i = 0; i < CP.CYCLE_WEEKS; i++) {
    const w = CP.pickWindow(rest, { per: 15, now: weeks(i) });
    if (!i) w0 = w;
    for (const u of w.urls) seen.set(u, (seen.get(u) || 0) + 1);
  }
  assert.strictEqual(w0.size, 41, 'ceil(162 / 4)');
  assert.strictEqual(w0.windows, 4);
  assert.strictEqual(seen.size, 162, 'every page read in the cycle');
  assert.ok([...seen.values()].every((n) => n === 1), 'no page read twice in one cycle (no double crawling)');
});

test('#3801 a small sitemap keeps the 15-page floor and finishes sooner', () => {
  const w = CP.pickWindow(urls('thecordelle.com', 16), { per: 15, now: MON });
  assert.strictEqual(w.size, 14, 'per - 1: the home page is the 15th');
  assert.strictEqual(w.windows, 2);
  const all = CP.pickWindow(urls('dailydishcatering.com', 8), { per: 15, now: MON });
  assert.strictEqual(all.notReached, 0, 'a site under the cap is read whole every week');
});

test('#3801 KNOWN-BAD: a sitemap over the hard cap says its real (longer) cycle, never "4 weeks"', () => {
  const w = CP.pickWindow(urls('huge.com', 1000), { per: 15, now: MON });
  assert.strictEqual(w.size, CP.MAX_PAGES_PER_SITE - 1);
  assert.strictEqual(w.windows, Math.ceil(1000 / 49));
  assert.ok(w.windows > CP.CYCLE_WEEKS);
});

test('#3801 the window is the same whatever order the sitemap lists its pages', () => {
  const rest = urls('thebridgebuilding.com', 36);
  const a = CP.pickWindow(rest, { per: 15, now: MON }).urls;
  const b = CP.pickWindow([...rest].reverse(), { per: 15, now: MON }).urls;
  assert.deepStrictEqual(a, b);
});

function fakeFetch(map, hits) {
  return async (u) => {
    hits.push(u);
    const { pathname, hostname } = new URL(u);
    if (pathname === '/sitemap.xml') {
      const locs = (map[hostname] || []).map((x) => `<url><loc>${x}</loc></url>`).join('');
      return { status: 200, url: u, headers: { get: () => 'application/xml' }, text: async () => `<urlset>${locs}</urlset>` };
    }
    return { status: 200, url: u, headers: { get: () => 'text/html' }, text: async () => '<html><head><title>T ' + pathname + '</title><meta name="description" content="d"></head><body><h1>H</h1><p>Plain words.</p></body></html>' };
  };
}

test('#3801 Site Health card states its cap and what it did not reach, and reads only this week\'s window', async () => {
  const map = { 'big.com': urls('big.com', 100), 'small.com': urls('small.com', 5) };
  const hits = [];
  const r = await REGISTRY.site_crawl({ sites: ['big.com', 'small.com'], pages_per_site: 15, rotate: true, cycle_weeks: 4 },
    { fetch: fakeFetch(map, hits), lint, now: () => MON });
  assert.strictEqual(r.ok, true, r.why);
  assert.match(r.table, /^Crawl limit: 15 pages per site per run, more on a big site \(up to 50\), so every sitemap page is read at least once every 4 weeks\. Not reached this run: 75 sitemap pages on 1 site \(their turn comes on a later Monday\)\./);
  assert.match(r.table, /\| Site \| Sitemap \| Pages in sitemap \| Pages checked \| Not reached this run \|/);
  const idx = R.weekNumber(MON) % 4;
  assert.match(r.table, new RegExp(`\\| big\\.com \\| /sitemap\\.xml \\| 100 \\| 26 \\| 75 \\(read sitemap pages ${idx * 25 + 1} to ${idx * 25 + 25} of 100; turn ${idx + 1} of 4, every page every 4 weeks\\) \\|`));
  assert.match(r.table, /\| small\.com \| \/sitemap\.xml \| 5 \| 6 \| 0 \|/);
  const bigPages = hits.filter((u) => /big\.com\/page-/.test(u));
  assert.strictEqual(bigPages.length, 25, 'only this week\'s window is fetched');
  assert.deepStrictEqual(r.measured.crawl, { cap: 15, rotate: true, read: 26 + 6, not_reached: 75, sites_unreachable: 0 });
  assert.ok(!/—/.test(r.table), 'no em dash');
});

test('#3801 KNOWN-BAD: without rotation, the pages past the cap are named as never read', async () => {
  const r = await REGISTRY.site_crawl({ sites: ['big.com'], pages_per_site: 15 },
    { fetch: fakeFetch({ 'big.com': urls('big.com', 100) }, []), lint, now: () => MON });
  assert.match(r.table, /^Crawl limit: 15 pages per site per run\. Not reached this run: 86 sitemap pages on 1 site\./);
  assert.match(r.table, /\| 86 \(past the 15-page cap; not read on any run\) \|/);
});

test('#3801 Site Health rotates, and SEO\'s shared-title check reads the same window (no second set of pages)', () => {
  const sh = agentJson('site-health').sources.find((s) => s.type === 'site_crawl');
  const seo = agentJson('seo').sources.find((s) => s.type === 'site_crawl');
  assert.strictEqual(sh.rotate, true);
  for (const k of ['pages_per_site', 'rotate', 'cycle_weeks', 'max_pages_per_site']) assert.strictEqual(seo[k], sh[k], k);
  assert.deepStrictEqual(seo.sites, sh.sites);
});

test('#3801 every crawling agent states its cap; the rotation names every one', () => {
  const crawlers = ['site-health', 'seo', 'scout', 'citations', 'engagement-sleuth'];
  for (const slug of crawlers) {
    const lines = CP.crawlLimits(agentJson(slug));
    assert.ok(lines.length, `${slug} states no crawl limit`);
    assert.ok(lines.every((l) => /\d/.test(l) && !/—/.test(l)), `${slug}: every line has a number and no em dash`);
  }
  assert.deepStrictEqual(CP.crawlLimits({ sources: [{ type: 'file', path: 'x.md' }] }), [], 'an agent that reads no pages shows no crawl line');
  assert.match(CP.crawlLimits(agentJson('site-health'))[0], /^Reads 15 pages on each of 12 sites per run, more on a big site \(up to 50\), so every page in each sitemap is read at least once every 4 weeks\./);
  const names = CP.ROTATION.map((r) => r.agent).join(' | ');
  for (const n of ['Site Guardian', 'Site Health', 'SEO', 'Scout', 'Listings + Citations', 'Engagement Sleuth']) assert.ok(names.includes(n), `${n} missing from the rotation`);
  const t = CP.rotationTable();
  assert.match(t, /^\| Agent \| Sites \| When \| Pages per run \| Covers \|/);
  assert.ok(!/—/.test(t));
});

test('#3801 KNOWN-BAD (#3800 regression): the Scout reads its rotating group when the runner passes now as a function', async () => {
  const H = ['Name', 'URL', 'Notes', 'Top'];
  const rows = Array.from({ length: 40 }, (_, i) => [`Barn ${i}`, `barn${i}.com`, '', '']);
  const store = createMemoryStore({ lint });
  await store.syncCompetitors(parseSheet([{ title: 'TBB - Competitors', rows: [H, ...rows] }]).competitors);
  const hosts = new Set();
  const r = await REGISTRY.competitor_watch({ pages_per_site: 1 }, { store, agent: 'scout', dryRun: true, now: () => MON,
    fetch: async (u) => { hosts.add(new URL(u).hostname); return { status: 200, headers: { get: () => 'text/html' }, text: async () => '<html><title>Hi</title><body><p>Hello.</p></body></html>' }; } });
  assert.strictEqual(r.ok, true, r.why);
  assert.ok(!/NaN/.test(r.table), 'the plan line never says "group NaN"');
  const expected = rows.map((x) => x[1]).filter((s) => R.slotOf(s) === R.slotThisWeek(MON));
  assert.ok(expected.length > 0);
  assert.deepStrictEqual([...hosts].sort(), expected.sort(), 'this week\'s group is read, not nobody');
});

test('#3801 /api/agents carries crawl_limits and the rotation; the page renders both', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'agents.js'), 'utf8');
  assert.match(route, /crawl_rotation: crawlPlan\.ROTATION/);
  assert.match(route, /crawl_limits: crawlPlan\.crawlLimits\(d\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
  assert.match(html, /data-crawl-rotation/);
  assert.match(html, /Crawl limit:/);
  assert.match(html, /\$\{rotationHtml\(\)\}/);
});
