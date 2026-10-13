// ORDER #1668: competitor profiles, refreshed weekly.
//
// Mimi 10.12.2026: "I would like competitor profiles built for each competitor
// that we can update weekly. just the top ones if that tracks." Rulings:
//   - the list is Katherine's "IHG Competitors" Google Sheet (lib/competitor-sheet.js);
//   - "top" = on 3 or more of its tabs, or marked in a Top column;
//   - our own venues on the sheet are skipped.
//
// The weekly order (jobs/agent_run.js --due, Mondays):
//   1. syncFromSheet: read the sheet (read-only) and update the competitor list;
//   2. the Scout runs and reads every top competitor's site (agent-sources.js),
//      recording what changed per site;
//   3. writeProfiles: one profile per top competitor, from what the Scout saw,
//      the sheet's notes and Katherine's own notes. Every version is kept.
//
// Profiles are internal reading for Katherine and sales. Nothing is published,
// nothing is sent, no competitor's words are copied beyond short quoted lines.
'use strict';

const { parseSheet, readSheet, SHEET_ID } = require('./competitor-sheet');
const { lint, replaceDashes } = require('./ai-tells');

const MAX_TOP = 20;            // profiles written per week (the Scout's crawl is polite; so is this)
const PAGE_CHARS = 2500;       // per page handed to the model
const SITE_CHARS = 18000;      // per competitor in total

const HEADINGS = ['At a glance', 'Spaces and events they sell', 'Packages and pricing they publish', 'What they push right now',
  'What changed recently', 'Where we win', 'Watch for'];

const SYSTEM = `You write short, factual competitor profiles for Infinity Hospitality Group's marketing director and sales team (Nashville event venues and catering).
Rules:
- Use ONLY the evidence given: the competitor's own public pages as read this week, the notes from IHG's competitor sheet, and Katherine's notes. If something is not in the evidence, write "not published" or leave it out. Never guess capacities, prices or dates.
- Quote at most one short line from their site per section, in quotation marks. Never copy whole paragraphs.
- Plain English, no hype, no em dashes, no "in today's landscape", no "delve", no rhetorical questions.
- Markdown with exactly these level-2 headings, in this order: ${HEADINGS.map((h) => `"## ${h}"`).join(', ')}.
- "Where we win" is IHG's angle, framed as suggestions for Katherine, never as claims about the competitor's quality.
- Keep the whole profile under 450 words.`;

// 1. The sheet -> the competitor list. Never throws: says why it could not read.
async function syncFromSheet({ store, drive, log = () => {} }) {
  if (!store || !store.syncCompetitors) return { ok: false, why: 'no competitor store' };
  if (!drive) return { ok: false, why: 'no Google service account on this machine' };
  let tabs;
  try { tabs = await readSheet(drive, SHEET_ID); }
  catch (e) {
    const why = /403|404|permission|not found/i.test(e.message)
      ? `the competitor sheet is not shared with ${drive.serviceAccount || 'the Brain service account'} (Viewer is enough): ${e.message}`
      : e.message;
    log(`competitors: sheet not read: ${why}`);
    return { ok: false, why };
  }
  const parsed = parseSheet(tabs);
  if (!parsed.competitors.length) return { ok: false, why: 'the sheet was read but no competitor rows were found (a tab needs a Name and a URL column)' };
  await store.syncCompetitors(parsed.competitors);
  const top = parsed.competitors.filter((c) => c.top).length;
  log(`competitors: ${parsed.competitors.length} on the sheet, ${top} top; our own skipped: ${parsed.ours.length}; no website: ${parsed.skipped.length}`);
  return { ok: true, count: parsed.competitors.length, top, ours: parsed.ours, skipped: parsed.skipped };
}

function evidenceFor(c, pages) {
  const sorted = (pages || []).slice().sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)));
  let used = 0;
  const parts = [];
  for (const p of sorted) {
    if (used >= SITE_CHARS) break;
    const t = String(p.text || '').slice(0, Math.min(PAGE_CHARS, SITE_CHARS - used));
    used += t.length;
    parts.push(`--- ${p.path}${p.title ? ` "${p.title}"` : ''}\n${t}`);
  }
  return [
    `COMPETITOR: ${c.name} (${c.site})`,
    `ON IHG'S SHEET FOR: ${(c.brands || []).join(', ') || 'unknown'}${(c.segments || []).length ? `; listed under ${c.segments.join(', ')}` : ''}`,
    (c.sheet_notes || []).length ? `SHEET NOTES:\n- ${c.sheet_notes.join('\n- ')}` : null,
    c.kh_notes ? `KATHERINE'S NOTES:\n${c.kh_notes}` : null,
    c.last_changes ? `WHAT THE SCOUT SAW CHANGE (${c.changes_at ? new Date(c.changes_at).toISOString().slice(0, 10) : 'last run'}):\n${c.last_changes}` : 'WHAT THE SCOUT SAW CHANGE: nothing recorded yet',
    parts.length ? `THEIR PUBLIC PAGES THIS WEEK:\n${parts.join('\n\n')}` : 'THEIR PUBLIC PAGES THIS WEEK: none read yet',
  ].filter(Boolean).join('\n\n');
}

// A model answer is kept only if it has every heading; dashes are replaced.
function cleanProfile(text) {
  let md = String(text || '').trim().replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
  const missing = HEADINGS.filter((h) => !new RegExp(`^##\\s+${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(md));
  if (missing.length) return { error: `missing section(s): ${missing.join(', ')}` };
  const d = replaceDashes(md);
  md = d.text;
  const tells = lint(md);
  return { md, dashes: d.replaced, tells };
}

// 3. Profiles for the top competitors. The model is the Box's Anthropic key.
async function writeProfiles({ store, llm, log = () => {}, agent = 'scout' }) {
  if (!llm) return { ok: false, why: 'no model key on this machine', written: 0 };
  const top = (await store.competitors()).filter((c) => c.top).slice(0, MAX_TOP);
  if (!top.length) return { ok: false, why: 'no top competitors yet (sync the sheet first)', written: 0 };
  let written = 0; const failed = [];
  for (const c of top) {
    const pages = await store.snapshots(agent, c.site);
    if (!pages.length && !(c.sheet_notes || []).length && !c.kh_notes) { failed.push({ site: c.site, why: 'nothing read yet (the Scout reads it on its next run)' }); continue; }
    try {
      let out = cleanProfile(await llm.complete({ system: SYSTEM, user: evidenceFor(c, pages), maxTokens: 1500 }));
      if (out.error || (out.tells && !out.tells.clean)) {
        const why = out.error || 'AI-tell phrases';
        out = cleanProfile(await llm.complete({ system: SYSTEM, user: `${evidenceFor(c, pages)}\n\nYour last draft was refused (${why}). Write it again following every rule.`, maxTokens: 1500 }));
      }
      if (out.error) { failed.push({ site: c.site, why: out.error }); continue; }
      await store.saveProfile(c.site, out.md);
      written++;
    } catch (e) { failed.push({ site: c.site, why: e.message }); }
  }
  log(`competitors: ${written} profile(s) written${failed.length ? `, ${failed.length} not: ${failed.map((f) => `${f.site} (${f.why})`).join('; ')}` : ''}`);
  return { ok: written > 0, written, failed };
}

module.exports = { syncFromSheet, writeProfiles, evidenceFor, cleanProfile, HEADINGS, SYSTEM, MAX_TOP };
