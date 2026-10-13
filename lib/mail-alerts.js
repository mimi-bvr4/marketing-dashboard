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
const BODY_CHARS = 8000;

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

// The readable text of a Gmail "full" message: text/plain if there is one, else stripped HTML.
function bodyText(payload) {
  const parts = [];
  (function walk(p) { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); })(payload);
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body && p.body.data);
  if (plain) return decode(plain.body.data).replace(/\r/g, '').trim();
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body && p.body.data);
  return html ? strip(decode(html.body.data)) : '';
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
    return { id, from: header(m.payload, 'From'), subject: header(m.payload, 'Subject'), date: header(m.payload, 'Date'),
      text: t.length > BODY_CHARS ? t.slice(0, BODY_CHARS) + '\n[truncated]' : t };
  }
  return { find, read };
}

module.exports = { searchQuery, bodyText, header, strip, createClient, SCOPE, BODY_CHARS };
