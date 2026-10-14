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
const chains = require('./agent-chains');

// The bot's own words: everything before the runner's appended sections. The
// lint and the approve check read only this, never the measured tables.
// #1748: the Copywriter's section quotes the original ("what it was"), so it is
// never the bot's own words either. #1758: nor is the Box's "Seen before" note.
const APPENDED = ['\n### Seen before', '\n### Quotes checked this run', '\n### Not checked this run', '\n### Copy check', '\n### Measured: ', '\n### Sources unavailable this run', '\n_Drafted by '];
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

function parseCards(text, max) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('model answer had no JSON object');
  const j = JSON.parse(s.slice(a, b + 1));
  const cards = Array.isArray(j.cards) ? j.cards : [];
  return cards.filter((c) => c && c.title && c.body).slice(0, max || 5)
    .map((c) => ({ title: String(c.title).slice(0, 200), target: c.target ? String(c.target).slice(0, 120) : null, body: String(c.body),
      post: parsePost(c.post), pin: parsePin(c.pin), claims: Array.isArray(c.claims) ? c.claims : [],
      seen: c.seen && typeof c.seen === 'object' && !Array.isArray(c.seen) ? c.seen : null }));
}

function ct(now) {
  return now.toLocaleString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '.').replace(',', '') + ' CT';
}

function finishBody(card, { def, got, unavailable, now, model, copy, seen }) {
  const parts = [card.body.trim()];
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

async function copyPrepass(c, { store, llm, env, fetchImpl, at, dryRun, saKey, saToken }) {
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
    return { section: `### Copy check (the Copywriter, before you saw this)\n\n${out.body.trim()}`,
      check: { ran: true, ready, changes: m ? Number(m[1]) : 0, summary: ready ? 'Copy check: Ready to go out' : `Copy check: Needs changes (${m[1]})` } };
  } catch (e) {
    return { section: `### Copy check did not run\n\nCopy check did not run: ${e.message}. Check the words yourself, or paste them into the Copywriter, before this goes out.`,
      check: { ran: false, why: String(e.message).slice(0, 300), summary: 'Copy check did not run' } };
  }
}

async function runAgent({ slug, def, store, llm, ask = null, env = process.env, fetchImpl = globalThis.fetch,
  now = () => new Date(), log = () => {}, dryRun = false, scheduled = false, saKey, saToken }) {
  const agent = { ...(def || loadAgent(slug)) };
  // #1658: Katherine's latest version from the Agents page wins over the repo default.
  const s = store && store.currentSettings ? await store.currentSettings(agent.slug) : null;
  if (s) Object.assign(agent, { skill: s.skill_md, max_cards: s.max_cards, enabled: s.enabled, version: s.version, edited_by: s.edited_by });
  // #1664: the name Katherine gave it goes on its cards. Cosmetic; the skill is unchanged.
  const prof = store && store.profile ? await store.profile(agent.slug) : null;
  if (prof && prof.display_name) agent.name = prof.display_name;
  if (scheduled && agent.enabled === false) {
    log(`${agent.slug}: paused on the Agents page${s ? ` by ${s.edited_by}` : ''}; scheduled run skipped`);
    return { ok: true, skipped: 'paused', cards: [], unavailable: [] };
  }
  const runId = dryRun ? null : await store.startRun(agent.slug);
  const at = now();
  const { got, unavailable } = await gather(agent.sources || [], { env, ask, fetch: fetchImpl, lint, store, agent: agent.slug, dryRun, now, saKey, saToken });
  log(`${agent.slug}: ${got.length} sources read, ${unavailable.length} unavailable`);
  const sources = [...got.map((g) => ({ label: g.label, ok: true })), ...unavailable.map((u) => ({ label: u.label, ok: false, why: u.why }))];
  const base = { agent: agent.slug, agent_name: agent.name, job: agent.job, run_id: runId, sources };
  const written = [];
  const spec = agent.seen_before && Array.isArray(agent.seen_before.key) ? agent.seen_before : null;
  const skippedSeen = [];
  const put = async (c) => {
    const pinText = c.payload && c.payload.pin ? '\n' + c.payload.pin.title + '\n' + (c.payload.pin.description || '') : '';
    const tells = lint((c.title || '') + '\n' + modelText(c.body) + (c.payload && c.payload.post ? '\n' + c.payload.post.content_md : '') + pinText);
    // #1724, #1748 (every agent): the card also says which internal codes are still in it after the rewrite.
    const left = [...new Set(internalCodes((c.title || '') + '\n' + modelText(c.body)).map((h) => h.phrase.split(' ')[0]))];
    const card = { ...base, ...c, checks: { ai_tells: tells, ai_tells_summary: summary(tells) + (c.dashes_replaced ? `, ${c.dashes_replaced} dash${c.dashes_replaced === 1 ? '' : 'es'} replaced by the Box` : '')
      + (left.length ? `, internal code${left.length === 1 ? '' : 's'} left: ${left.join(', ')}` : ''),
      ...(c.quotes ? { quotes: c.quotes } : {}) } };
    if (c.copy_check) card.checks.copy_check = c.copy_check;
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
        rejections.length ? 'RECENT REJECTIONS (learn from these reasons):\n' + rejections.map((r) => `- "${r.title}": ${r.reason}`).join('\n') : null,
        seenMem.alreadyList(memory),
        'SOURCES:\n' + got.map((g) => `=== ${g.label} ===\n${g.text}`).join('\n\n'),
        unavailable.length ? 'UNAVAILABLE THIS RUN:\n' + unavailable.map((u) => `- ${u.label}: ${u.why}`).join('\n') : null,
        `Write at most ${agent.max_cards || 3} card(s).`,
      ].filter(Boolean).join('\n\n');
      const system = agent.skill + '\n\n' + CONTRACT + (agent.post_fields ? POST_CONTRACT : '') + (agent.pin_fields ? PIN_CONTRACT : '')
        + (spec ? seenMem.seenContract(spec) : '');
      let cards = parseCards(await llm.complete({ system, user, maxTokens: agent.max_tokens || 8000 }), agent.max_cards);
      const drafted = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const all = cards[i].body + '\n' + cards[i].title + (cards[i].post ? '\n' + cards[i].post.content_md + '\n' + cards[i].post.title : '')
          + (cards[i].pin ? '\n' + cards[i].pin.title + '\n' + (cards[i].pin.description || '') : '');
        const t = lint(all);
        // #1724, #1748: every agent's card also goes through the Copywriter's internal-code check.
        const codes = internalCodes(all);
        if (t.clean && !codes.length) continue;
        const hits = [...t.fails, ...t.flags, ...codes].map((h) => `${h.rule}${h.phrase ? ` "${h.phrase}"` : ''}`).join('; ');
        const fixed = parseCards(await llm.complete({ system,
          user: `Rewrite this card to remove these ${codes.length ? 'copy check' : 'AI-tell'} hits: ${hits}. Keep every fact. Same JSON contract, one card.\n\n${JSON.stringify({ cards: [cards[i]] })}` }), 1)[0];
        if (fixed) cards[i] = { ...fixed, seen: fixed.seen || cards[i].seen };
        // Still a dash after the rewrite: the Box replaces it with a comma and says so.
        const c = cards[i];
        const t1 = replaceDashes(c.title); const t2 = replaceDashes(c.body);
        let n = t1.replaced + t2.replaced;
        c.title = t1.text; c.body = t2.text;
        if (c.pin) for (const k of ['title', 'description', 'alt_text']) if (c.pin[k]) { const r = replaceDashes(c.pin[k]); c.pin[k] = r.text; n += r.replaced; }
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
          const j = thisRun.has(k.key) ? { keep: false, why: 'drafted twice in this run' } : seenMem.judge(earlier.filter((e) => e.seen_key === k.key), k.source);
          if (!j.keep) { skippedSeen.push({ key: k.key, title: k.c.title, why: j.why }); continue; }
          thisRun.add(k.key);
          Object.assign(k.c, { seen_key: k.key, seen_source: k.source, back: j.back || null });
          cards.push(k.c);
        }
        if (skippedSeen.length) log(`${agent.slug}: ${skippedSeen.length} skipped as already seen`);
      }
      // #1703: every quote about an outside page is checked against the page as
      // fetched this run, before the card is saved.
      const snap = snapshotter({ fetchImpl });
      const prepass = wantsPrepass(agent, ask);
      for (const c of cards) {
        const cc = prepass ? await copyPrepass(c, { store, llm, env, fetchImpl, at, dryRun, saKey, saToken }) : null;
        const { post, pin, claims, seen, back, ...rest } = c;
        const q = await checkClaims(claims, snap);
        const gated = { ...c, body: applyGate(c.body, q) };
        const extra = gateSections(q, ct(at));
        if (extra) gated.body = gated.body.trim() + '\n\n' + extra;
        // #1710: the measured evidence rides with the pin, written by code, so the handoff can check the photo and link against it.
        await put({ ...rest, payload: post ? { post } : (pin ? { pin, evidence: got.map((g) => g.table).filter(Boolean).join('\n') } : null),
          quotes: { passed: q.passed.length, failed: q.failed.length },
          copy_check: cc ? cc.check : undefined,
          body: finishBody(gated, { def: agent, got, unavailable, now: at, model: llm.model, copy: cc ? cc.section : null,
            seen: back ? seenMem.backNote(back) : null }) });
      }
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
    const chained = !dryRun && llm ? await chains.afterRun({ slug: agent.slug, cards: written, store, env, log }) : null;
    const note = [seenNote, chained && chained.note].filter(Boolean).join('; ') || null;
    if (!dryRun) await store.finishRun(runId, { status: 'done', cards: written.length, unavailable, note, seen_skipped: skippedSeen.length });
    return { ok: true, cards: written, unavailable, seen_skipped: skippedSeen.length, chained };
  } catch (e) {
    log(`${agent.slug}: FAILED ${e.message}`);
    await put({ title: `${agent.name} run failed`, target: null,
      body: finishBody({ body: `The run stopped: ${e.message}. Nothing was drafted. The next scheduled run tries again.` }, { def: agent, got, unavailable, now: at }) }).catch(() => {});
    if (!dryRun) await store.finishRun(runId, { status: 'failed', cards: written.length, unavailable, note: e.message.slice(0, 500), seen_skipped: skippedSeen.length });
    return { ok: false, error: e.message, cards: written, unavailable, seen_skipped: skippedSeen.length };
  }
}

module.exports = { runAgent, loadAgent, listAgents, parseCards, finishBody, modelText, wantsPrepass, outboundText, CONTRACT, POST_CONTRACT, PIN_CONTRACT, AGENTS_DIR };
