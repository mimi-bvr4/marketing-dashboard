// ORDER #3801 (Mimi 11.24.2026): "Crawl limits are invisible right now. Show
// them." and "Decide a rotation: which agent looks at what, and when, so all our
// sites and all their pages get covered on a stated cycle with no double-crawling."
//
// Three things live here, so the crawl, the agents page and the tests read one source:
//   1. pickWindow(): which of a site's sitemap pages a rotating crawl reads this
//      week. The home page every week; the rest of the sitemap in turns, sized so
//      every page is read within `cycle_weeks` (default 4), never fewer than the
//      agent's `pages_per_site` and never more than `max_pages_per_site`.
//   2. crawlLimits(): one plain line per crawling source of an agent, stating
//      its page cap (the agents page shows these on each card and profile).
//   3. ROTATION: who looks at what, and when (agent x site x day).
// The week clock is the Scout's (#3800, lib/competitor-rotation.js), so both
// rotations turn over on the same Monday.
'use strict';

const { weekNumber } = require('./competitor-rotation');

const CYCLE_WEEKS = 4;
const MAX_PAGES_PER_SITE = 50;

// rest: the site's sitemap URLs, home page excluded. Sorted first, so the same
// sitemap gives the same windows whatever order the site lists it in.
function pickWindow(rest, { per = 15, cycle = CYCLE_WEEKS, max = MAX_PAGES_PER_SITE, now = new Date() } = {}) {
  const all = [...new Set(rest)].sort();
  const n = all.length;
  const floor = Math.max(1, per - 1);
  const ceil = Math.max(floor, max - 1);
  const size = Math.min(ceil, Math.max(floor, Math.ceil(n / Math.max(1, cycle))));
  const windows = Math.max(1, Math.ceil(n / size));
  const index = weekNumber(now) % windows;
  const urls = all.slice(index * size, index * size + size);
  return { urls, size, windows, index, total: n, notReached: n - urls.length, first: n ? index * size + 1 : 0, last: index * size + urls.length };
}

function siteCrawlLimit(src) {
  const per = src.pages_per_site || 15;
  const n = (src.sites || []).length;
  const sites = n === 1 ? src.sites[0] : `each of ${n} sites`;
  if (src.only === 'same_titles') return `Reads up to ${per} pages on ${sites} for shared titles, the same pages Site Health reads that week, and only while PRODUCER_QUEUE is on.`;
  if (src.rotate) {
    const cycle = src.cycle_weeks || CYCLE_WEEKS;
    const max = src.max_pages_per_site || MAX_PAGES_PER_SITE;
    return `Reads ${per} pages on ${sites} per run, more on a big site (up to ${max}), so every page in each sitemap is read at least once every ${cycle} weeks. The home page is read every run. Each card lists the pages it did not reach this run.`;
  }
  return `Reads up to ${per} pages on ${sites} per run (the home page, then the sitemap in order). Pages past that are not read.`;
}

function crawlLimits(d) {
  const out = [];
  for (const src of (d && d.sources) || []) {
    if (src.type === 'site_crawl') out.push(siteCrawlLimit(src));
    else if (src.type === 'competitor_watch') out.push(`Reads up to ${src.pages_per_site || 12} public pages on each competitor site it reads that week (pricing, package and wedding pages first).`);
    else if (src.type === 'search_console') out.push(`Reads up to ${src.max_pages || 12} of our live pages per run, for their current title and description (the pages it rewrites).`);
    else if (src.type === 'ai_cited_sources') out.push(`Reads up to ${src.max_pages || 40} pages that AI assistants cite, per run.`);
    else if (src.type === 'wp_posts') out.push(`Reads the list of published posts on ${(src.sites || []).length} WordPress sites (up to 10 pages of 100 posts each), not the pages themselves.`);
  }
  return out;
}

// Who looks at what, and when. One row per agent that reads web pages. "Pages"
// is the cap per run; "Covers" is what the cycle reaches. Our own sites are
// crawled by Site Health alone; every other read of our pages is named here
// with why it is not a second crawl.
const OUR_SITES = 'all 12 of our sites';
const ROTATION = [
  { agent: 'Site Guardian (the Box)', sites: '9 WordPress sites (not the 3 Elle Squarespace sites)', day: 'Every 5 minutes; a daily pass once a day', pages: '2 per site (home page and feed)', covers: 'Up or down, certificates, domains, DNS and hack signals. Not page content.' },
  { agent: 'Site Health', sites: OUR_SITES, day: 'Mondays 06:00 CT', pages: '15 per site, up to 50 on a big site', covers: 'Every page in every sitemap at least once every 4 weeks; the home pages every week.' },
  { agent: 'SEO', sites: OUR_SITES, day: 'Mondays 06:00 CT', pages: 'Up to 12 pages, from Search Console', covers: 'Only the pages it rewrites a title for. Its shared-title check (behind PRODUCER_QUEUE, off by default) reads the same pages as Site Health that week.' },
  { agent: 'Scout', sites: 'Competitor sites (never ours)', day: 'Mondays 06:00 CT', pages: '12 per competitor', covers: 'Top competitors every week; the rest of the sheet once every 4 weeks (#3800).' },
  { agent: 'Listings + Citations', sites: '8 venue sites', day: 'The 15th of each month, 06:00 CT', pages: '3 per site', covers: 'The home page and two more, checked against the canonical venue facts. A monthly fact check, not a health crawl.' },
  { agent: 'Engagement Sleuth', sites: 'nashvilleweddingvenue.com', day: 'Fridays 06:00 CT, once switched on (off today)', pages: '10', covers: 'The landing pages its ads would point to.' },
];

function rotationTable(rows = ROTATION) {
  return '| Agent | Sites | When | Pages per run | Covers |\n|---|---|---|---|---|\n'
    + rows.map((r) => `| ${r.agent} | ${r.sites} | ${r.day} | ${r.pages} | ${r.covers} |`).join('\n');
}

module.exports = { CYCLE_WEEKS, MAX_PAGES_PER_SITE, pickWindow, crawlLimits, siteCrawlLimit, ROTATION, rotationTable };
