// ORDER #3826 (Mimi popup 11.25.2026, "Yes, top 5 daily"; from her 11.24 notes
// with Katherine: "she needs actions instead of info overload", "clear
// direction"). The "Today" box at the top of /review: at most 5 lines, each a
// card's action line (#3797) and its agent, ranked:
//
//   1. hard deadlines, soonest first: PR Patty pitches (#3798), Gala Scout
//      dates, Convention Charles assigns;
//   2. anything blocking a live thing: a disapproved ad, a paused campaign or a
//      final URL that does not load (#3821's midday check), a Site Guardian
//      (Night Watch) flag, a site down;
//   3. the highest-payoff drafts: cards tied to a Search Console gap (#3791)
//      first, biggest gap first, then blog posts and topics, then the rest,
//      oldest first.
//
// WHEN IT REFRESHES: it is computed from the Drafts pile on every load, so a
// card acted on drops out at once and the next one moves up. The day it is
// "Today" for turns over at 07:00 CT (dayOf), which is when a deadline that
// has passed stops counting as a deadline; the page reloads the box then.
//
// Pure: cards in, lines out. It changes nothing and sends nothing.
'use strict';

const { actionLine } = require('./card-action');

const MAX = 5;
const TZ = 'America/Chicago';
const TURN_HOUR = 7;

const DEADLINE_AGENTS = new Set(['pr-patty', 'gala-scout', 'convention-connector']);
const BLOCKING_AD_KINDS = new Set(['disapproved', 'paused', 'url', 'drop']);
const AD_WORDS = { disapproved: 'a disapproved ad', paused: 'a paused campaign', url: 'a final URL that does not load', drop: 'impressions dropped to 0' };
const SITE_DOWN = /\b(down|broken|does not load|not loading|404|50[0-9]|redirects off-site|hack)/i;
const GAP_TEXT = /search console|content gap/i;
const DATE = /\b(\d{2})\.(\d{2})\.(\d{4})\b/;

const WHY = 'Why these: hard deadlines first, soonest first; then anything blocking a live thing (a disapproved ad, a broken page, a Night Watch flag); then the drafts with the biggest payoff, Search Console gaps first.';
const NONE = 'Nothing needs you today.';

function ctParts(d) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
}

// The "Today" a moment belongs to, as YYYY-MM-DD: the CT date, except that
// before 07:00 CT it is still the previous day's Today.
function dayOf(now = new Date()) {
  const p = ctParts(now);
  if (Number(p.hour) >= TURN_HOUR) return `${p.year}-${p.month}-${p.day}`;
  const prev = ctParts(new Date(now.getTime() - (Number(p.hour) + 1) * 3600000));
  return `${prev.year}-${prev.month}-${prev.day}`;
}

// The next 07:00 CT after now, as an ISO instant (CT is UTC-6 or UTC-5).
function nextRefresh(now = new Date()) {
  for (let h = 1; h <= 26; h++) {
    const t = new Date(Math.floor(now.getTime() / 3600000) * 3600000 + h * 3600000);
    const p = ctParts(t);
    if (Number(p.hour) === TURN_HOUR && p.minute === '00') return t.toISOString();
  }
  return null;
}

// The deadline a card names, as YYYY-MM-DD: the first MM.DD.YYYY in the
// title, else in the body. null when it names none.
function deadlineOf(card) {
  const m = DATE.exec(String((card && card.title) || '')) || DATE.exec(String((card && card.body) || ''));
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function adKinds(card) {
  const a = card && card.payload && card.payload.ads_monitor;
  return a && Array.isArray(a.kinds) ? a.kinds.filter((k) => BLOCKING_AD_KINDS.has(k)) : [];
}

// Is this card flagging something live that is broken right now?
function blocking(card) {
  if (adKinds(card).length) return true;
  if (card.agent === 'site-guardian') return true;
  const text = `${card.title || ''}\n${card.body || ''}`;
  if (card.agent === 'site-health' && SITE_DOWN.test(text)) return true;
  if (card.agent === 'web' && /landing page/i.test(text) && SITE_DOWN.test(text)) return true;
  return false;
}

function gapOf(card) {
  const g = card && card.payload && card.payload.gsc_gap;
  if (g) return { tied: true, impressions: Number(g.impressions) || 0 };
  const p = (card && card.payload) || {};
  const text = `${card.title || ''}\n${card.body || ''}\n${(p.post && p.post.content_md) || ''}`;
  return { tied: GAP_TEXT.test(text), impressions: 0 };
}

// The line shown for a card. A card with an action uses its #3797 action line
// word for word; a blocking report card (they show Got it) says what to look at.
function lineFor(card, a) {
  if (!a.info_only) return a.line;
  const title = String(card.title || '').replace(/\s+/g, ' ').trim();
  const kinds = adKinds(card);
  if (kinds.length) return `Fix in Google Ads what "${title}" flags: ${kinds.map((k) => AD_WORDS[k]).join(', ')}. The Brain changes nothing in Google Ads.`;
  if (card.agent === 'site-guardian') return `Look into the Night Watch flag "${title}". Night Watch alerts go to Mimi first.`;
  return `Look into "${title}": a live page is not working.`;
}

function ms(card) {
  const t = new Date(card && card.created_at).getTime();
  return Number.isFinite(t) ? t : 0;
}

// cards: the Drafts pile (any order). Returns
//   { day, refreshed_at, next_refresh, why, empty, items: [{ id, line, agent, agent_name, tier, deadline? }] }
// with at most 5 items. `empty` is "Nothing needs you today." when items is empty.
function today(cards, { now = new Date(), max = MAX } = {}) {
  const day = dayOf(now);
  const ranked = [];
  for (const c of cards || []) {
    if (!c || c.status !== 'draft' || c.agent === 'digest') continue;
    const a = actionLine(c);
    const block = blocking(c);
    if (a.info_only && !block) continue;
    const due = DEADLINE_AGENTS.has(c.agent) ? deadlineOf(c) : null;
    let tier;
    let key;
    if (DEADLINE_AGENTS.has(c.agent) && !(due && due < day)) {
      // dated deadlines soonest first, then the undated ones (an assign with no date)
      tier = 1; key = [due ? 0 : 1, due || '', ms(c)];
    } else if (block) {
      tier = 2; key = [0, '', ms(c)];
    } else {
      const g = gapOf(c);
      const k = a.kind;
      tier = 3; key = [g.tied ? 0 : k === 'post' || k === 'topics' ? 1 : 2, String(1e12 - g.impressions).padStart(13, '0'), ms(c)];
    }
    ranked.push({ c, a, tier, key, due });
  }
  ranked.sort((x, y) => x.tier - y.tier || x.key[0] - y.key[0] || (x.key[1] < y.key[1] ? -1 : x.key[1] > y.key[1] ? 1 : 0) || x.key[2] - y.key[2] || x.c.id - y.c.id);
  const items = ranked.slice(0, max).map(({ c, a, tier, due }) => ({
    id: c.id, line: lineFor(c, a), agent: c.agent, agent_name: c.agent_name || c.agent, tier, ...(tier === 1 && due ? { deadline: due } : {}),
  }));
  return { day, refreshed_at: now.toISOString(), next_refresh: nextRefresh(now), why: WHY, empty: items.length ? null : NONE, items };
}

module.exports = { MAX, WHY, NONE, DEADLINE_AGENTS, today, dayOf, nextRefresh, deadlineOf, blocking };
