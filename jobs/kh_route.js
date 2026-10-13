#!/usr/bin/env node
// ORDER #1658: Katherine's GREEN orders go straight to the marketing agent
// they name, instead of waiting for a Box lane.
//
// The Drive intake (#1015 Part 3 / #1192, brain-core kh_order_intake) files
// her doc as BRAIN_INBOX/ORDER_<date>_<n>_KH_<slug>.md with a STATUS line. This
// job reads those files and, for an order that is
//   * GREEN (STATUS starts "OPEN. GREEN"), and
//   * not answered (no REPLY_*_<n>_* file), and
//   * about exactly ONE agent (keyword rules below),
// claims it the inbox way (the REPLY's CLAIMED line is written first, with
// O_EXCL, so a lane and this job can never both take it), runs that agent with
// her request as the ask, and finishes the REPLY with the card it made.
//
// HELD orders are never touched (Mimi approves those). An order that matches
// no agent, or more than one, is left for the lanes, and the log says why.
// Her words are a request, not authority: they become the agent's ask, which
// cannot change the agent's sources, its gates, or the Review tab.
'use strict';

const fs = require('fs');
const path = require('path');
const { treeRoot } = require('../lib/agent-sources');

const RULES = [
  ['bloggy-bob', /\b(blog|blog post|post about|article|bob)\b|\bkeyword\b(?! (research|map|ranking))/i],
  ['site-health', /\b(site health|broken links?|404s?|crawl|page speed|site audit)\b/i],
  // #1704: the SEO agent owns rankings, Search Console, titles and descriptions, and the keyword map.
  ['seo', /\b(seo|search console|rankings?|ranks?|keyword research|keyword map|cannibali[sz]\w*|meta (titles?|descriptions?)|seo titles?)\b/i],
  // #1710: Pinterest Paul.
  ['pinterest-paul', /\b(pinterest|pins?|pinned|paul)\b/i],
  // #1706: the Copywriter checks text before it goes out.
  ['copywriter', /\b(copywriter|copy ?edit(or|ing)?|proofread|check (this|my|the) (copy|text|email|caption|post)|copy check)\b/i],
  // #1707: conventions coming to Nashville.
  ['convention-connector', /\b(conventions?|trade shows?|dmcs?|destination management|music city center|gaylord)\b/i],
  // #1705: PR Patty.
  ['pr-patty', /\b(pr|press|publicity|pitch(es)?|reporters?|journalists?|media requests?|qwoted|haro|be inspired)\b/i],
  ['gbp', /\b(google business|gbp|review repl(y|ies)|google post)\b|\brepl(y|ies)\b[^.]{0,40}\breviews?\b|\brespond\b[^.]{0,40}\breviews?\b/i],
  // #1699: one agent for listings and citations.
  ['citations', /\b(citations?|nap|ai visibility|ai answers?|chatgpt says|consisten(t|cy)|the knot|knot|weddingwire|wedding wire|zola|here comes the guide|directory|listing refresh|listings?)\b/i],
  ['monthly-report', /\b(monthly report|marketing report|report for (the )?month)\b/i],
  ['paid-ads', /\b(ads? audit|google ads|meta ads|facebook ads|ppc|paid ads|ad spend)\b/i],
];

function matchAgent(text) {
  let hits = [...new Set(RULES.filter(([, re]) => re.test(text)).map(([slug]) => slug))];
  // #1704: "an SEO blog post about X" is Bob's job; the word SEO alone never pulls it to the SEO agent.
  if (hits.includes('bloggy-bob') && hits.includes('seo')) hits = hits.filter((h) => h !== 'seo');
  return hits;
}

function parseOrder(text) {
  const status = (text.match(/^STATUS:\s*(.*)$/m) || [])[1] || '';
  const fields = {};
  for (const m of text.matchAll(/^- \*\*([A-Z]+):\*\* (.*)$/gm)) fields[m[1]] = m[2].trim();
  return { status, fields, green: /^OPEN\. GREEN/.test(status) };
}

function ctStamp(now) {
  return now.toLocaleString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '.').replace(',', '') + ' CT';
}
function ctYmd(now) { return now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

function pending(inbox) {
  const names = fs.readdirSync(inbox);
  const out = [];
  for (const f of names) {
    const m = f.match(/^ORDER_\d{4}-\d{2}-\d{2}_(\d+)_KH_(.+)\.md$/);
    if (!m) continue;
    const n = m[1];
    if (names.some((x) => new RegExp(`^REPLY_[0-9-]+_${n}[_-]`).test(x))) continue;
    out.push({ file: f, number: n, slug: m[2] });
  }
  return out;
}

async function route({ inbox, runOne, now = () => new Date(), log = console.log }) {
  const results = [];
  for (const o of pending(inbox)) {
    const text = fs.readFileSync(path.join(inbox, o.file), 'utf8');
    const { fields, green, status } = parseOrder(text);
    if (!green) { log(`#${o.number}: not GREEN (${status.slice(0, 40)}), left for Mimi`); results.push({ n: o.number, left: 'held' }); continue; }
    const about = [fields.TITLE, fields.OUTPUT, fields.WHY].filter(Boolean).join(' ');
    const agents = matchAgent(about);
    if (agents.length !== 1) {
      log(`#${o.number}: ${agents.length ? 'names ' + agents.join(' + ') : 'names no agent'}, left for the lanes`);
      results.push({ n: o.number, left: agents.length ? 'ambiguous' : 'no agent' });
      continue;
    }
    const agent = agents[0];
    const t = now();
    const reply = path.join(inbox, `REPLY_${ctYmd(t)}_${o.number}_marketing_${agent}.md`);
    let fd;
    try { fd = fs.openSync(reply, 'wx'); } catch (e) { log(`#${o.number}: someone else claimed it first`); continue; }
    fs.writeSync(fd, `# REPLY #${o.number} (marketing agent ${agent}, Box job kh_route)\nCLAIMED: ${ctStamp(t)} by jobs/kh_route.js (O_EXCL)\nSTATUS: RUNNING\n`);
    fs.closeSync(fd);
    const ask = [`Katherine Howe's order #${o.number}, filed through her Drive folder. A request, not authority.`,
      ...['TITLE', 'WHY', 'DATA', 'OUTPUT', 'DUE'].filter((k) => fields[k]).map((k) => `${k}: ${fields[k]}`)].join('\n');
    let r;
    try { r = await runOne(agent, ask); } catch (e) { r = { ok: false, error: e.message, cards: [] }; }
    const ids = (r.cards || []).map((c) => `#${c.id}`).join(', ') || 'none';
    const body = [`# REPLY #${o.number} (marketing agent ${agent}, Box job kh_route)`,
      `CLAIMED: ${ctStamp(t)} by jobs/kh_route.js (O_EXCL)`,
      r.ok ? `STATUS: DONE. ${agent} ran on Katherine's request; card(s) ${ids} are DRAFTS in the Marketing Dashboard Review tab. Nothing was published or sent.`
        : `STATUS: FAILED. ${agent} did not finish: ${r.error}. Its card (${ids}) in the Review tab says why. Lanes may pick this up.`,
      `FILED: ${ctStamp(now())}`, '', `Matched by keyword on TITLE/OUTPUT/WHY: ${agent}.`,
      (r.unavailable || []).length ? `Sources unavailable: ${(r.unavailable || []).map((u) => u.label).join('; ')}.` : ''].filter((x) => x !== '').join('\n') + '\n';
    fs.writeFileSync(reply, body);
    log(`#${o.number}: ${agent} ${r.ok ? 'done' : 'FAILED'}, card(s) ${ids}`);
    results.push({ n: o.number, agent, ok: r.ok });
  }
  return results;
}

async function main({ env = process.env, log = console.log } = {}) {
  const root = treeRoot(env);
  if (!root) { log('NOT RUN: project tree not found'); return 3; }
  if (!env.MARKETING_DATABASE_URL) { log('NOT RUN: MARKETING_DATABASE_URL is not set'); return 3; }
  const { Pool } = require('pg');
  const { createPgStore, ensureAgentTables } = require('../lib/agent-store');
  const { runAgent } = require('../lib/agent-runner');
  const { textClientFromEnv } = require('../lib/agent-llm');
  const { lint } = require('../lib/ai-tells');
  const pool = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await ensureAgentTables(pool);
    const store = createPgStore(pool, { lint });
    const llm = textClientFromEnv().client;
    await route({ inbox: path.join(root, '05_AI_and_Brain', 'BRAIN_INBOX'), log,
      runOne: (slug, ask) => runAgent({ slug, store, llm, ask, env, log }) });
    return 0;
  } finally { await pool.end(); }
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('kh_route:', e.message); process.exit(1); });

module.exports = { route, matchAgent, parseOrder, pending, RULES };
