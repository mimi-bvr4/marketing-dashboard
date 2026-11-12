// ORDER #1705: the press-request emails PR Patty reads (Qwoted, HARO, Be
// Inspired PR and the like), from the brain@ inbox. Read-only: gmail.readonly,
// GET calls only. Nothing here can send, label, archive or delete a message.
//
// How the mail gets to brain@: Katherine's own accounts on those services
// (pitches go out under her name) with a Gmail filter forwarding the alert
// emails to brain@. Patty never signs in to any of those sites.
'use strict';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
// ORDER #3276: this was 8000, which cut a 28,645-character HARO edition
// partway through request 6 of 20. The ceiling is now far above any edition
// seen, and a cut is never silent: the text says how much was read and why.
const BODY_CHARS = 200000;

// Gmail search: anything in the last N days that mentions one of the services.
function searchQuery({ match, days }) {
  const terms = match.map((m) => (/\s/.test(m) ? `"${m}"` : m));
  return `newer_than:${days}d {${terms.join(' ')}}`;
}

const decode = (data) => Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const strip = (html) => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<a [^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
  .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// The readable text of a Gmail "full" message: every text/plain part in order if
// there is one, else every text/html part stripped. (ORDER #3276: all parts, not
// only the first, so a message split across parts is read whole.)
function bodyText(payload) {
  const parts = [];
  (function walk(p) { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); })(payload);
  const plain = parts.filter((p) => p.mimeType === 'text/plain' && p.body && p.body.data);
  if (plain.length) return plain.map((p) => decode(p.body.data).replace(/\r/g, '').trim()).join('\n\n');
  const html = parts.filter((p) => p.mimeType === 'text/html' && p.body && p.body.data);
  return html.map((p) => strip(decode(p.body.data))).join('\n\n');
}

// ORDER #3276: how many numbered requests an email holds and how many of them
// are in the text in full, measured by code so the card never guesses. HARO
// lists an index ("13) Aesthetic Christmas Tree Decor (Yahoo") and then each
// request in full ("13) Summary: ..." with a "Query:" block). Returns null when
// the email is not shaped that way (Qwoted, Be Inspired PR): no claim is made.
function requestCoverage(text, { cut = false } = {}) {
  const heads = [...String(text || '').matchAll(/^[ \t]*(\d{1,3})\)[ \t]+(.*)$/gm)]
    .map((m) => ({ n: Number(m[1]), full: /^Summary:/i.test(m[2]), at: m.index }));
  const index = [...new Set(heads.filter((h) => !h.full).map((h) => h.n))];
  const fulls = heads.filter((h) => h.full);
  if (!fulls.length) return null;
  const total = Math.max(index.length ? Math.max(...index) : 0, ...fulls.map((h) => h.n));
  const read = new Set();
  fulls.forEach((h, i) => {
    const seg = text.slice(h.at, i + 1 < fulls.length ? fulls[i + 1].at : text.length);
    const last = i + 1 === fulls.length;
    if (/^[ \t]*Query:/im.test(seg) && !(last && cut)) read.add(h.n);
  });
  const missing = [];
  for (let n = 1; n <= total; n++) if (!read.has(n)) missing.push(n);
  return { total, read: read.size, missing };
}

const ranges = (ns) => ns.reduce((a, n) => { const r = a[a.length - 1]; if (r && n === r[1] + 1) r[1] = n; else a.push([n, n]); return a; }, [])
  .map(([a, b]) => (a === b ? `${a}` : `${a} to ${b}`)).join(', ');

// The one line the card copies: "Read in full: 20 of 20", or what was not read and why.
function coverageLine(cov, { cut = false, chars = 0 } = {}) {
  const why = cut ? ` Reason: the email is ${chars} characters and only the first ${BODY_CHARS} were read.` : '';
  if (!cov) return cut ? `Read in part.${why}` : null;
  if (!cov.missing.length) return `Requests in this email: ${cov.total}. Read in full: ${cov.read} of ${cov.total}.`;
  return `Requests in this email: ${cov.total}. Read in full: ${cov.read} of ${cov.total}. NOT read in full: ${ranges(cov.missing)}.`
    + (why || ' Reason: those requests are missing from the email text or have no Query block.');
}

function header(payload, name) {
  const h = ((payload && payload.headers) || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function createClient({ token, fetchImpl = globalThis.fetch }) {
  const h = { Authorization: `Bearer ${token}` };
  async function get(url) {
    const r = await fetchImpl(url, { headers: h });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || `Gmail answered ${r.status}`);
    return j;
  }
  async function find(q, max) {
    const j = await get(`${API}/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
    return (j.messages || []).map((m) => m.id);
  }
  async function read(id) {
    const m = await get(`${API}/messages/${encodeURIComponent(id)}?format=full`);
    const t = bodyText(m.payload);
    const cut = t.length > BODY_CHARS;
    const text = cut ? t.slice(0, BODY_CHARS) + `\n[CUT HERE: the email is ${t.length} characters; only the first ${BODY_CHARS} were read]` : t;
    const coverage = requestCoverage(cut ? t.slice(0, BODY_CHARS) : t, { cut });
    return { id, from: header(m.payload, 'From'), subject: header(m.payload, 'Subject'), date: header(m.payload, 'Date'),
      text, cut, chars: t.length, coverage, coverageLine: coverageLine(coverage, { cut, chars: t.length }) };
  }
  return { find, read };
}

module.exports = { searchQuery, bodyText, header, strip, createClient, requestCoverage, coverageLine, SCOPE, BODY_CHARS };
