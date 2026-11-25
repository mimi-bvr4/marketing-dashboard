// ORDER #3799 (Mimi 11.24.2026): "The posting of the actual post is the best
// part." An APPROVED Google Business card with a post on it (payload.gbp_post)
// is posted to that venue's Google Business Profile by jobs/agent_handoff.js on
// the Box's next run. The person who pressed Approve is the approval: the post
// goes out word for word as approved, nothing the Box decides on its own.
//
// 🔴 SWITCH: GBP_POST_ON_APPROVE, default OFF. Off, an approved card is left
// exactly as it is (not claimed, not failed) and the handoff says so; turning
// it on is Mimi's popup. Kill lever: set it to anything but "on".
//
// This is the ONLY file that may POST to Google Business Profile, and the only
// thing it POSTs is a new STANDARD local post. It never replies to a review,
// never edits or deletes a post, never touches the profile itself.
// lib/gbp-reviews.js stays GET-only (test/order2977_gbp_api_reviews_live.test.js).
'use strict';

const G = require('./gbp-reviews');

const FLAG = 'GBP_POST_ON_APPROVE';
// Mimi: "Keep posts short and to the point." Google allows 1500 characters; we
// hold the agent to 80 words and refuse anything past 900 characters.
const MAX_WORDS = 80;
const MAX_CHARS = 900;
const CTA_TYPES = new Set(['LEARN_MORE', 'BOOK', 'CALL']);
const OFF_WHY = `Google Business posting is off (${FLAG})`;

function postOn(env = process.env) { return String(env[FLAG] || '').trim().toLowerCase() === 'on'; }

const words = (t) => (String(t || '').match(/\S+/g) || []).length;
const norm = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

// The post as the model gave it, kept only if it is postable. null = no post.
function parseGbpPost(p) {
  if (!p || typeof p !== 'object' || !p.venue || !p.summary) return null;
  const keep = { venue: String(p.venue).trim().slice(0, 120), summary: String(p.summary).trim().slice(0, 2000) };
  if (p.keyword) keep.keyword = String(p.keyword).trim().slice(0, 120);
  if (p.keyword_source) keep.keyword_source = String(p.keyword_source).trim().slice(0, 200);
  if (p.link && /^https:\/\//i.test(String(p.link).trim())) keep.link = String(p.link).trim().slice(0, 500);
  const cta = String(p.cta || '').trim().toUpperCase();
  if (keep.link) keep.cta = CTA_TYPES.has(cta) && cta !== 'CALL' ? cta : 'LEARN_MORE';
  return keep;
}

// Why this post must not go out, or null. Checked again at hand-off time, on
// exactly the words that were approved.
function refuse(post) {
  if (!post || !post.summary) return 'the card has no post text';
  if (post.summary.length > MAX_CHARS) return `the post is ${post.summary.length} characters; the limit is ${MAX_CHARS}. Cut it and approve again`;
  if (words(post.summary) > MAX_WORDS) return `the post is ${words(post.summary)} words; the limit is ${MAX_WORDS}. Cut it and approve again`;
  if (/harding house/i.test(post.venue)) return 'The Harding House is closed; nothing is posted for it';
  return null;
}

// Which profile the post goes to: the one location whose title matches the
// venue. Zero or two-plus matches is a refusal, never a guess.
function pickLocation(venue, locs) {
  const want = norm(venue);
  const hits = locs.filter((l) => norm(l.title) === want);
  if (hits.length === 1) return { ok: true, loc: hits[0] };
  return { ok: false, why: hits.length ? `${hits.length} Google profiles are named "${venue}"` : `no Google profile is named "${venue}"` };
}

function body(post) {
  const b = { languageCode: 'en-US', topicType: 'STANDARD', summary: post.summary };
  if (post.link) b.callToAction = { actionType: post.cta || 'LEARN_MORE', url: post.link };
  return b;
}

// { ok, post_url, post_name, venue, location } | { skip, why } (never retried) | { ok:false, why } (retry).
async function createPost({ post, env = process.env, fetchImpl = globalThis.fetch, saKey, saToken }) {
  if (!postOn(env)) return { ok: false, off: true, why: OFF_WHY };
  const no = refuse(post);
  if (no) return { ok: false, skip: true, why: no };
  const sa = require('./google-sa');
  const key = saKey !== undefined ? saKey : sa.loadKey(env);
  // #3807: wait = Google was never asked; the Executioner counts it as waiting, not failed.
  if (!key) return { ok: false, wait: true, why: `no Brain service-account key on this machine (${sa.keyPath(env)})` };
  let token;
  try {
    token = saToken ? await saToken(G.SCOPE, G.SUBJECT) : await sa.accessToken({ key, scopes: [G.SCOPE], subject: G.SUBJECT, fetchImpl });
  } catch (e) { return { ok: false, why: `Google Business Profile could not be opened as ${G.SUBJECT}: ${e.message}` }; }
  const read = G.createClient({ token, fetchImpl });
  let target = null;
  try {
    const found = [];
    for (const acct of await read.accounts()) for (const loc of await read.locations(acct.name)) found.push({ account: acct.name, name: loc.name, title: loc.title });
    const pick = pickLocation(post.venue, found);
    if (!pick.ok) return { ok: false, skip: true, why: pick.why };
    target = pick.loc;
  } catch (e) { return { ok: false, why: `Google Business profiles could not be listed: ${e.message}` }; }
  const url = `${G.V4}${target.account}/${target.name}/localPosts`;
  const r = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body(post)) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const why = `Google refused the post: ${r.status} ${(j.error && (j.error.status || j.error.message)) || 'error'}`;
    // 400 = the post itself is wrong (retrying sends the same words); 401/403/5xx can clear.
    return r.status === 400 ? { ok: false, skip: true, why } : { ok: false, why };
  }
  return { ok: true, post_url: j.searchUrl || null, post_name: j.name || null, state: j.state || null, venue: target.title, location: target.name };
}

module.exports = { FLAG, OFF_WHY, MAX_WORDS, MAX_CHARS, postOn, parseGbpPost, refuse, pickLocation, body, createPost };
