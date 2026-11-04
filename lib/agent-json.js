// ORDER #2910: read the model's JSON answer even when it is slightly broken.
//
// Two real failures from the Box log (~/Library/Logs/ihg_marketing_agents.*):
//   convention-connector 10.26: Expected ':' after property name in JSON at position 10 (line 1 column 11)
//   scout 11.02:                Expected ',' or '}' after property value in JSON at position 10934 (line 1 column 10935)
// The first is a key with no colon. The second is a double quote inside a card
// body that the model did not escape (a quoted venue name, a review line): the
// string "ends" early and the next word is junk. Scout's limit is 6000 output
// tokens, roughly 20,000+ characters, so a break at character 10935 is mid-answer,
// not the length limit. A real cut-off is still handled: the last whole card is
// kept and the unfinished one is dropped, never saved half-written.
//
// parseModelJson(text) -> { json, repairs: [..] } or throws an Error whose
// .badJson is true and whose message is the parser's own words.
'use strict';

const MAX_FIXES = 400;

// The JSON text: code fences dropped, from the first "{" (or the first
// {"cards" when prose before it has a brace of its own) to the last "}".
function candidates(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const out = [];
  const b = s.lastIndexOf('}');
  const a = s.indexOf('{');
  if (a >= 0 && b > a) out.push(s.slice(a, b + 1));
  const m = /\{\s*"cards"/.exec(s);
  if (m && m.index !== a) out.push(b > m.index ? s.slice(m.index, b + 1) : s.slice(m.index));
  // A cut-off answer may have no closing brace at all.
  if (a >= 0 && !(b > a)) out.push(s.slice(a));
  return out;
}

function posOf(e) {
  const m = /position (\d+)/.exec(e && e.message || '');
  return m ? Number(m[1]) : -1;
}

function prevNonSpace(s, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(s[k])) k--;
  return k;
}

// Where the last whole card closed: a string-aware scan for a "}" that brings
// the depth back to the cards array. Returns the cut text, or null.
function cutToLastCard(s) {
  const stack = [];
  let inStr = false; let esc = false; let last = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') { stack.pop(); if (ch === '}' && stack.length === 2 && stack[1] === '[') last = i; }
  }
  return last > 0 ? s.slice(0, last + 1) + ']}' : null;
}

// A comma right before a closing "}" or "]", outside strings. (V8 gives no
// position for "[1,]", so this is a scan, not an error-position fix.)
function dropTrailingCommas(s) {
  let out = ''; let inStr = false; let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { out += ch; if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    if (ch === ',') { let k = i + 1; while (k < s.length && /\s/.test(s[k])) k++; if (s[k] === '}' || s[k] === ']') continue; }
    out += ch;
  }
  return out;
}

function tryRepair(src) {
  let s = src;
  const repairs = [];
  try { return { json: JSON.parse(s), repairs }; } catch (e) {
    const t = dropTrailingCommas(s);
    if (t !== s) { s = t; repairs.push('trailing comma'); }
  }
  for (let n = 0; n < MAX_FIXES; n++) {
    try { return { json: JSON.parse(s), repairs }; } catch (e) {
      const msg = e.message;
      const p = posOf(e);
      if (/Expected ':' after property name/.test(msg) && p >= 0) {
        s = s.slice(0, p) + ':' + s.slice(p); repairs.push('missing colon'); continue;
      }
      if (/Bad control character in string literal/.test(msg) && p >= 0) {
        const c = s[p]; const r = c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '';
        s = s.slice(0, p) + r + s.slice(p + 1); repairs.push('raw line break in a string'); continue;
      }
      if (/Expected ',' or '[}\]]' after (property value|array element)/.test(msg) && p >= 0) {
        const q = prevNonSpace(s, p);
        if (q > 0 && s[q] === '"' && s[q - 1] !== '\\') {
          s = s.slice(0, q) + '\\' + s.slice(q); repairs.push('unescaped quote'); continue;
        }
      }
      if (p >= 0 && (s[p] === '}' || s[p] === ']')) {
        const q = prevNonSpace(s, p);
        if (q >= 0 && s[q] === ',') { s = s.slice(0, q) + s.slice(q + 1); repairs.push('trailing comma'); continue; }
      }
      if (/Unterminated string|Unexpected end of JSON input|Expected .* after (property value|array element)/.test(msg) || p >= s.length - 2) {
        const cut = cutToLastCard(s);
        if (cut && cut !== s && !repairs.includes('cut off: unfinished card dropped')) {
          s = cut; repairs.push('cut off: unfinished card dropped'); continue;
        }
      }
      const err = new Error(msg);
      err.badJson = true;
      throw err;
    }
  }
  const err = new Error('the answer needed too many repairs');
  err.badJson = true;
  throw err;
}

function parseModelJson(text) {
  const list = candidates(text);
  if (!list.length) { const e = new Error('model answer had no JSON object'); e.badJson = true; throw e; }
  let first = null;
  for (const c of list) {
    try { return tryRepair(c); } catch (e) { if (!first) first = e; }
  }
  throw first;
}

module.exports = { parseModelJson, cutToLastCard };
