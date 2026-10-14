// ORDER #1758: the seen-before memory. An agent never redrafts an item it
// already drafted.
//
// An agent opts in with agent.json "seen_before": {"key": [...], "source": [...]}.
// The model names each card's item in a "seen" object with those fields; the
// runner builds a key from the "key" fields (a field ending in "?" may be
// missing) and keeps the "source" fields to tell whether the item changed.
//
// Before a card is saved: an item already drafted (waiting on the Review tab,
// approved, or rejected) is skipped. A rejected item comes back only when its
// source changed (new review text, new event dates), and the card says so. A
// card whose item cannot be keyed is saved as before: the memory never hides a
// card it cannot match.
'use strict';

function norm(v) {
  let s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^(https?:\/\/|www\.|[a-z0-9-]+(\.[a-z0-9-]+)+\/)/.test(s)) s =s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  else s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  return s;
}

// The card's key, or null when a required field is missing.
function seenKey(spec, seen) {
  if (!spec || !Array.isArray(spec.key) || !seen || typeof seen !== 'object') return null;
  const parts = [];
  for (const f of spec.key) {
    const optional = f.endsWith('?');
    const name = optional ? f.slice(0, -1) : f;
    const v = norm(seen[name]);
    if (!v && !optional) return null;
    if (v) parts.push(`${name}=${v}`);
  }
  return parts.length ? parts.join('|') : null;
}

// What the item looked like when drafted, so a later run can tell it changed.
function seenSource(spec, seen) {
  const out = {};
  for (const f of (spec && spec.source) || []) {
    const v = seen && seen[f] != null ? String(seen[f]).trim().replace(/\s+/g, ' ').slice(0, 1000) : '';
    if (v) out[f] = v;
  }
  return out;
}

// The source fields that differ. A field unknown on either side is not a change.
function sourceChanges(before, now) {
  const b = before || {};
  return Object.keys(now || {}).filter((f) => b[f] && now[f] && norm(b[f]) !== norm(now[f]));
}

const label = (f) => f.replace(/_/g, ' ');

// The decision for one card, given every earlier card with the same key.
function judge(earlier, source) {
  if (!earlier.length) return { keep: true };
  const open = earlier.find((c) => c.status === 'draft' || c.status === 'ready');
  if (open) return { keep: false, why: open.status === 'ready' ? 'approved' : 'on the Review tab' };
  const last = earlier[0];
  const changed = sourceChanges(last.seen_source, source);
  if (!changed.length) return { keep: false, why: 'rejected, and its source has not changed' };
  return { keep: true, back: { rejected_at: last.decided_at, reason: last.reason, changed } };
}

function mmddyyyy(d) {
  if (!d) return 'an earlier day';
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric' }).replace(/\//g, '.');
}

// The note a returning card carries. Written by the Box, so it sits in an
// appended section and is never linted as the bot's words.
function backNote(back) {
  return `### Seen before\n\nThis item was drafted before and rejected on ${mmddyyyy(back.rejected_at)}${back.reason ? ` ("${back.reason}")` : ''}. `
    + `It is back because its source changed: ${back.changed.map(label).join(', ')}.`;
}

// The model is told the fields to name and what it already drafted, so it
// spends its cards on new items. The runner still enforces the memory.
function seenContract(spec) {
  const fields = spec.key.map((f) => (f.endsWith('?') ? `"${f.slice(0, -1)}" (when known)` : `"${f}"`));
  const src = (spec.source || []).map((f) => `"${f}"`);
  return `\nSEEN-BEFORE MEMORY: add to every card "seen": {${[...fields, ...src].join(', ')}} naming the one item the card is about, exactly as the source gives it. One card per item.`;
}

function alreadyList(rows, max = 40) {
  if (!rows.length) return null;
  return 'ALREADY DRAFTED (do not draft these again; a rejected one only if its source changed):\n'
    + rows.slice(0, max).map((r) => `- ${r.seen_key} (${r.status === 'ready' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'waiting for review'})`).join('\n');
}

module.exports = { norm, seenKey, seenSource, sourceChanges, judge, backNote, seenContract, alreadyList };
