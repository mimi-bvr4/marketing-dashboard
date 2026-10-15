#!/usr/bin/env node
// ORDER #1873: the Web Agent's Box step, run every 15 minutes by
// agents_handoff.sh. For each page Katherine uploaded on /web: upload her
// cleared photos to that site's Media Library, convert her HTML, save it as a
// NEW DRAFT page (never the live page), read it back, prove by snapshot that
// the draft is the only page that changed, run the QA, take the screenshots,
// and put a card on her Review tab. Publish requests are refused while the
// switch is OFF (lib/web-publish.js).
'use strict';

const W = require('../lib/web-wp');
const { convert, scopeName, basename } = require('../lib/web-convert');
const { runQa, visibleText, diffText } = require('../lib/web-qa');
const { previewDoc } = require('../lib/web-shots');
const { summary } = require('../lib/ai-tells');
const P = require('../lib/web-publish');

const AGENT = 'web-agent';
const AGENT_NAME = 'Web Agent';

function ctDate(now) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric' }).format(now).replace(/\//g, '.');
}

function cardBody({ site, r, qa, live, diff, shots }) {
  const L = [];
  if (r.alarm) L.push(`**${r.why}. Check page #${r.draft_id} in WordPress now.**`);
  else L.push(`**${r.ok ? 'Saved as a DRAFT' : 'NOT saved'} on ${site.name} (${site.domain}).** ${r.ok ? '' : r.why + '. '}Nothing was published${live ? `, and the live page ${live.id} was not touched` : ''}.`);
  if (r.draft_id) {
    L.push(`- [Preview the draft](${r.preview_link}) (sign in to WordPress first)`);
    L.push(`- [Open draft #${r.draft_id} in WordPress](${r.edit_link})`);
  }
  if (live) L.push(`- Replaces: [${live.title || 'page ' + live.id}](${live.link}) (page ${live.id}). Publishing it over the live page is OFF until Mimi rules it on; until then, copy it over from WordPress yourself.`);
  L.push(`- Proof: pages changed on the site: ${r.changed ? r.changed.join(', ') || 'none' : 'NOT CHECKED'}${r.proof_ok ? ' (only this draft)' : r.changed ? ' (MORE THAN THIS DRAFT, check now)' : ''}.`);
  if (r.media && r.media.length) L.push(`- Photos uploaded to the Media Library: ${r.media.map((m) => `${m.name} (#${m.id})`).join(', ')}`);
  L.push('', '### QA', '| Check | Result | Detail |', '|---|---|---|');
  for (const x of qa.rows) L.push(`| ${x.check} | ${x.verdict} | ${String(x.detail).replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
  L.push('', `Built with ${r.tally.core} core block(s) and ${r.tally.custom_html} Custom HTML block(s); your CSS is scoped to this page only (class ${r.scope}).`);
  if (diff) {
    L.push('', '### What changed versus the live page', `${diff.added} line(s) new, ${diff.removed} line(s) gone, ${diff.kept} the same.`);
    for (const a of diff.sample_added) L.push(`- new: "${a.slice(0, 140)}"`);
    for (const a of diff.sample_removed) L.push(`- gone: "${a.slice(0, 140)}"`);
  }
  L.push('', '### Screenshots', shots && shots.after
    ? `Phone 390px and desktop 1280px are on the [Web page](/web#r${r.request_id})${shots.before ? ', with the live page beside them' : ''}. They show your design without the theme's header and footer; the preview link shows it in the theme.`
    : `Not taken: ${shots && shots.why ? shots.why : 'no browser on this job'}. Walk the preview link on a phone and a computer.`);
  return L.join('\n');
}

async function buildOne(req, { store, cards, fetchImpl, login, shooter, now = new Date(), log = console.log }) {
  const site = W.siteOf(req.site);
  const wlog = (e) => store.log({ request_id: req.id, site: req.site, ...e });
  if (!site || site.squarespace) return { error: `${req.site} has no WordPress page API; copy the page by hand` };
  const c = W.client({ site: req.site, fetchImpl, login });
  if (c.error) return { error: c.error };

  let live = null;
  if (req.page_id) {
    live = await W.readPage(c, req.page_id);
    if (!live.ok) return { error: `could not read page ${req.page_id}: ${live.why}` };
  }
  const before = await W.snapshot(c);

  // Cleared photos her HTML uses go up first, so the draft can point at them.
  const used = new Set([...String(req.html).matchAll(/<img\b[^>]*\ssrc=["']([^"']+)["']/gi)].map((m) => basename(m[1])));
  const alts = new Map([...String(req.html).matchAll(/<img\b[^>]*>/gi)].map((m) => [basename((m[0].match(/\ssrc=["']([^"']+)/i) || [])[1]), (m[0].match(/\salt=["']([^"']*)/i) || [])[1]]));
  const assets = []; const media = []; const notes = [];
  for (const a of req.assets || []) {
    const key = String(a.name || '').toLowerCase();
    if (!a.cleared || !used.has(key)) { assets.push({ name: a.name, cleared: !!a.cleared }); if (a.cleared && !used.has(key)) notes.push(`${a.name} was uploaded but the HTML does not use it; not sent`); continue; }
    const u = await W.uploadMedia(c, { ...a, alt: alts.get(key) }, wlog);
    if (u.ok) { assets.push({ name: a.name, cleared: true, url: u.url, id: u.id }); media.push({ name: a.name, id: u.id }); } else { assets.push({ name: a.name, cleared: true }); notes.push(u.why); }
  }

  const scope = scopeName(`r${req.id}`);
  const conv = convert(req.html, { scope, assets });
  const baseTitle = req.new_title || (live && live.title) || conv.title || `Page from ${req.asked_by}`;
  const title = `DRAFT (Web Agent) ${ctDate(now)}: ${baseTitle}${live ? ` (replaces page ${live.id})` : ''}`;
  const d = await W.createDraftPage(c, { title, content: conv.content, parent: live ? live.parent : undefined }, wlog);
  const after = await W.snapshot(c);
  const changed = before.ok && after.ok ? W.changedIds(before.pages, after.pages) : null;
  const r = { request_id: req.id, ok: d.ok, alarm: !!d.alarm, why: d.why || null, draft_id: d.id || null, status: d.status || null,
    edit_link: d.edit_link || null, preview_link: d.preview_link || null, replaces: live ? live.id : null, title, scope, tally: conv.tally, media,
    changed, proof_ok: !!(changed && d.id && changed.length === 1 && changed[0] === d.id) };
  if (changed) await wlog({ action: 'read-back proof', post_id: d.id, detail: `pages changed: ${changed.join(', ') || 'none'}${r.proof_ok ? ' (only the draft)' : ''}` });

  const stored = d.raw || conv.content;
  const qa = runQa(stored, { site: site.code, held: conv.held, external: conv.external, notes: [...conv.notes, ...notes] });
  r.qa = qa.rows; r.qa_red = qa.red;
  const diff = live ? diffText(visibleText(live.rendered), qa.text) : null;
  r.diff = diff;

  let shots = null;
  if (shooter) {
    try {
      shots = { after: await shooter({ html: previewDoc(stored, title) }) };
      if (live && live.link) shots.before = await shooter({ url: live.link });
    } catch (e) { shots = { why: `the browser failed: ${String(e.message).split('\n')[0].slice(0, 200)}` }; }
  } else shots = { why: 'no browser on this machine\'s job path (set WEB_AGENT_PLAYWRIGHT)' };
  r.shots = shots;

  const card = await cards.insert({
    agent: AGENT, agent_name: AGENT_NAME, job: 'WordPress draft', target: `${site.code}${live ? ' page ' + live.id : ' new page'}`,
    title: `${site.code}: ${baseTitle}${d.alarm ? ` (ALARM, page #${d.id} is "${d.status}")` : d.ok ? ` (draft #${d.id})` : ' (NOT SAVED)'}`,
    body: cardBody({ site, r, qa, live, diff, shots }),
    sources: [{ label: `Katherine's HTML, request ${req.id}`, ok: true }, ...(live ? [{ label: `live page ${live.id}`, url: live.link, ok: true }] : [])],
    checks: { ai_tells: qa.lint, ai_tells_summary: summary(qa.lint), qa_red: qa.red, qa_amber: qa.amber },
    payload: { web: { request_id: req.id, site: site.code, draft_id: r.draft_id, replaces: r.replaces, preview_link: r.preview_link, edit_link: r.edit_link } },
  });
  log(`web ${req.id} ${site.code}: ${d.ok ? `draft #${d.id} (${d.status})` : `NOT SAVED: ${d.why}`}; changed ${changed ? changed.join(',') || 'none' : 'not checked'}; QA red ${qa.red} amber ${qa.amber}; card ${card.id}`);
  return d.ok ? { result: r, card_id: card.id } : { result: r, card_id: card.id, error: d.why };
}

async function runOnce({ store, cards, fetchImpl = globalThis.fetch, login, shooter = null, env = process.env, now = new Date(), log = console.log }) {
  const reqs = await store.take(2);
  for (const q of reqs) {
    try {
      const out = await buildOne(q, { store, cards, fetchImpl, login, shooter, now, log });
      await store.finish(q.id, out);
      if (out.error && !out.result) log(`web ${q.id}: refused, ${out.error}`);
    } catch (e) {
      await store.finish(q.id, { error: e.message });
      log(`web ${q.id}: FAILED ${e.message}`);
    }
  }
  // Publish requests: the route refuses them while the switch is OFF, so these
  // exist only if it was ON there. The Box checks its own switch again.
  for (const q of await store.takePublish(2)) {
    const wlog = (e) => store.log({ request_id: q.id, site: q.site, ...e });
    if (!P.publishOn(env)) { await wlog({ action: 'publish refused', post_id: q.result && q.result.draft_id, detail: 'switch OFF on the Box' }); await store.setStatus(q.id, 'done', { publish: P.refusal() }); continue; }
    const c = W.client({ site: q.site, fetchImpl, login });
    const out = c.error ? { ok: false, why: c.error } : await P.publish({ c, request: q, env, log: wlog });
    await store.setStatus(q.id, out.ok ? 'published' : 'done', { publish: out });
    log(`web ${q.id}: publish ${out.ok ? 'done' : 'not done: ' + out.why}`);
  }
  log(`web agent: ${reqs.length} page(s) built; publish switch ${P.publishOn(env) ? 'ON' : 'OFF'}`);
  return reqs.length;
}

async function main({ env = process.env, log = console.log } = {}) {
  if (!env.MARKETING_DATABASE_URL) { log('NOT RUN: MARKETING_DATABASE_URL is not set'); return 3; }
  const { Pool } = require('pg');
  const S = require('../lib/web-store');
  const { createPgStore: createAgentStore, ensureAgentTables } = require('../lib/agent-store');
  const { lint } = require('../lib/ai-tells');
  const { createShooter } = require('../lib/web-shots');
  const pool = new Pool({ connectionString: env.MARKETING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await S.ensureWebTables(pool);
    await ensureAgentTables(pool);
    await runOnce({ store: S.createPgStore(pool), cards: createAgentStore(pool, { lint }), shooter: createShooter(), env, log });
    return 0;
  } finally { await pool.end(); }
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('web_run:', e.message); process.exit(1); });

module.exports = { runOnce, buildOne, cardBody, AGENT, AGENT_NAME };
