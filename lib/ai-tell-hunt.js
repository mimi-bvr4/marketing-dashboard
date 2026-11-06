// ORDER #3010 (#3008 part B, Mimi 11.05.2026): the AI Tell Detective's Monday
// trend hunt. Every Monday it searches for AI-writing tells published since the
// last run (the first run backfills from 10.09.2026, the day the ban list was
// made) and proposes each one as a Review card: the pattern, 2 real examples,
// dated source links, a proposed lint rule (a regex, or "human check") and the
// false-positive risk.
//
// Nothing changes the ban list or the lint without a person's approval:
//   approve -> applyApproved() gives the new ban-list text (a dated "ADDED"
//              section and a CHANGELOG line). The list, lib/ai-tells.js and
//              LIST_UPDATED in lib/ai-tell-detective.js then change together on
//              a branch. RE-PIN: that branch turns sales-brain's drift check red
//              until sales-brain re-pins its vendored copy, so an approved tell
//              ships as two branches, one per repo.
//   reject  -> logged in the hunt ledger and never proposed again.
//
// The search is Claude with web search, through the same asker the agents'
// web_trends source uses (lib/agent-sources.js). Everything else here is pure.
//
// FEATURE FLAG: AI_TELL_HUNT default OFF. Putting the hunt on the Producer's
// Monday calendar is a schedule change and is Mimi's paste; this file does not
// touch lib/producer.js.
'use strict';

const fs = require('fs');

const FLAG = 'AI_TELL_HUNT';
function huntOn(env = process.env) {
  return /^(1|on|true|yes)$/i.test(String(env[FLAG] || '').trim());
}

const BACKFILL_FROM = '2026-10-09';
const MAX_CARDS = 6;

// One search per kind of source the order names.
const HUNT_QUERIES = [
  'Wikipedia "Signs of AI writing" guide: signs or phrases added or discussed recently',
  'editors, copy editors and style blogs on new tells that text was written by ChatGPT, Claude or another AI',
  'PRSA, marketing and communications writers on AI-sounding phrases readers now distrust',
  'academic studies or press pieces measuring words and phrases overused by large language models',
];

const mdy = (ymd) => `${ymd.slice(5, 7)}.${ymd.slice(8, 10)}.${ymd.slice(0, 4)}`;

function isoDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return null;
}

// The short name of a tell: the pattern before any "(example)", normalised.
function headOf(pattern) {
  return String(pattern || '').split('(')[0].trim();
}
// A pattern that opens with a quoted phrase is that phrase: '"from X to Y"
// breadth construction' and '"From X to Y" false-range sweep' are one tell.
function keyOf(pattern) {
  const q = String(pattern || '').trim().match(/^["“']([^"”']{2,80})["”']/);
  return (q ? q[1] : headOf(pattern)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// What the ban list already names: each bold title and each listed word or
// quoted phrase, normalised the same way as keyOf.
function knownTells(banText) {
  const out = new Set();
  const add = (s) => { const k = keyOf(s); if (k) out.add(k); };
  for (const line of String(banText || '').split('\n')) {
    for (const m of line.matchAll(/\*\*([^*]+)\*\*/g)) add(m[1].replace(/[:.]$/, ''));
    for (const m of line.matchAll(/"([^"]+)"/g)) add(m[1]);
    const v = line.match(/^\d+\.\s+\*\*[^*]+\*\*\s*(.*)$/);
    if (v) for (const w of v[1].split(/[,;]/)) if (w.trim().split(/\s+/).length <= 3) add(w.replace(/\(.*?\)/g, ''));
  }
  return [...out];
}

// The window starts at the newest recorded run, or at the backfill date.
function sinceDate(ledger) {
  const runs = (ledger || []).filter((e) => e.kind === 'run' && isoDate(e.ymd)).map((e) => isoDate(e.ymd)).sort();
  return runs.length ? runs[runs.length - 1] : BACKFILL_FROM;
}

function huntPrompt({ today, since, known = [], decided = [], query = HUNT_QUERIES[0] }) {
  return `Today is ${today}. You are hunting for NEW tells that a piece of writing was produced by an AI model, `
    + `published since ${mdy(since)}. Search the web for: ${query}\n\n`
    + `We already ban these (do not propose them again, or anything that is the same tell in other words): ${known.slice(0, 120).join('; ')}.\n`
    + (decided.length ? `We already decided on these (never propose them again): ${decided.join('; ')}.\n` : '')
    + '\nPropose at most 2 tells, and keep "why" and "fp_risk" to one short sentence each, so the answer is not cut off. Each must be a pattern a reader would notice in marketing copy, with 2 real examples '
    + 'of the pattern (quoted text that shows it), and at least one source published since that date, with its date. '
    + 'Never list a tell without a link you actually found. If you find nothing new, answer exactly "nothing new found".\n\n'
    + 'Answer with one ```json block holding an array of objects: '
    + '{"pattern": "...", "why": "...", "examples": ["...", "..."], '
    + '"sources": [{"title": "...", "url": "https://...", "date": "YYYY-MM-DD"}], '
    + '"lint": {"kind": "regex", "pattern": "<JavaScript regex, case-insensitive>"} or {"kind": "human check"}, '
    + '"fp_risk": "low|medium|high: why"}.';
}

function jsonPart(text) {
  const t = String(text || '');
  const fence = t.match(/```json\s*([\s\S]*?)(```|$)/i);
  if (fence) return fence[1];
  const a = t.indexOf('['); const b = t.lastIndexOf(']');
  return a >= 0 && b > a ? t.slice(a, b + 1) : null;
}

// The asker caps an answer's length, so an answer can stop mid-array. Keep
// every top-level object that closed; the broken tail is dropped.
function completeObjects(part) {
  const out = [];
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) { depth--; if (depth === 0 && start >= 0) { try { out.push(JSON.parse(part.slice(start, i + 1))); } catch (e) { /* not a whole object */ } start = -1; } }
  }
  return out;
}

function checkOne(p, since) {
  if (!p || typeof p !== 'object') return { why: 'not an object' };
  const pattern = String(p.pattern || '').trim();
  if (!keyOf(pattern)) return { why: 'no pattern' };
  const unwrap = (s) => { const t = String(s || '').trim(); const m = t.match(/^["“](.*)["”]$/s); return (m ? m[1] : t).trim(); };
  const examples = (Array.isArray(p.examples) ? p.examples : []).map(unwrap).filter(Boolean);
  if (examples.length < 2) return { why: 'fewer than 2 real examples' };
  const sources = [];
  for (const s of Array.isArray(p.sources) ? p.sources : []) {
    const url = String((s && s.url) || '').trim();
    const date = isoDate(s && s.date);
    if (!/^https:\/\/[^\s/]+\.[^\s]+/.test(url) || !date) continue;
    if (since && date < since) continue;
    sources.push({ title: String(s.title || url).trim().slice(0, 160), url, date });
  }
  if (!sources.length) return { why: `no https source link dated on or after ${since ? mdy(since) : 'the window'}` };
  const l = p.lint || {};
  let lint;
  if (String(l.kind || '').toLowerCase() === 'regex') {
    try { new RegExp(String(l.pattern || ''), 'i'); } catch (e) { return { why: `the proposed lint regex does not compile: ${e.message}` }; }
    if (!String(l.pattern || '').trim()) return { why: 'the proposed lint regex is empty' };
    lint = { kind: 'regex', pattern: String(l.pattern) };
  } else if (/human/i.test(String(l.kind || ''))) {
    lint = { kind: 'human check' };
  } else return { why: 'no proposed lint rule (a regex or "human check")' };
  const fp = String(p.fp_risk || '').trim();
  if (!fp) return { why: 'no false-positive risk' };
  // Our own words on the card carry no dash (tell 1); the examples are quoted evidence and stay verbatim.
  const nodash = (s) => String(s || '').replace(/\s*[—–]\s*/g, ', ').trim();
  return { proposal: { pattern: nodash(pattern), why: nodash(p.why), examples: examples.slice(0, 3), sources: sources.slice(0, 3).map((s) => ({ ...s, title: nodash(s.title) })), lint, fp_risk: nodash(fp) } };
}

function parseProposals(text, { since = null } = {}) {
  const part = jsonPart(text);
  if (part == null) return { proposals: [], dropped: [], none: true };
  let list; let truncated = false;
  try { list = JSON.parse(part); } catch (e) {
    list = completeObjects(part);
    truncated = true;
    if (!list.length) return { proposals: [], dropped: [{ pattern: null, why: `the answer's JSON did not parse: ${e.message}` }], none: false, truncated };
  }
  if (!Array.isArray(list)) list = [list];
  const proposals = []; const dropped = [];
  if (truncated) dropped.push({ pattern: null, why: 'the answer was cut off; the unfinished last item was dropped' });
  for (const p of list) {
    const r = checkOne(p, since);
    if (r.proposal) proposals.push(r.proposal);
    else dropped.push({ pattern: p && p.pattern ? String(p.pattern).slice(0, 120) : null, why: r.why });
  }
  return { proposals, dropped, none: !list.length, truncated };
}

// Drop what the list already has and anything already approved or rejected.
function fresh(proposals, { known = [], ledger = [] }) {
  const knownSet = new Set(known);
  const decided = new Map();
  for (const e of ledger) if ((e.kind === 'reject' || e.kind === 'approve') && e.key) decided.set(e.key, e);
  const keep = []; const skipped = [];
  for (const p of proposals) {
    const k = keyOf(p.pattern);
    const d = decided.get(k);
    if (d) { skipped.push({ pattern: p.pattern, why: `${d.kind === 'reject' ? 'rejected' : 'approved'} ${mdy(isoDate(d.ymd) || d.ymd)}, never proposed again` }); continue; }
    if (knownSet.has(k) || (k.split(' ').length >= 2 && known.some((x) => x.includes(k)))) { skipped.push({ pattern: p.pattern, why: 'already on the ban list' }); continue; }
    keep.push(p);
  }
  return { keep, skipped };
}

// One Review card per proposed tell.
function cardOf(p) {
  const lint = p.lint.kind === 'regex' ? `regex \`${p.lint.pattern}\` (case-insensitive)` : 'human check (no safe regex; a person reads for it)';
  const body = [
    `**Pattern:** ${p.pattern}`,
    p.why ? `**Why it reads as AI:** ${p.why}` : null,
    '',
    'Examples:',
    ...p.examples.map((e) => `- "${e}"`),
    '',
    'Sources:',
    ...p.sources.map((s) => `- [${s.title}](${s.url}), ${mdy(s.date)}`),
    '',
    `Proposed lint rule: ${lint}`,
    `False-positive risk: ${p.fp_risk}`,
    '',
    'Approve adds it to the ban list under a dated ADDED section, and to the lint on a branch. Reject is logged and it is never proposed again.',
  ].filter((x) => x !== null).join('\n');
  return { title: `New AI tell? ${headOf(p.pattern)}`.slice(0, 120), body, key: keyOf(p.pattern), proposal: p };
}

function decide({ ledger = [], proposal, verdict, who, ymd, note = '' }) {
  if (verdict !== 'approve' && verdict !== 'reject') throw new Error('verdict is approve or reject');
  if (!String(who || '').trim()) throw new Error('a person must be named');
  const key = keyOf(proposal && proposal.pattern);
  if (!key) throw new Error('no tell to decide');
  const prior = ledger.find((e) => (e.kind === 'approve' || e.kind === 'reject') && e.key === key);
  if (prior) return { error: `already ${prior.kind === 'reject' ? 'rejected' : 'approved'} ${mdy(isoDate(prior.ymd) || prior.ymd)} by ${prior.who}` };
  const entry = { ymd, kind: verdict, who: String(who).trim(), key, note: String(note || '').replace(/\|/g, '/').trim() };
  return { entry, ledger: [...ledger, entry] };
}

function addedLine(p) {
  const src = p.sources.map((s) => `${s.title} (${s.url}, ${mdy(s.date)})`).join('; ');
  const lint = p.lint.kind === 'regex' ? `lint regex \`${p.lint.pattern}\`` : 'human check';
  return `- **${p.pattern}**${p.why ? ` ${p.why}` : ''} Examples: ${p.examples.map((e) => `"${e}"`).join('; ')}. Rule: ${lint}. False-positive risk: ${p.fp_risk}. Source: ${src}.`;
}

// The ban list with approved tells added. Idempotent per tell.
function applyApproved(banText, approvals) {
  let text = String(banText);
  for (const a of approvals) {
    const p = a.proposal;
    if (text.includes(`- **${p.pattern}**`)) continue;
    const head = `## ADDED ${mdy(a.ymd)}`;
    const line = addedLine(p);
    if (text.includes(`${head}\n`)) {
      const i = text.indexOf(`${head}\n`) + head.length + 1;
      const end = text.indexOf('\n\n', i);
      const at = end < 0 ? text.length : end;
      text = `${text.slice(0, at)}\n${line}${text.slice(at)}`;
    } else {
      const c = text.indexOf('## CHANGELOG');
      const block = `${head}\n${line}\n\n`;
      text = c < 0 ? `${text.trimEnd()}\n\n${block}` : `${text.slice(0, c)}${block}${text.slice(c)}`;
    }
    text = `${text.trimEnd()}\n- ${mdy(a.ymd)}: 1 tell added from the Monday hunt (approved by ${a.who}): ${headOf(p.pattern)}.\n`;
  }
  return text;
}

function lastChangelogDate(banText) {
  const i = String(banText).indexOf('## CHANGELOG');
  if (i < 0) return null;
  const ds = [...String(banText).slice(i).matchAll(/^- (\d{2}\.\d{2}\.\d{4})/gm)].map((m) => m[1]);
  return ds.length ? ds[ds.length - 1] : null;
}
function listUpdatedOk(banText, listUpdated) {
  return lastChangelogDate(banText) === listUpdated;
}

// ------------------------------------------------------------ the ledger (a markdown table)
const LEDGER_HEAD = '# AI tell hunt ledger\n_ORDER #3010. One row per hunt run and per verdict. A rejected tell is never proposed again. Written by jobs/ai_tell_hunt.js; do not reorder._\n\n| date | kind | who | key | note |\n|---|---|---|---|---|\n';
function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(run|approve|reject)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/);
    if (m) out.push({ ymd: m[1], kind: m[2], who: m[3].trim(), key: m[4].trim(), note: m[5].trim() });
  }
  return out;
}
function appendLedger(file, e) {
  const clean = (s) => String(s == null ? '' : s).replace(/[|\n]/g, ' ').trim();
  const row = `| ${clean(e.ymd)} | ${clean(e.kind)} | ${clean(e.who)} | ${clean(e.key)} | ${clean(e.note)} |\n`;
  if (!fs.existsSync(file)) fs.writeFileSync(file, LEDGER_HEAD + row);
  else fs.appendFileSync(file, row);
}

// ------------------------------------------------------------ the dry run
// Searches, parses, filters and builds the cards. Writes nothing: not the ban
// list, not the lint, not a card store, not the ledger. The caller decides.
async function huntDry({ ask, banText, ledger = [], today, queries = HUNT_QUERIES }) {
  const since = sinceDate(ledger);
  const known = knownTells(banText);
  const decided = ledger.filter((e) => e.kind === 'reject' || e.kind === 'approve').map((e) => e.key);
  const [y, m, d] = today.split('-').map(Number);
  const longDay = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  const all = []; const dropped = []; const failed = []; const answers = [];
  for (const query of queries) {
    let text;
    try { text = String(await ask(huntPrompt({ today: longDay, since, known, decided, query })) || ''); }
    catch (e) { failed.push({ query, error: e.message }); continue; }
    answers.push({ query, text });
    const r = parseProposals(text, { since });
    all.push(...r.proposals);
    dropped.push(...r.dropped);
  }
  if (failed.length === queries.length) {
    return { ok: false, since, cards: [], skipped: [], dropped, failed, answers, summary: `The hunt could not search: ${failed[0].error}` };
  }
  const seen = new Set(); const uniq = [];
  for (const p of all) { const k = keyOf(p.pattern); if (!seen.has(k)) { seen.add(k); uniq.push(p); } }
  const f = fresh(uniq, { known, ledger });
  const cards = f.keep.slice(0, MAX_CARDS).map(cardOf);
  const summary = cards.length
    ? `${cards.length} proposed-tell card${cards.length === 1 ? '' : 's'} since ${mdy(since)}`
    : `No new AI tells found since ${mdy(since)}`;
  return { ok: true, since, cards, skipped: f.skipped, dropped, failed, answers,
    summary: summary + (f.skipped.length ? `; ${f.skipped.length} skipped as already known or decided` : '') + (dropped.length ? `; ${dropped.length} dropped for missing proof` : '') + (failed.length ? `; ${failed.length} search${failed.length === 1 ? '' : 'es'} failed` : '') };
}

module.exports = {
  FLAG, huntOn, BACKFILL_FROM, MAX_CARDS, HUNT_QUERIES,
  isoDate, headOf, keyOf, knownTells, sinceDate, huntPrompt, parseProposals, fresh, cardOf, decide,
  addedLine, applyApproved, lastChangelogDate, listUpdatedOk, readLedger, appendLedger, LEDGER_HEAD, huntDry,
};
