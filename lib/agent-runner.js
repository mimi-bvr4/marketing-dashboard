// ORDER #1015: one runner for every marketing agent.
//
// An agent is a folder: agents/<slug>/SKILL.md (what it is for and how it
// works, plain markdown, the same shape as a Claude skill or a ChatGPT plugin
// skill) + agents/<slug>/agent.json (name, job, sources, card limit). Adding an
// agent is adding a folder; this file does not change.
//
// A run: gather the declared sources -> one model call with the SKILL.md as the
// system prompt -> parse cards -> lint each card against AI_TELLS_BAN_LIST, and
// on any hit (or internal code, #1748) ask the model once to fix it -> on an
// outbound agent, the Copywriter pre-pass (#1748) -> append the measured
// evidence and the credit line -> insert as DRAFT. Approve on the Review tab
// never publishes, except the ruled Pinterest Paul pin (10.13.2026).
//
// Never silent (iron rule 8): a source that cannot be reached is named on the
// card; a run with no model or a model error still writes a card saying so.
'use strict';

const fs = require('fs');
const path = require('path');
const { gather, sourceLabel, internalCodes } = require('./agent-sources');
const { lint, summary, replaceDashes } = require('./ai-tells');
const { snapshotter, checkClaims, applyGate, gateSections } = require('./quote-gate');
const seenMem = require('./agent-seen');
const openDates = require('./open-dates');
const { parseModelJson } = require('./agent-json');
const { safeReason } = require('./safe-reason');
const { plainNote } = require('../public/team-brief'); // #3158
const { stubReason } = require('./stub-text');
const outreach = require('./outreach');

// #3011: the words a card would go out with (a post's or a pin's own text when it carries one).
function draftWords(c) {
  if (c.post && c.post.content_md) return c.post.content_md;
  if (c.pin && (c.pin.title || c.pin.description)) return [c.pin.title, c.pin.description].filter(Boolean).join('\n');
  return c.body;
}

// #3011: the AI-tells rewrite may only replace a card with a real card. A
// rewrite that came back as a stub ("..." as "unchanged") or lost more than
// half the words is not a rewrite: the card is kept as drafted.
function rewriteLost(orig, fixed) {
  const why = stubReason(draftWords(fixed));
  if (why) return why;
  const a = String(draftWords(orig) || '').length; const b = String(draftWords(fixed) || '').length;
  return a > 400 && b < a / 2 ? `the rewrite kept ${b} of ${a} characters` : null;
}

// #2910: the model is asked once more when its answer still cannot be read
// after the repair pass. The second ask says what broke; a cut-off answer is
// asked for fewer, shorter cards (the limit is not raised: see agent-json.js).
// #3158: each unreadable answer logs the bytes around its break (secret-free),
// so a failure can be quoted later instead of guessed at.
// #3224: "fewer, shorter cards" alone did not shrink gala-scout's answer (11.11.2026:
// both answers stopped at max_tokens inside the first card, a one-row-per-event
// table). A re-ask after a length stop now names the cap: at most half the cards
// (at least 1) and a character budget per card, half of what the cut answer used.
function cutCap(answer, max) {
  const n = Math.max(1, Math.floor((max || 3) / 2));
  const per = Math.max(1000, Math.floor(String(answer || '').length / 2 / n));
  return { n, per, words: `Write fewer cards: at most ${n} card${n === 1 ? '' : 's'}. Keep each card body under ${per} characters; `
    + 'if a table would run longer, keep only its first rows (the ones this run found first) and end it with one line saying how many rows were left out.' };
}

async function draftCards(llm, { system, user, maxTokens, max, log, slug }) {
  const said = (which, e, stop) => { if (log && e.excerpt) log(`${slug || 'agent'}: ${which} answer unreadable (stop ${stop || 'unknown'}), near the break: ${safeReason(e.excerpt, 300)}`); };
  // #3224: a cut-off answer that still parsed kept only its whole cards (agent-json.js drops the unfinished one); say so.
  const kept = (cards) => {
    if (log && llm.lastStop === 'max_tokens') log(`${slug || 'agent'}: answer cut off at the length limit; kept ${cards.length} whole card${cards.length === 1 ? '' : 's'}, anything unfinished dropped`);
    return cards;
  };
  const first = await llm.complete({ system, user, maxTokens });
  try { return kept(parseCards(first, max)); } catch (e) {
    if (!e.badJson) throw e;
    const cut = llm.lastStop === 'max_tokens';
    said('first', e, llm.lastStop);
    const cap = cut ? cutCap(first, max) : null;
    const again = `${user}\n\nYOUR LAST ANSWER COULD NOT BE READ (${cut ? 'it was cut off at the length limit' : e.message}). Answer again with ONE valid JSON object and nothing else. Escape every double quote inside a string as \\". ${cap ? cap.words : ''}`.trim();
    const second = await llm.complete({ system, user: again, maxTokens });
    try { return kept(parseCards(second, cap ? cap.n : max)); } catch (e2) {
      if (!e2.badJson) throw e2;
      said('second', e2, llm.lastStop);
      throw new Error(`the model's answer was not valid JSON twice (${cut || llm.lastStop === 'max_tokens' ? 'cut off at the length limit; ' : ''}last: ${e2.message})`);
    }
  }
}

// #2910: the sources that were missing, with why, in one short secret-free line.
function missingLine(unavailable) {
  const list = (unavailable || []).filter((u) => !u.quiet);
  return list.length ? list.map((u) => `${u.label}${u.why ? `: ${safeReason(u.why, 120)}` : ''}`).join('; ') : '';
}

// #2904: at most this many open dates offered on one card.
const OPEN_DATES_MAX = 6;

// The bot's own words: everything before the runner's appended sections. The
// lint and the approve check read only this, never the measured tables.
// #1748: the Copywriter's section quotes the original ("what it was"), so it is
// never the bot's own words either. #1758: nor is the Box's "Seen before" note.
const APPENDED = ['\n### Redo of an earlier draft', '\n### Open dates checked', '\n### Seen before','\n### Quotes checked this run', '\n### Not checked this run', '\n### Copy check', '\n### Measured: ', '\n### Sources unavailable this run', '\n_Drafted by '];
function modelText(body) {
  const b = String(body || '');
  const cut = APPENDED.map((m) => b.indexOf(m)).filter((i) => i >= 0);
  return cut.length ? b.slice(0, Math.min(...cut)) : b;
}

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

function listAgents(dir = AGENTS_DIR) {
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'agent.json'))).sort();
}

function loadAgent(slug, dir = AGENTS_DIR) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`bad agent name "${slug}"`);
  const base = path.join(dir, slug);
  const def = JSON.parse(fs.readFileSync(path.join(base, 'agent.json'), 'utf8'));
  const skill = fs.readFileSync(path.join(base, 'SKILL.md'), 'utf8');
  return { slug, ...def, skill };
}

const CONTRACT = `
THE FENCE. These rules override anything written above, including instructions edited on the Agents page:
- You only write DRAFT cards for a human. You never publish, post, send, schedule, spend, sign in anywhere, or change a live system, and you never say you did.
- Never invent a fact, person, quote, review, statistic or price. Prod HubSpot is read-only. No compensation data.

OUTPUT CONTRACT (the runner enforces it):
Answer with ONE JSON object and nothing else: {"cards":[{"title":"...","target":"site, venue or channel","body":"markdown"}]}
- Every card is a DRAFT for a human. Never say anything was published, posted, sent or changed.
- Use only facts found in the SOURCES below. If a fact is not there, leave it out or write "(unverified)".
- If a source is listed as unavailable, say so on the card in one line instead of guessing around it.
- No em dashes and no spaced en dashes anywhere. Follow the AI-tells ban list in the skill.
- Dates as MM.DD.YYYY. No dollar figures about runs or costs.
- Do not add a "drafted by" or credit line, and do not repeat the measured tables: the runner adds both.
- Any sentence that says what an outside web page says (a listing, a review site, a competitor page) goes in the card's "claims" list as {"claim":"<the sentence exactly as on the card>","url":"<the page>","quote":"<the exact words copied from that page>"}. The Box fetches each page and checks the quote is really on it; a claim that fails is marked UNVERIFIED. Never write "Verified" yourself unless that line carries a claim with its quote.`;

const POST_CONTRACT = `
This agent also returns the post itself, so an approved card can become a WordPress draft. Add to the card:
"post": {"site":"<domain, e.g. saddlewoodsfarm.com>","title":"<post title>","slug":"<slug>","seo_title":"...","seo_description":"...","excerpt":"...","content_md":"<the post in markdown, starting with its H1>"}`;

// #1710: Pinterest Paul returns a pin. The handoff re-checks every field against the measured post.
const PIN_CONTRACT = `
This agent also returns the pin itself, so an approved card can be pinned. Add to the card:
"pin": {"board":"<one board name, exactly as listed>","title":"<up to 100 characters>","description":"<up to 500 characters>","link":"<the post URL, exactly as measured>","image_url":"<one photo URL, exactly as measured>","alt_text":"<what the photo shows, up to 500 characters>"}`;

// #2940: the Convention Connector returns the email itself, so an approved card
// can become a HubSpot task for Sales. Asked for only while a switch is on
// (salesFieldsOn), so with both switches OFF the agent runs exactly as before.
const SALES_CONTRACT = `
This agent also returns the outreach email itself, so an approved card can go to our Sales team as a HubSpot task. Add to the card:
"sales": {"company":"<the company's name, exactly as on its own site>","website":"<the company's own public website or contact page, https>","subject":"<the email subject>","email":"<the email itself, exactly as a salesperson would send it, no subject line>"}
Never put a person's name, email or phone in "company" or "website". Do not add an unsubscribe line or a mailing address to the email: the runner adds both.`;

function salesFieldsOn(env = process.env) {
  const on = (v) => String(v || '').trim().toLowerCase() === 'on';
  return on(env.CONVENTION_TO_HUBSPOT) || on(env.CONVENTION_TO_HUBSPOT_PROD);
}

function parseSales(s) {
  if (!s || typeof s !== 'object' || !s.company || !s.email) return null;
  const keep = {};
  for (const k of ['company', 'website', 'subject', 'email']) if (s[k] != null && String(s[k]).trim()) keep[k] = String(s[k]).trim().slice(0, k === 'email' ? 20000 : 300);
  return keep;
}

function parsePin(p) {
  if (!p || typeof p !== 'object' || !p.title || !p.image_url) return null;
  const keep = {};
  for (const k of ['board', 'title', 'description', 'link', 'image_url', 'alt_text']) if (p[k] != null) keep[k] = String(p[k]).slice(0, 1000);
  return keep;
}

function parsePost(p) {
  if (!p || typeof p !== 'object' || !p.title || !p.content_md) return null;
  const keep = {};
  for (const k of ['site', 'title', 'slug', 'seo_title', 'seo_description', 'excerpt', 'content_md']) if (p[k] != null) keep[k] = String(p[k]).slice(0, k === 'content_md' ? 100000 : 500);
  return keep;
}

// #2910: a slightly broken answer (a missing colon, an unescaped quote, a cut-off
// last card) is repaired by lib/agent-json.js instead of failing the run.
function parseCards(text, max) {
  const { json: j } = parseModelJson(text);
  const cards = Array.isArray(j.cards) ? j.cards : [];
  return cards.filter((c) => c && c.title && c.body).slice(0, max || 5)
    .map((c) => ({ title: String(c.title).slice(0, 200), target: c.target ? String(c.target).slice(0, 120) : null, body: String(c.body),
      post: parsePost(c.post), pin: parsePin(c.pin), sales: parseSales(c.sales), claims: Array.isArray(c.claims) ? c.claims : [],
      open_dates: Array.isArray(c.open_dates) ? c.open_dates.slice(0, OPEN_DATES_MAX) : [],
      seen: c.seen && typeof c.seen === 'object' && !Array.isArray(c.seen) ? c.seen : null }));
}

function ct(now) {
  return now.toLocaleString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '.').replace(',', '') + ' CT';
}

// #2914: the revised card names the card it replaces and what was asked.
function redoNote(orig) {
  const r = orig.redo || {};
  return `### Redo of an earlier draft\n\nThis replaces the draft "${orig.title}" (${ct(new Date(orig.created_at || Date.now()))}).`
    + (r.words ? ` Asked${r.asked_by ? ` by ${r.asked_by}` : ''}: "${r.words}"` : '')
    + ' The earlier draft is kept under Rejected.';
}

function finishBody(card, { def, got, unavailable, now, model, copy, seen, redo }) {
  const parts = [card.body.trim()];
  if (redo) parts.push(redo);
  if (seen) parts.push(seen);
  if (copy) parts.push(copy);
  for (const g of got) if (g.table) parts.push(`### Measured: ${g.label} (${ct(now)})\n\n${g.table}`);
  if (unavailable.length) parts.push('### Sources unavailable this run\n\n' + unavailable.map((u) => `- ${u.label}: ${u.why}`).join('\n'));
  const ver = def.version ? `, instructions v${def.version} by ${def.edited_by}` : ', default instructions';
  parts.push(`_Drafted by ${def.name} (the Box), ${ct(now)}${model ? `, model ${model}` : ''}${ver}. A draft: nothing was published, sent or changed._`);
  return parts.join('\n\n');
}

// ORDER #1748 (Mimi 10.13.2026, "Yes, both"): the Copywriter pre-pass. An agent
// whose words leave the building as written (agent.json "copy_prepass": true, or
// "on_request" for the Email agent, whose scheduled run is the scorecard) has
// each card's outbound text checked by the Copywriter skill before the card is
// saved. Katherine's saved Copywriter instructions win, as on a Run now. The
// card carries the verdict, the corrected text and the numbered changes. A
// failed check never stops the card: it is saved as a draft that says
// "Copy check did not run".
function wantsPrepass(agent, ask) {
  return agent.copy_prepass === true || (agent.copy_prepass === 'on_request' && !!ask);
}

function outboundText(c) {
  if (c.post) return [c.post.title, c.post.seo_title, c.post.seo_description, c.post.excerpt, c.post.content_md].filter(Boolean).join('\n\n');
  if (c.pin) return [c.pin.title, c.pin.description, c.pin.alt_text].filter(Boolean).join('\n\n');
  return `${c.title}\n\n${c.body}`;
}

// The words on a card's AI-tells badge. A new card (put, in runAgent) and a
// saved edit (agent-store decide, ORDER #1898) both build them here, so the
// words can never lag the colour the page takes from the same tells.
function tellsSummary(c, tells) {
  // #1724, #1748 (every agent): the card also says which internal codes are still in it after the rewrite.
  const left = [...new Set(internalCodes((c.title || '') + '\n' + modelText(c.body)).map((h) => h.phrase.split(' ')[0]))];
  return summary(tells) + (c.dashes_replaced ? `, ${c.dashes_replaced} dash${c.dashes_replaced === 1 ? '' : 'es'} replaced by the Box` : '')
    + (left.length ? `, internal code${left.length === 1 ? '' : 's'} left: ${left.join(', ')}` : '');
}

// #3011: the Copywriter's own note saying the draft is a stub or empty.
const STUB_NOTE = /\b(?:draft|text|body|card|copy|this|it)\s+(?:appears to be|looks like|seems to be|is only|is just|is)\s+(?:a |an )?(?:stub|placeholder|empty)\b/i;

function stubCheck(why) {
  return { section: `### Copy check (the Copywriter, before you saw this)\n\nNeeds changes (1)\n\n1. This draft is a stub: ${why}. Write the full text before it goes out.`,
    check: { ran: true, ready: false, changes: 1, stub: true, summary: 'Copy check: Needs changes (1)' } };
}

async function copyPrepass(c, { store, llm, env, fetchImpl, at, dryRun, saKey, saToken }) {
  // #3011: a stub is never "Ready to go out", whatever a model would say.
  const stub = stubReason(draftWords(c));
  if (stub) return stubCheck(stub);
  try {
    const cw = loadAgent('copywriter');
    const s = store && store.currentSettings ? await store.currentSettings('copywriter') : null;
    if (s) cw.skill = s.skill_md;
    const { got, unavailable } = await gather(cw.sources || [], { env, ask: outboundText(c), fetch: fetchImpl, lint, store,
      agent: 'copywriter', dryRun, now: () => at, saKey, saToken });
    if (!got.some((g) => g.type === 'text_check')) throw new Error('the text to check could not be measured');
    const user = [
      `TODAY: ${ct(at)}`,
      'REQUEST:\nCheck this outbound draft before Katherine sees it. Write exactly one card.',
      'SOURCES:\n' + got.map((g) => `=== ${g.label} ===\n${g.text}`).join('\n\n'),
      unavailable.length ? 'UNAVAILABLE THIS RUN:\n' + unavailable.map((u) => `- ${u.label}: ${u.why}`).join('\n') : null,
    ].filter(Boolean).join('\n\n');
    const out = parseCards(await llm.complete({ system: cw.skill + '\n\n' + CONTRACT, user, maxTokens: cw.max_tokens || 9000 }), 1)[0];
    if (!out) throw new Error('the Copywriter returned no card');
    const m = out.body.match(/Needs changes\s*\((\d+)\)/i);
    const ready = !m && /Ready to go out/i.test(out.body);
    if (!m && !ready) throw new Error('the Copywriter gave no verdict');
    // #3011: "Ready to go out" with its own note calling the draft a stub (the 11.05.2026 card) is Needs changes.
    if (ready && STUB_NOTE.test(out.body.replace(/\bnot\s+(?:a |an )?(?:stub|placeholder|empty)\b/gi, ''))) {
      const s = stubCheck('the Copywriter\'s own note says so');
      s.section += `\n\nThe Copywriter's note:\n\n${out.body.trim()}`;
      return s;
    }
    return { section: `### Copy check (the Copywriter, before you saw this)\n\n${out.body.trim()}`,
      check: { ran: true, ready, changes: m ? Number(m[1]) : 0, summary: ready ? 'Copy check: Ready to go out' : `Copy check: Needs changes (${m[1]})` } };
  } catch (e) {
    return { section: `### Copy check did not run\n\nCopy check did not run: ${e.message}. Check the words yourself, or paste them into the Copywriter, before this goes out.`,
      check: { ran: false, why: String(e.message).slice(0, 300), summary: 'Copy check did not run' } };
  }
}

async function runAgent({ slug, def, store, llm, ask = null, env = process.env, fetchImpl = globalThis.fetch,
  now = () => new Date(), log = () => {}, dryRun = false, scheduled = false, saKey, saToken, blockedToBoard = false, split = null, redoOf = null }) {
  // #2909: split = producer.holdSplit(...) while the Producer's hold is on; it
  // names the cards to keep (Google Business: the RED replies). null = as before.
  const agent = { ...(def || loadAgent(slug)) };
  // #2914: redoOf = the id of the card a person asked to redo. One revised card,
  // the seen-before skip lifted for that one item only. A card from another
  // agent is never redone by this one.
  let redoCard = null;
  if (redoOf && store && store.get) {
    const c = await store.get(redoOf);
    if (!c || c.agent !== agent.slug) {
      log(`${agent.slug}: redo refused, card ${redoOf} ${c ? 'belongs to another agent' : 'not found'}`);
      return { ok: false, error: c ? 'that card belongs to another agent' : 'the card to redo was not found', cards: [], unavailable: [] };
    }
    redoCard = c;
  }
  // #1658: Katherine's latest version from the Agents page wins over the repo default.
  const s = store && store.currentSettings ? await store.currentSettings(agent.slug) : null;
  if (s) Object.assign(agent, { skill: s.skill_md, max_cards: s.max_cards, enabled: s.enabled, version: s.version, edited_by: s.edited_by });
  // #1664: the name Katherine gave it goes on its cards. Cosmetic; the skill is unchanged.
  const prof = store && store.profile ? await store.profile(agent.slug) : null;
  if (prof && prof.display_name) agent.name = prof.display_name;
  if (redoCard) agent.max_cards = 1;
  // #2903: a card-only team member (the Web Agent, Site Guardian) is shown on
  // the team page but never run here, scheduled or asked.
  if (typeof agent.card_only === 'string' && agent.card_only.trim()) {
    log(`${agent.slug}: card only (${agent.card_only.trim()}); not run by this runner`);
    return { ok: true, skipped: 'card only', cards: [], unavailable: [] };
  }
  // #3000: a new team member ships OFF behind its own switch. Off, it is never
  // run, scheduled or asked; Run now gets the same answer.
  const off = require('./producer').switchOff(agent, env);
  if (off) {
    log(`${agent.slug}: ${off}; not run`);
    return { ok: true, skipped: off, cards: [], unavailable: [] };
  }
  if (scheduled && agent.enabled === false) {
    log(`${agent.slug}: paused on the Agents page${s ? ` by ${s.edited_by}` : ''}; scheduled run skipped`);
    return { ok: true, skipped: 'paused', cards: [], unavailable: [] };
  }
  const runId = dryRun ? null : await store.startRun(agent.slug);
  const at = now();
  const { got, unavailable } = await gather(agent.sources || [], { env, ask, fetch: fetchImpl, lint, store, agent: agent.slug, dryRun, now, saKey, saToken });
  const why = missingLine(unavailable);
  log(`${agent.slug}: ${got.length} sources read, ${unavailable.length} unavailable${why ? ` (${why})` : ''}`);
  const sources = [...got.map((g) => ({ label: g.label, ok: true })), ...unavailable.map((u) => ({ label: u.label, ok: false, why: u.why }))];
  const base = { agent: agent.slug, agent_name: agent.name, job: agent.job, run_id: runId, sources };
  const written = [];
  const spec = agent.seen_before && Array.isArray(agent.seen_before.key) ? agent.seen_before : null;
  const skippedSeen = [];
  const heldBySplit = [];
  const emptyCards = [];
  const put =async (c) => {
    const pinText = c.payload && c.payload.pin ? '\n' + c.payload.pin.title + '\n' + (c.payload.pin.description || '') : '';
    const salesText = c.payload && c.payload.sales ? '\n' + (c.payload.sales.subject || '') + '\n' + c.payload.sales.email : '';
    const tells = lint((c.title || '') + '\n' + modelText(c.body) + (c.payload && c.payload.post ? '\n' + c.payload.post.content_md : '') + pinText + salesText);
    const card = { ...base, ...c, checks: { ai_tells: tells, ai_tells_summary: tellsSummary(c, tells),
      ...(c.quotes ? { quotes: c.quotes } : {}) } };
    if (c.copy_check) card.checks.copy_check = c.copy_check;
    if (c.empty_card) card.checks.empty_card = true;
    delete card.empty_card;
    delete card.dashes_replaced;
    delete card.quotes;
    delete card.copy_check;
    written.push(dryRun ? card : await store.insert(card));
  };
  // #1704: match required sources by the same label gather() reports (a source with no "label" used to never match).
  const required = (agent.sources || []).filter((s) => s.required).map((s) => sourceLabel(s));
  const missingRequired = unavailable.filter((u) => required.includes(u.label) && !u.quiet);
  // #1705: an agent that reads a feed (PR Patty's press emails) stays silent on a day the feed is simply empty.
  const nothingNew = agent.skip_when_nothing_new && !ask && !got.some((g) => g.type !== 'file')
    && unavailable.every((u) => u.quiet || u.type === 'file');
  if (nothingNew) {
    log(`${agent.slug}: nothing new to read, no card`);
    if (!dryRun) await store.finishRun(runId, { status: 'done', cards: 0, unavailable, note: 'nothing new' });
    return { ok: true, cards: [], unavailable };
  }
  // #2900: under the Producer (PRODUCER_CALENDAR on, scheduled runs only), a
  // missing required source is one line on the board, not a "could not run"
  // card in Review. The run row records it as 'blocked' with what it waits on.
  if (blockedToBoard && scheduled && missingRequired.length) {
    const labels = missingRequired.map((u) => u.label);
    log(`${agent.slug}: waiting on ${missingLine(missingRequired)} (board line, no card)`);
    if (!dryRun) await store.finishRun(runId, { status: 'blocked', cards: 0, unavailable, note: `waiting on: ${missingLine(missingRequired)}`.slice(0, 500) });
    return { ok: true, blocked: labels, cards: [], unavailable };
  }
  try {
    if (missingRequired.length || !got.length) {
      await put({ title: `${agent.name} could not run: ${missingRequired.length ? 'a required source is missing' : 'no source answered'}`,
        target: null, body: finishBody({ body: `${agent.name} did not draft anything this run, because a source it needs is not available. Connecting it is the next step; nothing else is wrong.` },
          { def: agent, got: [], unavailable, now: at }) });
    } else if (!llm) {
      await put({ title: `${agent.name}: measured, not written up (no model key on this machine)`, target: null,
        body: finishBody({ body: 'The sources were read, but there is no Anthropic API key here, so no draft was written. The measured evidence is below.' },
          { def: agent, got, unavailable, now: at }) });
    } else {
      const rejections = dryRun ? [] : await store.lastRejections(agent.slug, 8);
      const memory = spec && store && store.seenList ? await store.seenList(agent.slug, 40) : [];
      const user = [
        `TODAY: ${ct(at)}`,
        ask ? `REQUEST:\n${ask}` : null,
        split ? split.note : null,
        rejections.length ? 'RECENT REJECTIONS (learn from these reasons):\n' + rejections.map((r) => `- "${r.title}": ${r.reason}`).join('\n') : null,
        seenMem.alreadyList(memory),
        'SOURCES:\n' + got.map((g) => `=== ${g.label} ===\n${g.text}`).join('\n\n'),
        unavailable.length ? 'UNAVAILABLE THIS RUN:\n' + unavailable.map((u) => `- ${u.label}: ${u.why}`).join('\n') : null,
        `Write at most ${agent.max_cards || 3} card(s).`,
      ].filter(Boolean).join('\n\n');
      const system = agent.skill + '\n\n' + CONTRACT + (agent.post_fields ? POST_CONTRACT : '') + (agent.pin_fields ? PIN_CONTRACT : '')
        + (agent.sales_fields && salesFieldsOn(env) ? SALES_CONTRACT : '')
        + (spec ? seenMem.seenContract(spec) : '');
      let cards = await draftCards(llm, { system, user, maxTokens: agent.max_tokens || 8000, max: agent.max_cards, log, slug: agent.slug });
      const drafted = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const all = cards[i].body + '\n' + cards[i].title + (cards[i].post ? '\n' + cards[i].post.content_md + '\n' + cards[i].post.title : '')
          + (cards[i].pin ? '\n' + cards[i].pin.title + '\n' + (cards[i].pin.description || '') : '')
          + (cards[i].sales ? '\n' + (cards[i].sales.subject || '') + '\n' + cards[i].sales.email : '');
        const t = lint(all);
        // #1724, #1748: every agent's card also goes through the Copywriter's internal-code check.
        const codes = internalCodes(all);
        if (t.clean && !codes.length) continue;
        const hits = [...t.fails, ...t.flags, ...codes].map((h) => `${h.rule}${h.phrase ? ` "${h.phrase}"` : ''}`).join('; ');
        // #2910: a rewrite that cannot be read keeps the card as drafted (the
        // badge still shows its hits) instead of failing the whole run.
        let fixed = null;
        // #3011: the rewrite gets the agent's own length limit (it used to fall
        // back to 8000 while the draft had 10000) and must return the whole body.
        try {
          fixed = parseCards(await llm.complete({ system, maxTokens: agent.max_tokens || 8000,
            user: `Rewrite this card to remove these ${codes.length ? 'copy check' : 'AI-tell'} hits: ${hits}. Keep every fact. Return the WHOLE body with every row, never "..." or a shortened version. Same JSON contract, one card.\n\n${JSON.stringify({ cards: [cards[i]] })}` }), 1)[0];
        } catch (e) {
          if (!e.badJson) throw e;
          log(`${agent.slug}: rewrite answer was not valid JSON (${e.message}); card kept as drafted`);
        }
        const lost = fixed ? rewriteLost(cards[i], fixed) : null;
        if (lost) { log(`${agent.slug}: rewrite dropped (${lost}); card kept as drafted`); fixed = null; }
        if (fixed) cards[i] = { ...fixed, seen: fixed.seen || cards[i].seen, open_dates: fixed.open_dates.length ? fixed.open_dates : cards[i].open_dates,
          sales: fixed.sales || cards[i].sales };
        // Still a dash after the rewrite: the Box replaces it with a comma and says so.
        const c = cards[i];
        const t1 = replaceDashes(c.title); const t2 = replaceDashes(c.body);
        let n = t1.replaced + t2.replaced;
        c.title = t1.text; c.body = t2.text;
        if (c.pin) for (const k of ['title', 'description', 'alt_text']) if (c.pin[k]) { const r = replaceDashes(c.pin[k]); c.pin[k] = r.text; n += r.replaced; }
        if (c.sales) for (const k of ['subject', 'email']) if (c.sales[k]) { const r = replaceDashes(c.sales[k]); c.sales[k] = r.text; n += r.replaced; }
        if (c.post) {
          for (const k of ['title', 'content_md', 'seo_title', 'seo_description', 'excerpt']) {
            if (c.post[k]) { const r = replaceDashes(c.post[k]); c.post[k] = r.text; n += r.replaced; }
          }
        }
        if (n) c.dashes_replaced = n;
      }
      // #1758: an item already drafted (waiting, approved, or rejected with an
      // unchanged source) is not redrafted. A card that cannot be keyed is kept.
      if (spec && store && store.seenCards) {
        const keyed = cards.map((c) => ({ c, key: seenMem.seenKey(spec, c.seen), source: seenMem.seenSource(spec, c.seen) }));
        const earlier = await store.seenCards(agent.slug, [...new Set(keyed.map((k) => k.key).filter(Boolean))]);
        const thisRun = new Set();
        cards = [];
        for (const k of keyed) {
          if (!k.key) { cards.push(k.c); continue; }
          // #2914: the item a person asked to redo is redrafted even though it was seen.
          const redoItem = redoCard && redoCard.seen_key && k.key === redoCard.seen_key;
          const j = thisRun.has(k.key) ? { keep: false, why: 'drafted twice in this run' }
            : (redoItem ? { keep: true } : seenMem.judge(earlier.filter((e) => e.seen_key === k.key), k.source));
          if (!j.keep) { skippedSeen.push({ key: k.key, title: k.c.title, why: j.why }); continue; }
          thisRun.add(k.key);
          Object.assign(k.c, { seen_key: k.key, seen_source: k.source, back: j.back || null });
          cards.push(k.c);
        }
        if (skippedSeen.length) log(`${agent.slug}: ${skippedSeen.length} skipped as already seen`);
      }
      // #3163: the Keyword Queen's topic card is checked by code before it is
      // saved: sourced figures or blank, canonical venues, 90-day memory, top 10.
      if (agent.topics_card) {
        const kq = require('./keyword-queen');
        const checked = [];
        for (const c of cards) checked.push(await kq.finishCard(c, { got, store, now: at, log }));
        cards = checked;
      }
      // #2909: under the hold, only the cards the split keeps are saved. A held
      // card is never saved, so it is not "seen" and is drafted once the hold lifts.
      if (split) {
        const kept = cards.filter((c) => split.keep(c));
        heldBySplit.push(...cards.filter((c) => !split.keep(c)).map((c) => c.title));
        cards = kept;
        if (heldBySplit.length) log(`${agent.slug}: ${heldBySplit.length} held by the Producer's hold (${split.held})`);
      }
      // #1703: every quote about an outside page is checked against the page as
      // fetched this run, before the card is saved.
      const snap = snapshotter({ fetchImpl });
      const prepass = wantsPrepass(agent, ask);
      // #2904: the dates a card offers are checked against the measured open
      // dates and written by code. Without the source (switch off, or it could
      // not be read) a card that tries to offer dates offers none.
      const od = got.find((g) => g.type === 'open_dates');
      for (const c of cards) {
        // #3011: an empty or "..." card is never saved as a draft. It is saved
        // as a failed-run card that says why, like "run failed".
        const stub = stubReason(draftWords(c));
        if (stub) {
          emptyCards.push(c.title);
          log(`${agent.slug}: empty card "${c.title}" (${stub}); saved as a failed-run card`);
          await put({ title: `${agent.name} run produced an empty card`, target: c.target || null, empty_card: true,
            body: finishBody({ body: `The run drafted "${c.title}" but ${stub}, so it was not saved as a draft. Nothing was drafted for it; run it again, or the next scheduled run tries again.` },
              { def: agent, got: [], unavailable, now: at, model: llm.model }) });
          continue;
        }
        if (c.body.includes(openDates.TOKEN) || (c.open_dates && c.open_dates.length)) {
          c.body = od ? openDates.fillOpenDates(c.body, c.open_dates, od.measured, ct(at)).body
            : c.body.split(openDates.TOKEN).join('(Open dates were not read this run: ask sales for current availability.)');
        }
        const cc = prepass ? await copyPrepass(c, { store, llm, env, fetchImpl, at, dryRun, saKey, saToken }) : null;
        const { post, pin, sales, claims, seen, back, open_dates: _od, topics, ...rest } = c;
        const q = await checkClaims(claims, snap);
        const gated = { ...c, body: applyGate(c.body, q) };
        const extra = gateSections(q, ct(at));
        if (extra) gated.body = gated.body.trim() + '\n\n' + extra;
        // #1710: the measured evidence rides with the pin, written by code, so the handoff can check the photo and link against it.
        // #3164: with PINTEREST_PER_VENUE on, code (not the model) sets which venue's account the pin goes to.
        const PV = require('./pinterest-venues');
        await put({ ...rest, payload: post ? { post } : (pin ? { pin: PV.perVenueOn(env) ? PV.placePin(pin) : pin, evidence: got.map((g) => g.table).filter(Boolean).join('\n') }
          : (sales && agent.sales_fields && salesFieldsOn(env) ? { sales: outreach.draft(sales, env) }
            : (topics && agent.topics_card ? { topics } : null))),
          quotes: { passed: q.passed.length, failed: q.failed.length },
          copy_check: cc ? cc.check : undefined,
          ...(redoCard ? { redo_of: redoCard.id } : {}),
          body: finishBody(gated, { def: agent, got, unavailable, now: at, model: llm.model, copy: cc ? cc.section : null,
            seen: back ? seenMem.backNote(back) : null, redo: redoCard ? redoNote(redoCard) : null }) });
      }
      // #2914: the revised card is saved; the original is kept, rejected with her words.
      if (redoCard && cards.length > emptyCards.length && !dryRun && store.finishRedo) await store.finishRedo(redoCard.id, written[written.length - 1].id);
      if (!drafted) throw new Error('the model returned no cards');
      // A Run now that found only items already drafted answers the request with one card saying so.
      if (!cards.length && ask) {
        await put({ title: `${agent.name}: already drafted, nothing new`, target: null,
          body: finishBody({ body: `Everything this run found was drafted before, so nothing was redrafted:\n\n${skippedSeen.map((s) => `- ${s.title}: ${s.why}`).join('\n')}` },
            { def: agent, got, unavailable, now: at, model: llm.model }) });
      }
    }
    const seenNote = skippedSeen.length ? `${skippedSeen.length} skipped as already seen` : null;
    // #1759: SEO's Bob lines and Citations' gap sites become queued runs (drafts only).
    // #2901: the Producer routes them (and, with PRODUCER_QUEUE on, the Scout's blog move).
    const chained = !dryRun && llm ? await require('./producer').afterRun({ slug: agent.slug, cards: written, store, env, log }) : null;
    const splitNote = heldBySplit.length ? `${heldBySplit.length} held by the Producer's hold (${split.held}; RED review replies only)` : null;
    const emptyNote = emptyCards.length ? `${emptyCards.length} empty card${emptyCards.length === 1 ? '' : 's'} saved as failed: ${emptyCards.join(', ')}`.slice(0, 300) : null;
    const note = [emptyNote, seenNote, splitNote, chained && chained.note].filter(Boolean).join('; ') || null;
    if (!dryRun) await store.finishRun(runId, { status: 'done', cards: written.length, unavailable, note, seen_skipped: skippedSeen.length });
    return split
      ? { ok: true, cards: written, unavailable, seen_skipped: skippedSeen.length, chained, held_by_split: heldBySplit.length }
      : { ok: true, cards: written, unavailable, seen_skipped: skippedSeen.length, chained };
  } catch (e) {
    log(`${agent.slug}: FAILED ${safeReason(e.message, 300)}`);
    await put({ title: `${agent.name} run failed`, target: null,
      body: finishBody({ body: e.badJson || /not valid JSON/.test(e.message)
        ? `The run stopped: ${plainNote(e.message)}`
        : `The run stopped: ${safeReason(e.message, 300)}. Nothing was drafted. The next scheduled run tries again.` }, { def: agent, got, unavailable, now: at }) }).catch(() => {});
    if (!dryRun) await store.finishRun(runId, { status: 'failed', cards: written.length, unavailable, note: safeReason(e.message, 500), seen_skipped: skippedSeen.length });
    return { ok: false, error: safeReason(e.message, 300), cards: written, unavailable, seen_skipped: skippedSeen.length };
  }
}

module.exports = { runAgent, loadAgent, listAgents, parseCards, draftCards, missingLine, finishBody, modelText, tellsSummary, wantsPrepass, outboundText, copyPrepass, rewriteLost,CONTRACT, POST_CONTRACT, PIN_CONTRACT, SALES_CONTRACT, salesFieldsOn, parseSales, AGENTS_DIR };
