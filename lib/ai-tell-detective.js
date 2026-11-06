// ORDER #3008 (Mimi 11.05.2026): the AI Tell Detective. Paste any text, get a
// verdict, every hit with its line, its rule number from AI_TELLS_BAN_LIST.md,
// why it reads as AI, a suggested fix, and a clean rewrite that ONLY removes
// tells (meaning, facts and names untouched).
//
// ONE SOURCE OF TRUTH: the hits ARE lib/ai-tells.js lint() hits, each labelled
// with its rule number. The Detective never adds a check the lint does not
// make, so the lint, the Copywriter and the Detective cannot disagree. Pure:
// text in, report out. Nothing stored, nothing sent, no model call.
//
// SWITCH: AI_TELL_DETECTIVE, default OFF (see on()). While it is off the
// Review page's "Check text" box keeps the plain lint it has today.
'use strict';

const { lint, unquoted, replaceDashes, triples } = require('./ai-tells');

// The date of the last change to AI_TELLS_BAN_LIST.md (its CHANGELOG). Bump it
// with every approved ADDED tell; test/order3008 checks it against the list.
const LIST_UPDATED = '10.09.2026';

const RULES = {
  1: 'Em dashes', 2: '"Conclusion" headers', 3: 'The contrast flourish', 4: 'Throat-clearing openers',
  5: 'Signposting filler', 6: '"It\'s important to note"', 7: 'The AI vocabulary', 8: 'Overstated importance',
  9: 'Trailing "-ing" importance clauses', 10: 'Commercial-voice gush', 11: 'Rule-of-three by reflex',
  12: 'Bold-everything and emoji bullets', 13: 'Title Case headings', 14: 'Generic, interchangeable copy',
  15: 'Hedging and padding', 16: 'Fake balance / faux FAQ', 17: 'Chatbot residue', 18: 'Same-shape sentences',
  19: 'Vague "This" and filler openers', 20: 'Invented specifics', house: 'House rule: hard capacities',
};

const WHY = {
  1: 'Readers now treat the em dash as the single loudest sign of AI writing.',
  2: 'PRSA found "conclusion" closers had the worst link to engagement.',
  3: 'The "not X, but Y" flourish is a stock AI rhythm; it sounds staged.',
  4: 'A throat-clearing opener says nothing and delays the point.',
  5: 'Signposting narrates the text instead of saying the thing.',
  6: '"It\'s important to note" is padding; if it matters, just say it.',
  7: 'This word is far more common in AI drafts than in human writing.',
  10: 'Repeated superlatives read as commercial gush, not as a fact.',
  11: 'Three adjectives in a row is the reflex rhythm of AI copy.',
  12: 'Bold on everything is a chatbot formatting habit.',
  13: 'Title Case on every heading is a template habit; we use sentence case.',
  17: 'Chatbot residue: words the model wrote to the person, not to the reader.',
  19: 'A filler opener ("Additionally", "Moreover") is a stock AI transition.',
  house: 'A hard capacity with no range or condition promises a number we may not hold.',
};

// Which rule each lint phrase belongs to (lib/ai-tells.js PHRASES groups).
const PHRASE_RULE = {
  'in conclusion': 2, 'final thoughts': 2,
  'not only': 3, "it's not just": 3, "this isn't just": 3,
  "in today's fast-paced world": 4, 'in the ever-evolving landscape': 4, 'when it comes to': 4, 'planning a wedding can be overwhelming': 4,
  'in this article': 5, "we'll explore": 5, "let's dive in": 5, "let's take a look": 5, 'without further ado': 5, 'read on to learn': 5,
  "it's important to note": 6, "it's worth noting": 6, 'keep in mind that': 6,
  'i hope this helps': 17, 'certainly!': 17, 'great question': 17, 'as an ai': 17, "here's a revised version": 17, '[insert': 17,
};

// Plain swaps for tell 7. Each keeps the meaning; none adds a fact.
const SWAP = {
  'delve into': 'look at', 'delves into': 'looks at', 'delving into': 'looking at', delve: 'look', delves: 'looks',
  tapestry: 'mix', testament: 'proof', realm: 'world', embark: 'start', embarks: 'starts', unlock: 'open', unlocks: 'opens',
  unleash: 'bring out', elevate: 'lift', elevates: 'lifts', seamlessly: 'smoothly', seamless: 'smooth', robust: 'strong',
  leverage: 'use', leverages: 'uses', foster: 'build', fosters: 'builds', myriad: 'many', 'a plethora of': 'plenty of',
  plethora: 'plenty', pivotal: 'key', 'game-changer': 'big change', 'game changer': 'big change', nestled: 'set',
  boasts: 'has', vibrant: 'lively', bustling: 'busy', breathtaking: 'striking', 'in the heart of': 'in',
};
const VOCAB = ['delve', 'tapestry', 'testament', 'realm', 'embark', 'unlock', 'unleash', 'elevate', 'seamless', 'robust',
  'leverage', 'foster', 'myriad', 'plethora', 'pivotal', 'game-changer', 'game changer', 'nestled', 'boasts', 'vibrant',
  'bustling', 'breathtaking', 'in the heart of', 'look no further', "whether you're"];
for (const v of VOCAB) PHRASE_RULE[v] = 7;

// Phrases the rewrite deletes outright (with a trailing comma or colon).
const CUT = ["in today's fast-paced world", 'in conclusion', 'final thoughts', 'in this article', "we'll explore",
  "let's dive in", "let's take a look", 'without further ado', 'read on to learn more', 'read on to learn',
  "it's important to note that", "it's important to note", "it's worth noting that", "it's worth noting",
  'keep in mind that', 'i hope this helps', 'certainly!', 'great question', 'as an ai', "here's a revised version",
  'look no further'];

const HUMAN = 'needs a person: no safe mechanical fix';

function ruleOf(hit) {
  if (hit.rule === 'em dash' || hit.rule === 'spaced en dash') return 1;
  if (hit.rule === 'banned phrase') return PHRASE_RULE[hit.phrase] || 7;
  if (hit.rule === 'filler opener') return 19;
  if (hit.rule === 'title case heading') return 13;
  if (hit.rule === 'gush repeated') return 10;
  if (hit.rule === 'too much bold') return 12;
  if (hit.rule === 'rule of three') return 11;
  if (hit.rule === 'hard capacity') return 'house';
  return null;
}

function fixFor(hit, rule) {
  const p = hit.phrase || '';
  if (rule === 1) return 'Use a period, comma, colon or parentheses; a range becomes "to".';
  if (rule === 7 && SWAP[p]) return `Say "${SWAP[p]}" instead of "${p}".`;
  if (rule === 7) return `Cut "${p}" and say the specific thing.`;
  if (rule === 3) return 'Say the thing directly, without the "not X, but Y" setup.';
  if (CUT.includes(p)) return `Delete "${p}" and start with the point.`;
  if (rule === 4) return 'Delete the opener and start with the point.';
  if (rule === 10) return `Keep one "${p}" at most; name the space, the view or the moment instead.`;
  if (rule === 11) return 'Keep the one adjective that is true and specific; drop the rest.';
  if (rule === 12) return 'Bold only a true label (e.g. "Capacity:").';
  if (rule === 13) return 'Use sentence case: capitalize the first word and names only.';
  if (rule === 19) return `Drop "${p}" and let the sentence stand.`;
  if (rule === 'house') return 'Give a range or add "depending on the floor plan".';
  return 'Rewrite it plainly.';
}

function re(phrase) {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = /[a-z]$/i.test(phrase) ? '\\b' : '';
  return new RegExp('(^|[^A-Za-z])(' + esc + ')' + tail, 'gi');
}

function matchCase(src, rep) {
  return /^[A-Z]/.test(src) ? rep.charAt(0).toUpperCase() + rep.slice(1) : rep;
}

// Rewrite only the text outside quotes (a quote is somebody else's words).
function eachUnquoted(text, fn) {
  const mask = unquoted(text);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const quoted = mask[i] === ' ' && text[i] !== ' ';
    let j = i;
    while (j < text.length && (mask[j] === ' ' && text[j] !== ' ') === quoted) j++;
    const part = text.slice(i, j);
    out += quoted ? part : fn(part);
    i = j;
  }
  return out;
}

function tidy(s) {
  return s
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/([,;:])\s*([,.;:])/g, '$2')
    .replace(/(^|[.!?]\s+|\n\s*)[,;:]\s*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(^|[.!?]["”]?\s+|\n[#>*\-\s]*)([a-z])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

function rewrite(input) {
  let text = replaceDashes(String(input || '')).text;
  text = text.replace(/—/g, ',');
  text = eachUnquoted(text, (part) => {
    let s = part;
    for (const c of CUT) s = s.replace(re(c), (m, pre) => pre);
    s = s.replace(/(^|[^A-Za-z])when it comes to\b/gi, (m, pre, off) => pre + matchCase(m.slice(pre.length), 'for'));
    for (const [from, to] of Object.entries(SWAP).sort((a, b) => b[0].length - a[0].length)) {
      s = s.replace(re(from), (m, pre, word) => pre + matchCase(word, to));
    }
    // 19: the paragraph-opening filler word goes, the sentence stays.
    s = s.replace(/(^|\n)([#>*\-\s]*)(additionally|furthermore|moreover|overall|ultimately),?\s+/gi, '$1$2');
    // 11: "elegant, timeless, and unforgettable" -> "elegant and timeless".
    s = s.replace(/\b([A-Za-z][A-Za-z-]+), ([A-Za-z][A-Za-z-]+),? and ([A-Za-z][A-Za-z-]+)\b/g,
      (m, a, b) => (triples(m).length ? `${a} and ${b}` : m));
    // 12: bold goes; 13: headings to sentence case.
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/^(#{2,3}\s+)(.+)$/gm, (m, h, t) => {
      const words = t.split(/\s+/).filter((x) => /^[A-Za-z]{4,}$/.test(x));
      if (!(words.length >= 3 && words.every((x) => /^[A-Z]/.test(x)))) return m;
      return h + t.split(/(\s+)/).map((w, i) => (i === 0 || /^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase())).join('');
    });
    return s;
  });
  return tidy(text);
}

function on(env = process.env) {
  return /^(1|on|true|yes)$/i.test(String(env.AI_TELL_DETECTIVE || ''));
}

function check(input) {
  const text = String(input || '');
  const r = lint(text);
  const hits = [...r.fails, ...r.flags].map((h) => {
    const rule = ruleOf(h);
    return { line: h.line || null, rule_no: rule, rule: RULES[rule] || h.rule, phrase: h.phrase || null,
      count: h.count || null, why: WHY[rule] || 'On the AI tells ban list.', fix: fixFor(h, rule),
      blocks_ready: r.fails.includes(h) };
  }).sort((a, b) => (a.line || 0) - (b.line || 0));
  const clean = r.clean ? text : rewrite(text);
  const after = lint(clean);
  const left = [...after.fails, ...after.flags].map((h) => ({ rule_no: ruleOf(h), phrase: h.phrase || null, line: h.line || null, note: HUMAN }));
  return {
    verdict: hits.length ? `Sounds like AI (${hits.length})` : 'Sounds human',
    count: hits.length,
    hits,
    rewrite: clean,
    rewrite_left: left,
    list_updated: LIST_UPDATED,
    footer: `Checked against IHG's AI-tell list (updated ${LIST_UPDATED}).`,
  };
}

module.exports = { check, rewrite, ruleOf, on, RULES, LIST_UPDATED };
