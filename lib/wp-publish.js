// ORDER #3817 (Mimi 11.25.2026, popup answering #3807's [RULING]: "B: publish
// live"). This replaces her 10.09.2026 ruling ("Bob drafts into WordPress and
// never publishes"). An APPROVED Bloggy Bob card is published live on its site
// by jobs/agent_handoff.js, right after lib/wp-draft.js has saved and read back
// its draft. The person who pressed Approve is the approval.
//
// 🔴 SWITCH: BLOG_PUBLISH_ON_APPROVE, default OFF. Off, nothing here runs and the
// card stays an unpublished draft, exactly as before. Turning it on is Mimi's.
// Kill lever: set it to anything but "on".
//
// 🔴 THE FENCE. This is the ONLY file that may publish a WordPress post. It sets
// one status, PUBLISH, in one place, on the post id the card's own draft just
// created. It never creates a post (lib/wp-draft.js does, as a draft), never
// edits any other field, never deletes, never touches another post. A read-back
// that is not live is an ALARM on the card. lib/wp-draft.js keeps its own fence:
// it still cannot send any status but draft.
//
// THE GATES (same as Approve, re-checked at publish time): the Approve check
// (AI tells that fail, em dash, spaced en dash, hard capacity, internal codes),
// the TBB one-room capacity rule, no dollar figure, no Fact-Checker UNVERIFIED
// claim, and the claims-register guard (#3734): a provenance or history phrase
// must match a register row marked TRUE. The register unreadable = no publish.
// Any gate that fails means no publish; the draft stays and the card says why.
'use strict';

const { keychainLogin, normalizeSite, WP_SITES } = require('./wp-draft');

const FLAG = 'BLOG_PUBLISH_ON_APPROVE';
const PUBLISH = 'publish';
const OFF_WHY = `Blog publishing is off (${FLAG}); it stays an unpublished draft`;
const REGISTER_PATH = '07_Marketing_and_Brand/Claims_Register_11.18.2026.md';

function on(env = process.env) { return String((env && env[FLAG]) || '').trim().toLowerCase() === 'on'; }

const DOLLAR = /\$\s?\d|\b\d[\d,.]*\s?(?:dollars|USD)\b/i;
const UNVERIFIED = /\bUNVERIFIED\b|\(unverified\)/i;
// Provenance or history phrases (#3575 step 5's list): kept narrow so ordinary
// words ("your first dance") do not trip it.
const PROVENANCE = /\b(?:award[- ]winning|the (?:first|original|only|oldest|largest)\b|(?:first|oldest|largest|only) [a-z]+ (?:venue|barn|church|building|in)\b|built by|built in \d{4}|founded in|established in|since (?:1[6-9]|20)\d{2})/i;

const postParts = (post) => [['the post title', post.title], ['the post SEO title', post.seo_title], ['the post SEO description', post.seo_description],
  ['the post excerpt', post.excerpt], ['the post', post.content_md]].filter(([, t]) => t);

const sentencesOf = (t) => String(t || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const wordsOf = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 5);

// A sentence with a provenance phrase passes only if one register row marked
// TRUE carries the same phrase and most of the sentence's longer words.
function registerAllows(sentence, allowed) {
  const hit = (sentence.match(PROVENANCE) || [''])[0].toLowerCase();
  const mine = wordsOf(sentence);
  return allowed.some((row) => {
    const text = String(row.claim || '').toLowerCase();
    if (hit && !text.includes(hit.replace(/^the /, ''))) return false;
    const theirs = new Set(wordsOf(text));
    const shared = mine.filter((w) => theirs.has(w)).length;
    return shared >= 3 && shared >= Math.ceil(mine.length * 0.5);
  });
}

// Every reason this card may not be published; [] = all gates pass.
function publishGate(card, { register } = {}) {
  const { lint } = require('./ai-tells');
  const { approveBlockers } = require('./agent-store');
  const post = (card && card.payload && card.payload.post) || {};
  const why = [];
  for (const b of approveBlockers(card, lint)) why.push(`the Approve check: ${b}`);
  for (const [where, text] of postParts(post)) {
    for (const f of lint(String(text)).flags.filter((h) => h.rule === 'TBB one-room capacity')) why.push(`${where}: TBB one-room capacity "${f.phrase}"`);
    if (DOLLAR.test(String(text))) why.push(`${where}: a dollar figure`);
    if (UNVERIFIED.test(String(text))) why.push(`${where}: carries a Fact-Checker UNVERIFIED claim`);
  }
  if (UNVERIFIED.test(String((card && card.body) || ''))) why.push('the card: the Fact-Checker marked a claim UNVERIFIED');
  if (register == null) why.push('the claims register could not be read, so no provenance claim can be checked');
  else {
    const { allowed } = require('./claims-register').allowedClaims(register);
    for (const [where, text] of postParts(post)) {
      for (const s of sentencesOf(text)) {
        if (PROVENANCE.test(s) && !registerAllows(s, allowed)) why.push(`${where}: a provenance claim not marked TRUE in the claims register: "${s.slice(0, 120)}"`);
      }
    }
  }
  return why;
}

// The register as written in the tree (not the guard text the agent reads).
async function readRegister(env = process.env) {
  const { fileSource } = require('./agent-sources');
  const r = await fileSource({ type: 'file', path: REGISTER_PATH }, { env });
  return r && r.ok ? r.text : null;
}

function wpError(status, data, text) {
  if (data && (data.code || data.message)) return `HTTP ${status} ${data.code || ''}: ${data.message || ''}`.trim();
  return `HTTP ${status} ${String(text || '').slice(0, 200)}`;
}

// Publish the draft this card just made (by id), then read it back.
async function publishDraft({ site, id, env = process.env, fetchImpl = globalThis.fetch, login = keychainLogin }) {
  if (!on(env)) return { ok: false, skip: true, why: OFF_WHY };
  const s = normalizeSite(site);
  if (!WP_SITES.has(s)) return { ok: false, why: `${s || 'no site'} is not one of our WordPress sites` };
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return { ok: false, why: 'no draft id to publish' };
  const auth = login(s);
  if (!auth) return { ok: false, why: `no WordPress login for ${s} on this machine` };
  const origin = `https://${s}`;
  const headers = { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64'),
    'Content-Type': 'application/json', 'User-Agent': 'IHG-Brain-Bob/1.0 (publish on approve)' };
  const url = `${origin}/wp-json/wp/v2/posts/${Number(id)}`;
  let r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ status: PUBLISH }) });
  let text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { /* not json */ }
  if (r.status !== 200) return { ok: false, why: 'WordPress refused to publish: ' + wpError(r.status, data, text) };
  r = await fetchImpl(`${url}?context=edit`, { headers });
  text = await r.text();
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (r.status !== 200 || !data) return { ok: false, alarm: true, why: 'ALARM: publish sent but the read-back was refused: ' + wpError(r.status, data, text) };
  if (data.status !== PUBLISH) return { ok: false, alarm: true, why: `ALARM: read back with status "${data.status}", not live` };
  return { ok: true, id: Number(id), link: data.link || null, status: data.status };
}

module.exports = { FLAG, OFF_WHY, REGISTER_PATH, on, publishGate, publishDraft, readRegister, registerAllows };
