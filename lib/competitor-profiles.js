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
const { snapshotter, checkClaims, applyGate, gateSections } = require('./quote-gate');

const MAX_TOP = 20;            // profiles written per week (the Scout's crawl is polite; so is this)
const PAGE_CHARS = 2500;       // per page handed to the model
const SITE_CHARS = 18000;      // per competitor in total

// ORDER #1702 (Mimi 10.13.2026, on a profile that read "IHG tracks it as a
// competitor for Executive/Corporate Dinners (ECD), The Big Board (TBB), and The
// Big Table (TBT) segments ... I am utterly embarrassed by this"): the sheet's tab
// names are IHG's own brand codes, and the model was handed the bare codes and
// invented what they stand for. The codes never reach the model again; it gets
// the real names (Venue_Master_CANONICAL.md and the brand list), is told never to
// expand an abbreviation, and any "Something (CODE)" it still writes that is not
// the real name refuses the profile.
const BRAND_NAMES = {
  TBB: 'The Bridge Building', TBT: 'The Bell Tower', ECD: 'The Estate at Cherokee Dock', SWF: 'Saddle Woods Farm',
  COR: 'The Cordelle', STE: 'Saint Elle', EST: 'Estelle',
  DEC: 'Dream Events & Catering', DD: 'DailyDish', IHG: 'Infinity Hospitality Group', NLP: 'Nashville Lighting and Production',
};
const brandName = (code) => BRAND_NAMES[String(code || '').toUpperCase()] || null;
// Codes that never mean anything else in prose; a bare one is swapped for its name.
const SAFE_SWAP = ['TBB', 'TBT', 'ECD', 'SWF', 'NLP', 'DEC'];
const CODE_RE = new RegExp(`\\(\\s*(${Object.keys(BRAND_NAMES).join('|')})\\s*\\)`, 'g');
// Every "<words> (CODE)" whose words are not that code's real name.
function inventedCodes(md) {
  const out = [];
  const text = String(md || '');
  let m;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 80), m.index).replace(/\s+$/, '');
    const name = BRAND_NAMES[m[1]];
    if (!before.toLowerCase().endsWith(name.toLowerCase()) && !before.toLowerCase().endsWith(name.replace(/^The /, '').toLowerCase())) {
      out.push(`${before.split(/[,;:.]\s*/).pop().trim()} (${m[1]})`);
    }
  }
  return out;
}
function swapCodes(md) {
  let t = String(md || '');
  for (const c of SAFE_SWAP) t = t.replace(new RegExp(`(?<![A-Za-z(])${c}(?![A-Za-z)])`, 'g'), BRAND_NAMES[c]);
  return t;
}

const HEADINGS = ['At a glance', 'Spaces and events they sell', 'Packages and pricing they publish', 'What they push right now',
  'What changed recently', 'Where we win', 'Watch for'];

const SYSTEM = `You write short, factual competitor profiles for Infinity Hospitality Group's marketing director and sales team (Nashville event venues and catering).
Rules:
- Use ONLY the evidence given: the competitor's own public pages as read this week, the notes from IHG's competitor sheet, and Katherine's notes. If something is not in the evidence, write "not published" or leave it out. Never guess capacities, prices or dates.
- Quote at most one short line from their site per section, in quotation marks. Never copy whole paragraphs.
- Plain English, no hype, no em dashes, no "in today's landscape", no "delve", no rhetorical questions.
- Markdown with exactly these level-2 headings, in this order: ${HEADINGS.map((h) => `"## ${h}"`).join(', ')}.
- "Where we win" is IHG's angle, framed as suggestions for Katherine, never as claims about the competitor's quality.
- IHG's own venues and companies are named in full in the evidence. Use those names exactly. Never write an internal code (such as TBB, TBT, ECD, SWF) and never expand or guess what any abbreviation stands for.
- Keep the whole profile under 450 words.
- After the profile, add one fenced block that opens with \`\`\`claims and holds a JSON list. Every sentence that says what one of their pages says goes in it as {"claim":"<the sentence exactly as in the profile>","url":"<the full https page URL>","quote":"<the exact words copied from that page>"}. The Box fetches each page and checks the quote is really on it; a claim that fails is saved as UNVERIFIED. Write [] if there are none.`;

// 1. The sheet -> the competitor list. Never throws: says why it could not read.
async function syncFromSheet({ store, drive, log = () => {} }) {
  if (!store || !store.syncCompetitors) return { ok: false, why: 'no competitor store' };
  if (!drive) { log('competitors: sheet not read: no Google service account on this machine'); return { ok: false, why: 'no Google service account on this machine' }; }
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
    `ON IHG'S SHEET FOR: ${(c.brands || []).map((b) => brandName(b) || 'one of IHG\'s lists').filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'unknown'}${(c.segments || []).length ? `; listed under ${c.segments.join(', ')}` : ''}`,
    (c.sheet_notes || []).length ? `SHEET NOTES:\n- ${c.sheet_notes.join('\n- ')}` : null,
    c.kh_notes ? `KATHERINE'S NOTES:\n${c.kh_notes}` : null,
    c.last_changes ? `WHAT THE SCOUT SAW CHANGE (${c.changes_at ? new Date(c.changes_at).toISOString().slice(0, 10) : 'last run'}):\n${c.last_changes}` : 'WHAT THE SCOUT SAW CHANGE: nothing recorded yet',
    parts.length ? `THEIR PUBLIC PAGES THIS WEEK:\n${parts.join('\n\n')}` : 'THEIR PUBLIC PAGES THIS WEEK: none read yet',
  ].filter(Boolean).join('\n\n');
}

// ORDER #1776 (#1709): the model's claims list rides after the profile in a
// ```claims block. It is lifted out here and never saved; a block that is
// missing or does not parse is no claims.
const CLAIMS_RE = /```claims\s*([\s\S]*?)(?:```|$)/i;
function splitClaims(text) {
  const t = String(text || '');
  const m = t.match(CLAIMS_RE);
  if (!m) return { text: t, claims: [] };
  let claims = [];
  try { const j = JSON.parse(m[1].trim()); claims = Array.isArray(j) ? j : (Array.isArray(j && j.claims) ? j.claims : []); } catch { claims = []; }
  return { text: t.slice(0, m.index) + t.slice(m.index + m[0].length), claims };
}

function ct(now) {
  return now.toLocaleString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '.').replace(',', '') + ' CT';
}

// A model answer is kept only if it has every heading; dashes are replaced.
function cleanProfile(text) {
  let md = String(text || '').trim().replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
  const missing = HEADINGS.filter((h) => !new RegExp(`^##\\s+${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(md));
  if (missing.length) return { error: `missing section(s): ${missing.join(', ')}` };
  const bad = inventedCodes(md);
  if (bad.length) return { error: `invented what a code stands for: ${bad.join('; ')}` };
  const d = replaceDashes(swapCodes(md));
  md = d.text;
  const tells = lint(md);
  return { md, dashes: d.replaced, tells };
}

// 3. Profiles for the top competitors. The model is the Box's Anthropic key.
async function writeProfiles({ store, llm, log = () => {}, agent = 'scout', fetchImpl = globalThis.fetch, at = new Date() }) {
  if (!llm) return { ok: false, why: 'no model key on this machine', written: 0 };
  // #1776: one fetch per cited URL for the whole run, GET with the polite UA (#1703).
  const snap = snapshotter({ fetchImpl });
  const draft = async (user) => {
    const { text, claims } = splitClaims(await llm.complete({ system: SYSTEM, user, maxTokens: 1500 }));
    const out = cleanProfile(text);
    // The profile's own words were code-swapped and de-dashed; the claims get the same, so they still match.
    out.claims = claims.map((c) => (c && typeof c === 'object' ? { ...c, claim: replaceDashes(swapCodes(String(c.claim || ''))).text } : c));
    return out;
  };
  const all = await store.competitors();
  const topList = all.filter((c) => c.top).slice(0, MAX_TOP);
  // #1702: a live profile with an invented code expansion is rewritten even when off the top list.
  const tainted = all.filter((c) => c.profile_md && inventedCodes(c.profile_md).length && !topList.includes(c));
  const top = [...topList, ...tainted];
  if (!top.length) return { ok: false, why: 'no top competitors yet (sync the sheet first)', written: 0 };
  let written = 0; const failed = [];
  for (const c of top) {
    const pages = await store.snapshots(agent, c.site);
    if (!pages.length && !(c.sheet_notes || []).length && !c.kh_notes) {
      if (c.profile_md && inventedCodes(c.profile_md).length && store.withdrawProfile) await store.withdrawProfile(c.site);
      failed.push({ site: c.site, why: 'nothing read yet (the Scout reads it on its next run)' }); continue;
    }
    try {
      let out = await draft(evidenceFor(c, pages));
      if (out.error || (out.tells && !out.tells.clean)) {
        const why = out.error || 'AI-tell phrases';
        out = await draft(`${evidenceFor(c, pages)}\n\nYour last draft was refused (${why}). Write it again following every rule.`);
      }
      if (out.error) {
        // #1702: never leave a profile with an invented code on show.
        if (c.profile_md && inventedCodes(c.profile_md).length && store.withdrawProfile) await store.withdrawProfile(c.site);
        failed.push({ site: c.site, why: out.error }); continue;
      }
      // #1776: every claim about an outside page is checked against the page as
      // fetched this run before the profile is saved; a failed one reads UNVERIFIED.
      const q = await checkClaims(out.claims, snap);
      let md = applyGate(out.md, q);
      const extra = gateSections(q, ct(at));
      if (extra) md = md.trim() + '\n\n' + extra;
      await store.saveProfile(c.site, md);
      written++;
    } catch (e) { failed.push({ site: c.site, why: e.message }); }
  }
  log(`competitors: ${written} profile(s) written${failed.length ? `, ${failed.length} not: ${failed.map((f) => `${f.site} (${f.why})`).join('; ')}` : ''}`);
  return { ok: written > 0, written, failed };
}

module.exports = { syncFromSheet, writeProfiles, evidenceFor, cleanProfile, splitClaims, HEADINGS, SYSTEM, MAX_TOP, BRAND_NAMES, inventedCodes, swapCodes };
