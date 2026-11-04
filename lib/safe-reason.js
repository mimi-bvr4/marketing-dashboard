// ORDER #2910: a short, secret-free reason for the Producer's board and the
// 06:00 log line. A source's "why" or a run's error can carry a URL with a key
// in it, an email address or a token; none of that may reach a board line, a
// card or a log. Links become their host name, emails become "(email)", and
// anything shaped like a key becomes "(hidden)".
'use strict';

function safeReason(s, max = 160) {
  let t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/https?:\/\/[^\s)"'<>]+/gi, (u) => {
    try { return new URL(u).hostname; } catch (e) { return '(link)'; }
  });
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '(email)');
  t = t.replace(/\b(bearer|authorization|token|access_token|refresh_token|api[_-]?key|apikey|secret|password|key)(\s*[:=]\s*|\s+)(?=[A-Za-z0-9_\-./+=]{16,})[A-Za-z0-9_\-./+=]+/gi, '$1 (hidden)');
  t = t.replace(/\b(sk-[A-Za-z0-9_-]{8,}|ya29\.[\w.-]+|xox[abprs]-[\w-]+|AIza[\w-]{20,}|gh[pousr]_\w{20,}|pat[\w-]*\.[\w.-]{20,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, '(hidden)');
  t = t.replace(/[A-Za-z0-9_\-+/=]{32,}/g, '(hidden)');
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

module.exports = { safeReason };
