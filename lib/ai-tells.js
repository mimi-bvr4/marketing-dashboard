// ORDER #1015 / AI_TELLS_BAN_LIST.md (10.09.2026): the lint every agent draft and
// the Review tab's "Check text" button run. Pure: text in, hits out.
//
// FAILS (a draft cannot be marked ready): any em dash, any spaced en dash.
// FLAGS (shown on the card): the banned phrases of tells 2-7, 17 and 19, more
// than one "stunning/beautiful/perfect", Title Case H2/H3, too much bold, a
// hard capacity with no range or "depending on" condition (house rule).
'use strict';

const PHRASES = [
  // 2
  'in conclusion', 'final thoughts',
  // 3
  'not only', "it's not just", 'this isn\'t just',
  // 4
  "in today's fast-paced world", 'in the ever-evolving landscape', 'when it comes to',
  'planning a wedding can be overwhelming',
  // 5
  'in this article', "we'll explore", "let's dive in", "let's take a look", 'without further ado', 'read on to learn',
  // 6
  "it's important to note", "it's worth noting", 'keep in mind that',
  // 7
  'delve', 'tapestry', 'testament', 'realm', 'embark', 'unlock', 'unleash', 'elevate', 'seamless',
  'robust', 'leverage', 'foster', 'myriad', 'plethora', 'pivotal', 'game-changer', 'game changer', 'nestled',
  'boasts', 'vibrant', 'bustling', 'breathtaking', 'in the heart of', 'look no further', "whether you're",
  // 17
  'i hope this helps', 'certainly!', 'great question', 'as an ai', "here's a revised version", '[insert',
  // 19 (paragraph openers, matched at line start below)
];
const OPENERS = ['additionally', 'furthermore', 'moreover', 'overall', 'ultimately'];
const GUSH = ['stunning', 'beautiful', 'perfect'];

function lineOf(text, index) { return text.slice(0, index).split('\n').length; }

// Quoted text (a bot quoting the ban list, a review, a page it measured) is not
// the bot's own words: phrase, opener and gush checks skip it. Dashes are
// checked everywhere.
function unquoted(t) {
  return t.replace(/"[^"\n]{0,400}"|\u201c[^\u201d\n]{0,400}\u201d|`[^`\n]{0,400}`/g, (m) => ' '.repeat(m.length));
}

// The Box's last resort when a rewrite still has a dash: a comma, counted on the card.
function replaceDashes(t) {
  let n = 0;
  const out = String(t || '')
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, (m, a, b) => { n++; return `${a} to ${b}`; })
    .replace(/\s*\u2014\s*/g, () => { n++; return ', '; })
    .replace(/ \u2013 /g, () => { n++; return ', '; });
  return { text: out, replaced: n };
}

function lint(input) {
  const text = String(input || '');
  const lower = unquoted(text).toLowerCase();
  const fails = [];
  const flags = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\u2014') fails.push({ rule: 'em dash', line: lineOf(text, i) });
    else if (c === '\u2013' && text[i - 1] === ' ' && text[i + 1] === ' ') fails.push({ rule: 'spaced en dash', line: lineOf(text, i) });
  }
  for (const p of PHRASES) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(p, from);
      if (at < 0) break;
      const before = at === 0 ? ' ' : lower[at - 1];
      if (!/[a-z]/.test(before)) flags.push({ rule: 'banned phrase', phrase: p, line: lineOf(text, at) });
      from = at + p.length;
    }
  }
  unquoted(text).split('\n').forEach((ln, i) => {
    const w = ln.trim().replace(/^[#>*\-\s]+/, '').split(/[\s,]+/)[0] || '';
    if (OPENERS.includes(w.toLowerCase())) flags.push({ rule: 'filler opener', phrase: w, line: i + 1 });
    const h = ln.match(/^#{2,3}\s+(.+)$/);
    if (h) {
      const words = h[1].split(/\s+/).filter((x) => /^[A-Za-z]{4,}$/.test(x));
      if (words.length >= 3 && words.every((x) => /^[A-Z]/.test(x))) flags.push({ rule: 'title case heading', phrase: h[1], line: i + 1 });
    }
  });
  for (const g of GUSH) {
    const n = (lower.match(new RegExp('\\b' + g + '\\b', 'g')) || []).length;
    if (n > 1) flags.push({ rule: 'gush repeated', phrase: g, count: n });
  }
  const words = (text.match(/\S+/g) || []).length;
  const bold = (text.match(/\*\*[^*]+\*\*/g) || []).length;
  if (words && bold > Math.max(1, Math.floor(words / 150))) flags.push({ rule: 'too much bold', count: bold });
  const capRe = /\b(holds|seats|accommodates|capacity(?: of)?:?|max(?:imum)?(?: of)?)\s*(up to\s*)?(\d{2,4})\b/gi;
  let m;
  while ((m = capRe.exec(text))) {
    const near = lower.slice(Math.max(0, m.index - 80), m.index) + ' ' + lower.slice(m.index + m[0].length, m.index + m[0].length + 80);
    const ranged = new RegExp('^\\s*(to|-|\u2013)\\s*\\d').test(lower.slice(m.index + m[0].length));
    if (!ranged && !/depending|depends|floor plan|range/.test(near)) {
      flags.push({ rule: 'hard capacity', phrase: m[0], line: lineOf(text, m.index) });
    }
  }
  return { clean: fails.length === 0 && flags.length === 0, fails, flags };
}

function summary(r) {
  if (r.clean) return 'AI-tells: clean';
  const parts = [];
  if (r.fails.length) parts.push(`${r.fails.length} dash${r.fails.length === 1 ? '' : 'es'} (blocks ready)`);
  if (r.flags.length) parts.push(`${r.flags.length} flag${r.flags.length === 1 ? '' : 's'}`);
  return 'AI-tells: ' + parts.join(', ');
}

module.exports = { lint, summary, unquoted, replaceDashes, PHRASES, OPENERS };
