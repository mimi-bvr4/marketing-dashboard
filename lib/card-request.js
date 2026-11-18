// ORDER #3563 (Mimi 11.18.2026): "she should be able to type the city into the
// agent on the page and then you take it from there, not her tell me and me tell you."
//
// A team member whose run needs ONE short typed request (the Traveler: a city)
// gets a box on its card. agent.json "card_request" turns it on:
//
//   "card_request": { "kind": "city", "label": "Which city? (e.g. Atlanta)",
//                     "button": "Start research", "max": 60,
//                     "ready": "Ready: type a city to start" }
//
// Submitting queues ONE run in the same queue as Run now (agent_run_requests),
// with the typed value as its ask: exactly what a manual `--ask "<city>"` gives
// the runner. Pure: no store, no network. Drafts only; nothing is sent.
'use strict';

const MAX_DEFAULT = 60;

function cardRequestOf(def) {
  const c = def && def.card_request;
  if (!c || typeof c !== 'object') return null;
  return {
    kind: c.kind || 'text',
    label: c.label || 'Your request',
    button: c.button || 'Start',
    max: Number.isInteger(c.max) && c.max > 0 ? c.max : MAX_DEFAULT,
    ready: c.ready || 'Ready: type a request to start',
  };
}

// A city name only. Letters (any language), spaces and . , ' - ; up to 6 words.
// "Austin, TX", "St. Louis", "Winston-Salem", "Coeur d'Alene" pass; a link, an
// email, digits or a sentence do not.
const CITY = /^\p{L}[\p{L} .,'’-]*$/u;
function checkValue(raw, cfg) {
  const c = cfg || { kind: 'city', max: MAX_DEFAULT };
  const v = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!v) return { error: c.kind === 'city' ? 'Type a city first.' : 'Type a request first.', status: 400 };
  if (v.length > c.max) return { error: `That is too long. Keep it to ${c.max} characters.`, status: 400 };
  if (c.kind === 'city') {
    if (/https?:|www\.|@/i.test(v) || !CITY.test(v) || v.split(' ').length > 6) {
      return { error: 'Type a city name only, for example Atlanta or Austin, TX.', status: 400 };
    }
  }
  return { value: v };
}

// MM.DD.YYYY h:mm AM CT, Nashville time.
function ct(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month}.${p.day}.${p.year} ${p.hour}:${p.minute} ${p.dayPeriod} CT`;
}

// What the card shows under the box: the newest person-asked run of this agent
// (never a chain's run or a redo), or the ready line when there is none.
function cardState(cfg, slug, requests) {
  if (!cfg) return null;
  const mine = (requests || []).filter((r) => r.agent === slug && !r.chain && !r.from_card && r.ask)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || (b.id || 0) - (a.id || 0));
  const r = mine[0];
  if (!r) return { state: 'ready', line: cfg.ready };
  const what = r.ask;
  if (r.status === 'queued' || r.status === 'running') {
    return { state: r.status, value: what, line: `${r.status === 'running' ? 'Running' : 'Queued'} for ${what} · ${ct(r.created_at)}` };
  }
  if (r.status === 'failed') {
    return { state: 'failed', value: what, line: `Failed for ${what} · ${ct(r.finished_at || r.created_at)}${r.note ? `: ${r.note}` : ''}` };
  }
  return { state: 'done', value: what, line: `Done for ${what} · ${ct(r.finished_at || r.created_at)}${r.note ? `: ${r.note}` : ''}. Drafts are on Review.` };
}

// The Waiting-on reason "this agent needs a request (--ask)" describes a box the
// card now has, so it is never a wait for an agent with a card_request.
function isAskWait(def, u) {
  return !!cardRequestOf(def) && !!u && u.type === 'request';
}

module.exports = { cardRequestOf, checkValue, cardState, isAskWait, ct, MAX_DEFAULT };
