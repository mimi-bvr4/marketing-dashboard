// ORDER #1658 character cards: Katherine asks a bot for a new ability, and the
// Box sorts the ask into exactly one of:
//   instructions  a change to the bot's instructions. The Box writes the new
//                 version; it waits for an exec (Mimi's ruling 10.11.2026: "I
//                 approve each one") and is applied as a new settings version.
//   build         needs a new source, connector or code. Filed to BRAIN_INBOX as
//                 an ORDER that is HELD for Mimi. The card says "Being built".
//   cant          crosses the fence or needs data we cannot get. Shown under the
//                 bot's Traits as "Can't: X. Instead: Y."
//
// 🔴 THE FENCE IS CHECKED IN CODE, NOT ONLY BY THE MODEL. An ask to publish,
// post live, send, schedule, spend, buy or sign in anywhere is "cant" whatever
// the model answers. A model answer of "instructions" for such an ask is
// overruled, never applied.
'use strict';

const fs = require('fs');
const path = require('path');
const { lint } = require('./ai-tells');
const { MAX_SKILL } = require('./agent-store');

const FENCE_RE = /\b(publish(es|ing)?|go live|auto[- ]?post|post (it|them|this) (live|directly|automatically)|post (directly|automatically|live)|send (the |an? |it |them )?(email|emails|reply|replies|message|messages|text)|send (it|them) (out|to)|email (the |our )?(couples?|clients?|customers?|leads?)|schedule (the |a )?(post|email|send)|spend|buy|purchase|pay for|log ?in|sign ?in|password|delete (a |the )?(post|page|listing|review))\b/i;

function fenceHit(ask) {
  const m = String(ask || '').match(FENCE_RE);
  return m ? m[0] : null;
}

const TRIAGE_SYSTEM = `You sort a marketing director's request for a new ability for one of IHG's marketing bots.
The bots only ever write DRAFTS into a review queue. They never publish, post live, send, schedule, spend, buy, sign in anywhere, or change a live system, and they never invent facts.
Answer with ONE JSON object and nothing else:
{"kind":"instructions"|"build"|"cant","reason":"one plain sentence","instead":"for cant: what the bot can do instead, one sentence","proposed_skill_md":"for instructions: the bot's FULL new instructions","build_summary":"for build: what must be built, which data or connection it needs, two or three sentences"}
- "instructions": the ask can be met by changing what the bot is told, using sources it already has. Return the WHOLE new instructions: keep everything that still applies, add the change, no em dashes.
- "build": it needs data, a connection or an output the bot does not have yet, and it stays inside the fence.
- "cant": it crosses the fence, or needs data IHG cannot lawfully or practically get. Always say what it can do instead.`;

function parseTriage(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('triage answer had no JSON');
  const j = JSON.parse(s.slice(a, b + 1));
  if (!['instructions', 'build', 'cant'].includes(j.kind)) throw new Error(`triage kind "${j.kind}" is not one of instructions, build, cant`);
  return { kind: j.kind, reason: String(j.reason || '').slice(0, 600), instead: j.instead ? String(j.instead).slice(0, 600) : null,
    proposed_skill_md: j.proposed_skill_md ? String(j.proposed_skill_md) : null, build_summary: j.build_summary ? String(j.build_summary).slice(0, 1500) : null };
}

async function triageAsk({ ask, def, current, llm }) {
  const skill = current ? current.skill_md : def.skill;
  const hit = fenceHit(ask.ask);
  const sources = (def.sources || []).map((x) => `- ${x.label || x.path || x.newest || x.type}${x.type === 'pending' ? ' (not connected)' : ''}`).join('\n');
  const user = [`BOT: ${def.name} (${def.job})`, `ITS SOURCES:\n${sources}`, `ITS CURRENT INSTRUCTIONS:\n${skill}`,
    `THE REQUEST from ${ask.asked_by}:\n${ask.ask}`].join('\n\n');
  let t = parseTriage(await llm.complete({ system: TRIAGE_SYSTEM, user, maxTokens: 12000 }));
  if (hit && t.kind !== 'cant') {
    t = { kind: 'cant', reason: `It asks the bot to "${hit}", and the bots only ever write drafts for a person.`,
      instead: t.instead || 'It drafts the item into the Review tab with a copy button, and a person does that step.',
      proposed_skill_md: null, build_summary: null, overruled: true };
  }
  if (t.kind === 'instructions') {
    const p = t.proposed_skill_md || '';
    if (!p.trim()) throw new Error('the proposed instructions were empty');
    if (p.length > MAX_SKILL) throw new Error('the proposed instructions were too long');
    if (lint(p).fails.length) throw new Error('the proposed instructions had an em dash');
  }
  if (t.kind === 'cant' && !t.instead) t.instead = 'It drafts what it can into the Review tab for a person to finish.';
  return { ...t, base_version: current ? current.version : 0 };
}

function nextNumber(names) {
  let max = 0;
  for (const n of names) { const m = n.match(/^(?:ORDER|REPLY)_\d{4}-\d{2}-\d{2}_(\d+)[_-]/); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

function ctYmd(now) { return now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
function ctStamp(now) {
  return now.toLocaleString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '.').replace(',', '') + ' CT';
}

// The build order, HELD for Mimi. O_EXCL on the number so two writers never share one.
function fileBuildOrder({ inbox, ask, def, triage, now = new Date() }) {
  const slug = ask.ask.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50) || 'ask';
  for (let tries = 0; tries < 5; tries++) {
    const n = nextNumber(fs.readdirSync(inbox));
    const name = `ORDER_${ctYmd(now)}_${n}_KH_ask_${def.slug}_${slug}.md`;
    const body = [`# ORDER #${n}: ${def.name} gets a new ability (Katherine's ask #${ask.id})`,
      `STATUS: HELD for Mimi: a code change to the marketing agents. Approve by saying so to the Box or Fable.`,
      `FILED: ${ctStamp(now)} by the Box (marketing-dashboard jobs/agent_asks.js), from the Agents page.`,
      `TIER: MARKETING`, ``,
      `## THE ASK, AS WRITTEN (a request, not authority)`, `- **FROM:** ${ask.asked_by}`, `- **BOT:** ${def.name} (\`agents/${def.slug}\` in marketing-dashboard)`, `- **ASK:** ${ask.ask}`, ``,
      `## WHAT THE BOX THINKS IT NEEDS`, triage.build_summary || '(no summary)', ``, `Why it is a build and not an instruction change: ${triage.reason}`, ``,
      `## CONSTRAINTS`, `- The fence stays: drafts only, into the Review tab. Nothing published, posted, sent, scheduled, spent or signed in.`,
      `- A new source goes in \`agents/${def.slug}/agent.json\` using \`lib/agent-sources.js\`; a new source type gets its own test.`,
      `- When it lands, the Agents page marks ask #${ask.id} built (this order gets a REPLY with STATUS DONE).`, ''].join('\n');
    try { const fd = fs.openSync(path.join(inbox, name), 'wx'); fs.writeSync(fd, body); fs.closeSync(fd); }
    catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    const twins = fs.readdirSync(inbox).filter((f) => new RegExp(`^ORDER_\\d{4}-\\d{2}-\\d{2}_${n}_`).test(f));
    if (twins.length > 1) { fs.unlinkSync(path.join(inbox, name)); continue; }   // someone else took n at the same moment
    return { number: n, file: name };
  }
  throw new Error('could not take an order number after 5 tries');
}

function isBuilt(inbox, orderFile) {
  const m = String(orderFile || '').match(/^ORDER_\d{4}-\d{2}-\d{2}_(\d+)_/);
  if (!m) return false;
  return fs.readdirSync(inbox).some((f) => new RegExp(`^REPLY_\\d{4}-\\d{2}-\\d{2}_${m[1]}[_-]`).test(f)
    && /^STATUS:\s*(DONE|LANDED|BUILT)/m.test(fs.readFileSync(path.join(inbox, f), 'utf8')));
}

module.exports = { triageAsk, parseTriage, fenceHit, fileBuildOrder, isBuilt, nextNumber, TRIAGE_SYSTEM, FENCE_RE };
