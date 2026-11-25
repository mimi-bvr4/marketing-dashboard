// ORDER #3814 (#3797 rule 3, Mimi 11.24.2026 after working with Katherine):
// "No info-only cards. If there is no action, there is no card. Fold the
// information into the agent's weekly summary instead."
//
// The weekly summary is the Monday digest (lib/agent-digest.js); there is no
// second one. The runner (lib/agent-runner.js put()) asks foldsAway(card) for
// every drafted card. A card it folds is saved as a dated agent_report_notes
// entry instead of a Review card, and the digest lists the week's entries.
//
// A card folds when kindOf() calls it a report (a REPORT_AGENTS card with no
// payload) AND none of these makes it an action:
//   * digest            it IS the weekly summary;
//   * citations         carried by #3808: fix cards, plus a summary whose lines
//                       are actions ("Claim our listing on ..."), and the #1759
//                       Patty chain reads that summary by its card id;
//   * a chain line      SEO's "For Bloggy Bob" lines (#1759) and the Scout's
//                       blog moves (#2901) queue runs that name the card's id;
//   * SEO "Quick wins"  every row is a page and the words to paste (#3808).
// Notices ("could not run", "run failed", ...) never reach foldsAway: the
// runner saves them outside `written`, as before (#3753, #3755). A Run now a
// person asked for (ask) and a Redo always answer with a card; only the
// unprompted runs (scheduled, or with no ask) fold.
//
// Pure: card in, true or false out. It sends nothing and writes nothing.
'use strict';

const { kindOf } = require('./approve-will');

const KEEP_AGENTS = new Set(['digest', 'citations']);
const QUICK_WINS = /^Quick wins\b/i;

function foldsAway(card) {
  if (!card || kindOf(card) !== 'report') return false;
  if (KEEP_AGENTS.has(card.agent)) return false;
  if (QUICK_WINS.test(String(card.title || '').trim())) return false;
  const chains = require('./agent-chains');
  const text = require('./agent-runner').modelText(card.body);
  if (chains.bobLines(text).length || chains.scoutBlogTitles(text).length) return false;
  return true;
}

// The digest's lines for the week's folded entries, oldest first.
// One line each: date (MM.DD.YYYY CT), the agent's name, the title in bold,
// then the first 300 characters of what it wrote.
function day(d) {
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric' }).replace(/\//g, '.');
}
function excerpt(body, max = 300) {
  const s = require('./agent-runner').modelText(body).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3).trimEnd() + '...' : s;
}
function digestSection(notes, names = new Map()) {
  if (!notes || !notes.length) return '';
  const lines = notes.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((r) => {
    const title = String(r.title || '').trim().replace(/[.\s]+$/, '');
    const text = excerpt(r.body);
    return `- ${day(r.created_at)}, ${names.get(r.agent) || r.agent_name || r.agent}: **${title}**.${text ? ` ${text}` : ''}`;
  });
  return '### Folded in from the report agents (no card made)\n'
    + 'Information only, so no card was made (#3797 rule 3). Each one is here instead.\n' + lines.join('\n');
}

module.exports = { foldsAway, digestSection, KEEP_AGENTS, QUICK_WINS };
