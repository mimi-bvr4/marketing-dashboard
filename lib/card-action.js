// ORDER #3797 (Mimi 11.24.2026, after working with Katherine): marketing agent
// cards are ACTIONS, not information. This is the one place the Review page
// gets two things for every card:
//
//   actionLine(card)  the ONE plain line the card leads with, saying what
//                     Approve will do ("Save a 1,000-word blog post ... to TBB
//                     as an unpublished WordPress draft."). It is built from
//                     the same kindOf() as the "Approve will:" line (#3570),
//                     so the two can never disagree about what Approve does.
//                     A card with nothing to approve (a report) gets
//                     info_only: true, and its line says so.
//
//   tellsDetail(card) every "reads like AI" hit, with WHERE (which part of the
//                     card, the heading it sits under, the paragraph number)
//                     and WHAT (the exact words) and a suggested replacement.
//                     Never a bare count. The hits ARE lib/ai-tells.js lint()
//                     hits and the fixes ARE the AI Tell Detective's fixFor(),
//                     so the badge, the Detective and this list cannot disagree.
//
// Pure: card in, words out. It changes nothing Approve does and sends nothing.
'use strict';

const { lint, replaceDashes } = require('./ai-tells');
const { kindOf, approveWill } = require('./approve-will');
const { ruleOf, fixFor } = require('./ai-tell-detective');
const { modelText } = require('./agent-runner');

const NO_OWNER = 'No salesperson set yet';

function words(t) { return (String(t || '').match(/\S+/g) || []).length; }
function n(x) { return Number(x).toLocaleString('en-US'); }
function q(t, max = 80) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3).trimEnd() + '...' : s;
}

// The first line of text under a "### <name>" heading, or ''.
function section(body, name) {
  const lines = String(body || '').split('\n');
  const at = lines.findIndex((l) => new RegExp(`^#{2,4}\\s*${name}\\s*$`, 'i').test(l.trim()));
  if (at < 0) return '';
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^#{1,6}\s/.test(l)) return '';
    if (l) return l;
  }
  return '';
}
// "the words", once, whether or not the card already quoted them.
function quoted(t) { return `"${q(String(t).replace(/^["“]+|["”]+$/g, ''), 80)}"`; }

// { line, kind, info_only } for any card. The line is a sentence a person can
// read once and know what pressing Approve does.
function actionLine(card) {
  const kind = kindOf(card);
  const p = (card && card.payload) || {};
  const title = q(card && card.title, 70);
  let line;
  if (kind === 'post') {
    const w = words(p.post.content_md);
    line = `Save a ${w ? n(w) + '-word ' : ''}blog post${p.post.title ? ` "${q(p.post.title, 70)}"` : ''} to ${p.post.site || 'the site'} as an unpublished WordPress draft.`;
  } else if (kind === 'pin') {
    line = `Queue the pin${p.pin.title ? ` "${q(p.pin.title, 70)}"` : ''} for ${p.pin.board ? `the ${p.pin.board} board` : 'Pinterest'} on the Box's next run (a sandbox pin while our Pinterest app is on Trial).`;
  } else if (kind === 'sales') {
    const co = p.sales.company ? q(p.sales.company, 60) : 'this lead';
    if (card.mary) line = `Send ${co} to Mary Topp's Sales Hand-off desk to pick a salesperson.`;
    else if (card.sales_owner === NO_OWNER) line = `Keep ${co} in Ready until a salesperson is set.`;
    else line = `Make one HubSpot task for ${card.sales_owner || 'Cameron Creasy'} to email ${co}.`;
  } else if (kind === 'gbp_post') {
    // #3799 (Mimi 11.24.2026): the exact words she asked for.
    line = `Post this to ${p.gbp_post.venue} Google Business Profile.`;
  } else if (kind === 'topics') {
    const k = Array.isArray(p.topics) ? p.topics.length : 0;
    line = `File ${k} blog topic idea${k === 1 ? '' : 's'}; send each one to Bloggy Bob with its own button.`;
  } else if (kind === 'tell') {
    line = `Record your verdict on the proposed AI tell "${title}". The ban list does not change.`;
  } else if (kind === 'fix') {
    // #3808: the card's own title is the action; the old and new words follow it.
    const was = section(card && card.body, 'Now says');
    const now = section(card && card.body, 'Change to');
    line = `${q(card.title, 120).replace(/[.\s]+$/, '')}${was && now ? `: change ${quoted(was)} to ${quoted(now)}` : ''}. A person makes the change; the Box edits no listing.`;
  } else if (kind === 'report') {
    line = `Nothing to approve: "${title}" is information only. Got it clears it.`;
  } else {
    line = `Mark "${title}" ready for you to use. Nothing is posted or sent.`;
  }
  return { line, kind, info_only: kind === 'report' };
}

// The parts of a card a person reads, in order, each with the name the page
// uses for it. Line numbers from lint() are counted within one part.
function partsOf(card) {
  const p = (card && card.payload) || {};
  const parts = [{ name: 'Title', text: String((card && card.title) || '') }];
  parts.push({ name: 'Card text', text: modelText(card && card.body) });
  if (p.post && p.post.content_md) parts.push({ name: 'Blog post', text: String(p.post.content_md) });
  if (p.pin && p.pin.description) parts.push({ name: 'Pin description', text: String(p.pin.description) });
  if (p.sales && p.sales.email) parts.push({ name: 'Sales email', text: String(p.sales.email) });
  if (p.gbp_post && p.gbp_post.summary) parts.push({ name: 'Google post', text: String(p.gbp_post.summary) });
  return parts;
}

// "under "Heading", paragraph 3" for a 1-based line within a part. Paragraphs
// are blocks between blank lines; headings are not counted as paragraphs.
function locate(text, line) {
  const lines = String(text).split('\n');
  let heading = null;
  let para = 0;
  let inPara = false;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const l = lines[i].trim();
    const h = l.match(/^#{1,6}\s+(.+)$/);
    if (h) { heading = h[1].trim(); para = 0; inPara = false; if (i === line - 1) return { heading, para: 0 }; continue; }
    if (!l) { inPara = false; continue; }
    if (!inPara) { para++; inPara = true; }
  }
  return { heading, para };
}

function whereOf(part, text, line) {
  if (part.name === 'Title') return 'Title';
  if (!line) return part.name;
  const { heading, para } = locate(text, line);
  if (!para && heading) return `${part.name}, heading "${q(heading, 60)}"`;
  return `${part.name}${heading ? `, under "${q(heading, 60)}"` : ''}, paragraph ${para || 1}`;
}

function lineAt(text, re) {
  const m = re.exec(text);
  return m ? text.slice(0, m.index).split('\n').length : null;
}

// Every hit on the card: { where, quote, rule, fix, blocks_ready }.
function tellsDetail(card) {
  const out = [];
  for (const part of partsOf(card)) {
    if (!part.text.trim()) continue;
    const r = lint(part.text);
    if (r.clean) continue;
    const lines = part.text.split('\n');
    const mine = [];
    for (const h of [...r.fails, ...r.flags]) {
      const rule = ruleOf(h);
      let line = h.line || null;
      let quote = h.phrase || '';
      let fix = fixFor(h, rule);
      if (rule === 1 && line) {
        // The dash itself, with the words around it, and the line written without it.
        const l = lines[line - 1] || '';
        const at = l.search(/—| – /);
        const snip = l.slice(Math.max(0, at - 35), at + 37).trim();
        quote = snip;
        fix = `Write it as "${q(replaceDashes(snip).text, 90)}".`;
      } else if (h.rule === 'gush repeated') {
        line = lineAt(part.text, new RegExp('\\b' + h.phrase + '\\b', 'i'));
        quote = `${h.phrase} (${h.count} times)`;
      } else if (h.rule === 'too much bold') {
        quote = `${h.count} bold phrases`;
      }
      mine.push({ at: line || 0, hit: { where: whereOf(part, part.text, line), quote: q(quote, 90), rule: h.rule, fix, blocks_ready: r.fails.includes(h) } });
    }
    // Top to bottom within each part, the order she reads it in.
    mine.sort((a, b) => a.at - b.at).forEach((m) => out.push(m.hit));
  }
  return out;
}

// Rule 2: the action line and the "Approve will:" line must agree on what
// Approve does. Both come from kindOf(); this is the check the tests use.
function agrees(card) {
  const w = approveWill(card);
  if (!w) return true;
  return actionLine(card).kind === w.kind && actionLine(card).info_only === w.got_it;
}

module.exports = { actionLine, tellsDetail, locate, agrees };
