// ORDER #3734 (#3575 step 5, #3602 item 3): the claims-register guard.
// The register (07_Marketing_and_Brand/Claims_Register_<date>.md, built by
// #3575) is a set of markdown tables whose first cell is a row id (A4, B12,
// C3) and whose LAST cell is Mimi's mark. Only a row whose mark starts with
// TRUE is an allowed claim. Everything else (blank "____", FALSE, UNSURE,
// MISMATCH, "ACCURATE, reword") is cut. Read at run time by the file source
// (agent.json `"claims_register": true`), so a mark Mimi adds later flows in
// with no new order.
'use strict';

const GUARD = [
  'CLAIMS REGISTER GUARD (ORDER #3575 step 5, Mimi 11.18.2026). Any provenance or history claim in a draft',
  '("original", "built by", "first", "only", "largest", "oldest", "award-winning", a specific year or count)',
  'must trace to a row marked TRUE in the list below, or it is cut from the draft. A claim that is not listed',
  'is cut even if a source page says it: our own sites carry claims Mimi has not confirmed. Repeat an allowed',
  'claim no bigger than it is written here.',
  'The Bridge Building (ORDER #3605): 610 seated is across several floors and 1,200 guests is the whole building.',
  'Never pair 1,200 or 610 with one room or floor; word it "610 seated across our floors" or "up to 1,200 guests across the building".',
].join(' ');

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const plain = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

function allowedClaims(md) {
  const allowed = [];
  const notAllowed = [];
  for (const line of String(md || '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const c = cells(line);
    if (c.length < 4 || !/^[A-Z]\d+$/.test(c[0])) continue;
    const mark = plain(c[c.length - 1]);
    if (!/^TRUE\b/i.test(mark)) { notAllowed.push(c[0]); continue; }
    const src = (c[c.length - 2].match(/Mimi \d{2}\.\d{2}\.\d{4}/) || [])[0] || 'Mimi, register mark';
    allowed.push({ id: c[0], where: plain(c[1]), claim: plain(c[2]), source: src });
  }
  return { allowed, notAllowed };
}

function guardText(md, rel) {
  const { allowed, notAllowed } = allowedClaims(md);
  return [
    GUARD,
    '',
    `ALLOWED CLAIMS (rows marked TRUE in ${rel}, ${allowed.length}):`,
    ...allowed.map((r) => `- ${r.id} | ${r.where} | ${r.claim} | source: ${r.source}`),
    '',
    `NOT ALLOWED: ${notAllowed.length} rows are not marked TRUE (${notAllowed.join(', ')}); a claim matching one of them is cut until Mimi marks it TRUE.`,
  ].join('\n');
}

module.exports = { allowedClaims, guardText, GUARD };
