// ORDER #1703: no claim about an outside page without a quote that is really on it.
//
// Mimi 10.13.2026: "well we need to do better." Two failures on one day: #1668
// let the model invent a code expansion, and the 10.12 listings draft marked as
// "Verified" that Saint Elle's Knot page names three prior owners. It does not.
//
// The rule: a card (or a draft row) that says what an outside page says carries
// { claim, url, quote }. Before the card is saved, the Box fetches each cited
// URL once this run (the snapshot) and the quote must be literally in that
// page's text, whitespace-normalized. A claim that fails is rewritten as
// "UNVERIFIED: <claim>" and listed under "Not checked this run". The word
// "Verified" survives only on a line that carries a quote that passed.
'use strict';

const { pageFacts } = require('./agent-sources');

const UA = 'IHG-Brain-QuoteCheck/1.0 (+brain@infinityhospitality.net)';
const MIN_QUOTE = 12;          // a quote shorter than this proves nothing
const MAX_CLAIMS = 40;         // per card

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-', hellip: '...', bull: '•' };

// Whitespace-normalized, entities decoded, curly quotes and dashes made plain.
// Case is kept: a quote is a quote.
function norm(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m))
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteFound(quote, pageText) {
  const q = norm(quote);
  return q.length >= MIN_QUOTE && norm(pageText).includes(q);
}

// One fetch per URL per run. Returns { ok, status, text } or { ok:false, why }.
function snapshotter({ fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const seen = new Map();
  return async function snap(url) {
    if (seen.has(url)) return seen.get(url);
    let out;
    if (!/^https:\/\/[^/\s]+/i.test(String(url || ''))) out = { ok: false, why: 'no https URL given' };
    else {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetchImpl(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctl.signal });
        const body = await r.text();
        if (r.status !== 200) out = { ok: false, status: r.status, why: `page answered ${r.status}` };
        else out = { ok: true, status: 200, text: pageFacts(body).text };
      } catch (e) {
        out = { ok: false, why: e.name === 'AbortError' ? 'timed out' : e.message };
      } finally { clearTimeout(t); }
    }
    seen.set(url, out);
    return out;
  };
}

// claims: [{ claim, url, quote }]. Returns { passed, failed } where each failed
// row carries `why`. A claim with no quote or no URL fails without a fetch.
async function checkClaims(claims, snap) {
  const passed = [];
  const failed = [];
  for (const c of (Array.isArray(claims) ? claims : []).slice(0, MAX_CLAIMS)) {
    const row = { claim: String((c && c.claim) || '').trim(), url: String((c && c.url) || '').trim(), quote: String((c && c.quote) || '').trim() };
    if (!row.claim) continue;
    if (!row.quote) { failed.push({ ...row, why: 'no quote given' }); continue; }
    if (norm(row.quote).length < MIN_QUOTE) { failed.push({ ...row, why: `quote under ${MIN_QUOTE} characters` }); continue; }
    if (!row.url) { failed.push({ ...row, why: 'no URL given' }); continue; }
    const s = await snap(row.url);
    if (!s.ok) { failed.push({ ...row, why: `page not read this run (${s.why})` }); continue; }
    if (quoteFound(row.quote, s.text)) passed.push(row);
    else failed.push({ ...row, why: 'quote not found on the page fetched this run' });
  }
  return { passed, failed };
}

// "unverified" has no word boundary before "verified", so it never matches.
const VERIFIED = /\bverified\b/i;
const VERIFIED_ALL = /\bverified\b/gi;

// Applies the result to the model's own words: every failed claim's sentence
// becomes "UNVERIFIED: <claim>", and "Verified" is struck from any line that
// does not carry a passed quote.
function applyGate(body, { passed, failed }) {
  let b = String(body || '');
  for (const f of failed) if (f.claim && b.includes(f.claim)) b = b.split(f.claim).join(`UNVERIFIED: ${f.claim}`);
  const ok = passed.map((p) => norm(p.quote));
  const okClaims = passed.map((p) => p.claim);
  b = b.split('\n').map((line) => {
    if (!VERIFIED.test(line)) return line;
    const n = norm(line);
    if (ok.some((q) => n.includes(q)) || okClaims.some((c) => line.includes(c))) return line;
    return line.replace(VERIFIED_ALL, 'UNVERIFIED');
  }).join('\n');
  return b;
}

function gateSections({ passed, failed }, when) {
  const parts = [];
  if (passed.length) parts.push(`### Quotes checked this run (${when})\n\n` + passed.map((p) => `- ${p.claim}: "${p.quote}" (${p.url})`).join('\n'));
  if (failed.length) parts.push('### Not checked this run\n\n' + failed.map((f) => `- UNVERIFIED: ${f.claim}${f.url ? ` (${f.url})` : ''}: ${f.why}`).join('\n'));
  return parts.join('\n\n');
}

module.exports = { norm, quoteFound, snapshotter, checkClaims, applyGate, gateSections, MIN_QUOTE, UA };
