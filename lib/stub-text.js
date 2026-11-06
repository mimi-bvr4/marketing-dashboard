// ORDER #3011 (11.05.2026): a draft whose words are empty, only "...", or a
// placeholder is a stub, never a card. Convention Charles's first 4-year run
// saved a card whose body was only "...", and the Copywriter passed it as
// "Ready to go out". One check, used by the runner (an empty card becomes a
// failed-run card), the Copywriter pre-pass and the AI Tell Detective (both
// answer "Needs changes" on a stub). Pure: text in, reason or null out.
//
// ROLLBACK: CARD_MIN_CHARS = 0 turns the length floor off; the empty / "..." /
// placeholder checks are the order's acceptance and stay.
'use strict';

// A real card body has at least this many letters and digits. Kept low on
// purpose: a one-line card ("Nothing new this week.") is a real answer; "N/A",
// "..." and "" are not.
const CARD_MIN_CHARS = 3;

const PLACEHOLDER = /^\s*(\[?\s*(tbd|todo|placeholder|lorem ipsum|content here|body here|insert[^\]]*|same as (above|before)|unchanged|see above|\(?truncated\)?|\(?omitted\)?)\s*\]?)\s*[.!]*\s*$/i;

// The words with markdown furniture taken out: headings, bullets, table rules,
// bold marks, link targets.
function words(text) {
  return String(text == null ? '' : text)
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/[#>*_`|\-=:\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// null when the text is a real draft; otherwise one plain sentence saying why not.
function stubReason(text, { min = CARD_MIN_CHARS } = {}) {
  const w = words(text);
  if (!w) return 'the text is empty';
  if (/^[.\s…]+$/.test(w)) return `the text is only "${w.slice(0, 20)}"`;
  if (PLACEHOLDER.test(w)) return `the text is only a placeholder ("${w.slice(0, 40)}")`;
  const n = (w.match(/[A-Za-z0-9]/g) || []).length;
  if (min > 0 && n < min) return `the text has ${n} letters and digits, under the ${min} a real draft has`;
  return null;
}

module.exports = { stubReason, CARD_MIN_CHARS };
