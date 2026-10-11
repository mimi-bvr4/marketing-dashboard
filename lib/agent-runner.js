// ORDER #1015: one runner for every marketing agent.
//
// An agent is a folder: agents/<slug>/SKILL.md (what it is for and how it
// works, plain markdown, the same shape as a Claude skill or a ChatGPT plugin
// skill) + agents/<slug>/agent.json (name, job, sources, card limit). Adding an
// agent is adding a folder; this file does not change.
//
// A run: gather the declared sources -> one model call with the SKILL.md as the
// system prompt -> parse cards -> lint each card against AI_TELLS_BAN_LIST, and
// on any hit ask the model once to fix it -> append the measured evidence and
// the credit line -> insert as DRAFT. Approve on the Review tab never publishes.
//
// Never silent (iron rule 8): a source that cannot be reached is named on the
// card; a run with no model or a model error still writes a card saying so.
'use strict';

const fs = require('fs');
const path = require('path');
const { gather } = require('./agent-sources');
const { lint, summary } = require('./ai-tells');

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
OUTPUT CONTRACT (the runner enforces it):
Answer with ONE JSON object and nothing else: {"cards":[{"title":"...","target":"site, venue or channel","body":"markdown"}]}
- Every card is a DRAFT for a human. Never say anything was published, posted, sent or changed.
- Use only facts found in the SOURCES below. If a fact is not there, leave it out or write "(unverified)".
- If a source is listed as unavailable, say so on the card in one line instead of guessing around it.
- No em dashes and no spaced en dashes anywhere. Follow the AI-tells ban list in the skill.
- Dates as MM.DD.YYYY. No dollar figures about runs or costs.`;

function parseCards(text, max) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('model answer had no JSON object');
  const j = JSON.parse(s.slice(a, b + 1));
  const cards = Array.isArray(j.cards) ? j.cards : [];
  return cards.filter((c) => c && c.title && c.body).slice(0, max || 5)
    .map((c) => ({ title: String(c.title).slice(0, 200), target: c.target ? String(c.target).slice(0, 120) : null, body: String(c.body) }));
}

function ct(now) {
  return now.toLocaleString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '.').replace(',', '') + ' CT';
}

function finishBody(card, { def, got, unavailable, now, model }) {
  const parts = [card.body.trim()];
  for (const g of got) if (g.table) parts.push(`### Measured: ${g.label} (${ct(now)})\n\n${g.table}`);
  if (unavailable.length) parts.push('### Sources unavailable this run\n\n' + unavailable.map((u) => `- ${u.label}: ${u.why}`).join('\n'));
  parts.push(`_Drafted by ${def.name} (the Box), ${ct(now)}${model ? `, model ${model}` : ''}. A draft: nothing was published, sent or changed._`);
  return parts.join('\n\n');
}

async function runAgent({ slug, def, store, llm, ask = null, env = process.env, fetchImpl = globalThis.fetch,
  now = () => new Date(), log = () => {}, dryRun = false }) {
  const agent = def || loadAgent(slug);
  const runId = dryRun ? null : await store.startRun(agent.slug);
  const at = now();
  const { got, unavailable } = await gather(agent.sources || [], { env, ask, fetch: fetchImpl, lint });
  log(`${agent.slug}: ${got.length} sources read, ${unavailable.length} unavailable`);
  const sources = [...got.map((g) => ({ label: g.label, ok: true })), ...unavailable.map((u) => ({ label: u.label, ok: false, why: u.why }))];
  const base = { agent: agent.slug, agent_name: agent.name, job: agent.job, run_id: runId, sources };
  const written = [];
  const put = async (c) => {
    const tells = lint(c.body);
    const card = { ...base, ...c, checks: { ai_tells: tells, ai_tells_summary: summary(tells) } };
    written.push(dryRun ? card : await store.insert(card));
  };
  const required = (agent.sources || []).filter((s) => s.required).map((s) => s.label || s.path || s.type);
  const missingRequired = unavailable.filter((u) => required.includes(u.label));
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
      const user = [
        `TODAY: ${ct(at)}`,
        ask ? `REQUEST:\n${ask}` : null,
        rejections.length ? 'RECENT REJECTIONS (learn from these reasons):\n' + rejections.map((r) => `- "${r.title}": ${r.reason}`).join('\n') : null,
        'SOURCES:\n' + got.map((g) => `=== ${g.label} ===\n${g.text}`).join('\n\n'),
        unavailable.length ? 'UNAVAILABLE THIS RUN:\n' + unavailable.map((u) => `- ${u.label}: ${u.why}`).join('\n') : null,
        `Write at most ${agent.max_cards || 3} card(s).`,
      ].filter(Boolean).join('\n\n');
      const system = agent.skill + '\n\n' + CONTRACT;
      let cards = parseCards(await llm.complete({ system, user, maxTokens: agent.max_tokens || 8000 }), agent.max_cards);
      for (let i = 0; i < cards.length; i++) {
        const t = lint(cards[i].body + '\n' + cards[i].title);
        if (t.clean) continue;
        const hits = [...t.fails, ...t.flags].map((h) => `${h.rule}${h.phrase ? ` "${h.phrase}"` : ''}`).join('; ');
        const fixed = parseCards(await llm.complete({ system,
          user: `Rewrite this card to remove these AI-tell hits: ${hits}. Keep every fact. Same JSON contract, one card.\n\n${JSON.stringify({ cards: [cards[i]] })}` }), 1)[0];
        if (fixed) cards[i] = fixed;
      }
      for (const c of cards) await put({ ...c, body: finishBody(c, { def: agent, got, unavailable, now: at, model: llm.model }) });
      if (!cards.length) throw new Error('the model returned no cards');
    }
    if (!dryRun) await store.finishRun(runId, { status: 'done', cards: written.length, unavailable });
    return { ok: true, cards: written, unavailable };
  } catch (e) {
    log(`${agent.slug}: FAILED ${e.message}`);
    await put({ title: `${agent.name} run failed`, target: null,
      body: finishBody({ body: `The run stopped: ${e.message}. Nothing was drafted. The next scheduled run tries again.` }, { def: agent, got, unavailable, now: at }) }).catch(() => {});
    if (!dryRun) await store.finishRun(runId, { status: 'failed', cards: written.length, unavailable, note: e.message.slice(0, 500) });
    return { ok: false, error: e.message, cards: written, unavailable };
  }
}

module.exports = { runAgent, loadAgent, listAgents, parseCards, finishBody, CONTRACT, AGENTS_DIR };
