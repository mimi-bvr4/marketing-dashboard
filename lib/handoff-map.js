// ORDER #3802 (Mimi 11.24.2026, "How do they all get interconnected and work
// together", "Producer role: agent to agent fires automatically").
//
// THE HANDOFF MAP: which team member's output is which team member's input.
// One list (EDGES), read by three places:
//   /agents          the map as a table (routes/agents.js /api/producer -> rows())
//   /review          each card's "Came from: <agent>, card #N" and "Next: <agent>" (cardChain())
//   the Producer     fire(): when an upstream card is APPROVED or its output LANDS
//                    (a new post goes live), queue the next team member's run.
//                    No human relay.
//
// What fire() does: only QUEUE a draft run through store.chainRun (the same
// one-queue, once-per-item bookkeeping as #1759). It never approves, publishes,
// posts, pins or sends; every run it queues ends at a draft card on Review.
// The Producer's hold still applies: while the drafts waiting reach the hold
// (producer.holdAt), it fires nothing, marks nothing, and the next pass tries again.
// Turning it on never fires the back catalogue: the first pass with the switch
// on records the moment and fires only what was approved or landed after it.
//
// FEATURE FLAG: PRODUCER_HANDOFFS default OFF. Off: fire() does nothing at all,
// the map still shows (with each new edge marked "off"), and cards still show
// where they came from. Turning it on is Mimi's popup.
'use strict';

const FLAG = 'PRODUCER_HANDOFFS';
function handoffsOn(env = process.env) {
  return /^(1|on|true|yes)$/i.test(String((env || {})[FLAG] || '').trim());
}
const isOn = (env, name) => /^(1|on|true|yes)$/i.test(String((env || {})[name] || '').trim());

const CHAIN_QUEEN_GBP = 'queen-to-gbp';
const CHAIN_POST_GBP = 'new-post-to-gbp';
const BASELINE_CHAIN = 'producer-handoffs';
const BASELINE_KEY = 'baseline';
// At most this many runs queued by one pass (every 15 minutes), on top of the hold.
const MAX_PER_PASS = 6;
// Only an approval or a new post this recent is fired.
const RECENT_DAYS = 14;

// Every handoff, in the order the map shows them. `from`/`to` are agent slugs,
// or a non-agent source named by `from_label`. `state(env)` says whether it
// runs today: 'on', or a plain "off until ..." line.
const EDGES = [
  {
    id: 'queen-to-bob', from: 'keyword-queen', to: 'bloggy-bob', chain: 'keyword-queen-to-bob', order: '#3163, #3802',
    when: 'Katherine approves a Keyword Queen card',
    what: 'Bob writes one blog draft per keyword on the card, with the Queen\'s Ubersuggest figures',
    state: (env) => (handoffsOn(env) ? 'on' : `off until Mimi switches it on (${FLAG}); "Send to Bloggy Bob" on each topic still works`),
  },
  {
    id: 'queen-to-gbp', from: 'keyword-queen', to: 'gbp', chain: CHAIN_QUEEN_GBP, order: '#3802',
    when: 'Katherine approves a Keyword Queen card',
    what: 'Google Business drafts posts built on the approved keywords',
    state: (env) => (handoffsOn(env) ? 'on' : `off until Mimi switches it on (${FLAG})`),
  },
  {
    id: 'gaps-to-gbp', from: null, from_label: 'Search Console GAPS list', to: 'gbp', chain: null, order: '#3791',
    when: 'every morning',
    what: 'Google Business reads the GAPS list and the keyword map on its daily run',
    state: () => 'on',
  },
  {
    id: 'bob-to-paul', from: 'bloggy-bob', to: 'pinterest-paul', chain: 'new-post-to-paul', order: '#1759',
    when: 'a new post goes live on one of our sites (checked once a day)',
    what: 'Pinterest Paul drafts one pin for it',
    state: () => 'on',
  },
  {
    id: 'bob-to-gbp', from: 'bloggy-bob', to: 'gbp', chain: CHAIN_POST_GBP, order: '#3802',
    when: 'a new post goes live on one of our sites',
    what: 'Google Business drafts one post for that venue linking to it',
    state: (env) => (handoffsOn(env) ? 'on' : `off until Mimi switches it on (${FLAG})`),
  },
  {
    id: 'seo-to-bob', from: 'seo', to: 'bloggy-bob', chain: 'seo-to-bob', order: '#1759',
    when: 'the SEO card lists a "For Bloggy Bob" keyword',
    what: 'Bob drafts that post, unless a page already owns the keyword',
    state: () => 'on',
  },
  {
    id: 'scout-to-bob', from: 'scout', to: 'bloggy-bob', chain: 'scout-to-bob', order: '#2901',
    when: 'the Scout\'s "Moves for us" names a blog title',
    what: 'Bob drafts it',
    state: (env) => (isOn(env, 'PRODUCER_QUEUE') ? 'on' : 'off until Mimi switches it on (PRODUCER_QUEUE)'),
  },
  {
    id: 'citations-to-patty', from: 'citations', to: 'pr-patty', chain: 'citation-gap-to-patty', order: '#1759',
    when: 'AI assistants cite a site that names none of our venues',
    what: 'PR Patty drafts a pitch to that site',
    state: () => 'on',
  },
];

// An agent's default name from its agent.json (the pages lay Katherine's names over it).
function agentName(slug) {
  if (!slug) return '';
  try { return require('./agent-runner').loadAgent(slug).name || slug; } catch (e) { return slug; }
}

const CHAIN_EDGE = new Map(EDGES.filter((e) => e.chain).map((e) => [e.chain, e]));

// The map as rows for /agents. nameOf(slug) gives the display name.
function rows({ env = process.env, nameOf = agentName } = {}) {
  return EDGES.map((e) => {
    const state = e.state(env);
    return { id: e.id, from: e.from, from_name: e.from ? nameOf(e.from) : e.from_label, to: e.to, to_name: nameOf(e.to),
      when: e.when, what: e.what, on: state === 'on', state, order: e.order };
  });
}

// A card's place in the chain: where it came from (recorded on the card when a
// chain's run made it, came_from) and which team members take its output next.
function cardChain(card, { env = process.env, nameOf = agentName } = {}) {
  if (!card) return null;
  const cf = card.came_from || null;
  let came = null;
  if (cf && (cf.agent || cf.label)) {
    came = { agent: cf.agent || null, name: cf.agent ? (cf.agent_name || nameOf(cf.agent)) : cf.label, card: cf.card || null, chain: cf.chain || null,
      line: `${cf.agent ? (cf.agent_name || nameOf(cf.agent)) : cf.label}${cf.card ? `, card #${cf.card}` : ''}` };
  }
  const next = EDGES.filter((e) => e.from === card.agent).map((e) => ({ agent: e.to, name: nameOf(e.to), on: e.state(env) === 'on', when: e.when }));
  if (!came && !next.length) return null;
  const nextLine = next.length ? next.map((n) => `${n.name}${n.on ? '' : ' (off)'}`).join(', ') : '';
  return { came_from: came, next, next_line: nextLine };
}

// What to record on a card a queued run made (jobs/agent_requests.js). q is the
// agent_run_requests row; fromCard the upstream card (or null).
function originOf(q, fromCard) {
  if (!q || !q.chain) return null;
  const e = CHAIN_EDGE.get(q.chain);
  if (fromCard) return { chain: q.chain, agent: fromCard.agent, agent_name: fromCard.agent_name || null, card: fromCard.id };
  if (q.chain === 'new-post-to-paul') return { chain: q.chain, agent: null, label: 'a new post on our site', card: null };
  return { chain: q.chain, agent: e && e.from ? e.from : null, label: e ? (e.from_label || null) : q.chain, card: null };
}

// ------------------------------------------------------------ the Producer's fire pass

const mdY = (d) => { const s = new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); return `${s.slice(5, 7)}.${s.slice(8, 10)}.${s.slice(0, 4)}`; };

// The moment the switch was first seen on. The first call records it and says first: true.
async function baseline(store, now) {
  const at = now.toISOString();
  const first = await store.chainMark(BASELINE_CHAIN, BASELINE_KEY, at, null);
  if (first) return { at: new Date(at), first: true };
  const row = (await store.chainKeys(BASELINE_CHAIN, [BASELINE_KEY]))[0];
  const t = row && Date.parse(row.note);
  return { at: Number.isFinite(t) ? new Date(t) : new Date(at), first: false };
}

function queenGbpAsk(card, topics, who) {
  const lines = topics.map((t) => `- keyword: ${t.keyword} · venue: ${t.venue}${t.topic ? ` · topic: ${t.topic}` : ''}`).join('\n');
  return `Write Google Business posts built on these keywords, approved by ${who || 'Katherine'} on Keyword Queen card #${card.id}:\n${lines}\n\n`
    + 'One post per venue at most, for the venues listed only; keyword_source is "keyword map". '
    + `Fired by the Producer (ORDER #3802) when the Queen's card was approved. A draft only: nothing posts until Approve on the Review tab.`;
}

function postGbpAsk(link, bobCard) {
  return `A new post just went live: ${link}\n\nWrite one Google Business post for the venue this post is about, linking to it, built on the post's own keyword. `
    + (bobCard ? `From Bloggy Bob card #${bobCard}. ` : 'The post was written outside the Box. ')
    + 'Fired by the Producer (ORDER #3802). A draft only: nothing posts until Approve on the Review tab.';
}

// One pass. Called every 15 minutes by jobs/agent_handoff.js. Returns what it did.
async function fire({ store, env = process.env, now = () => new Date(), log = () => {} }) {
  const out = { on: handoffsOn(env), queued: [], skipped: [], held: null, baseline: null };
  if (!out.on) return out;
  if (!store || !store.chainRun || !store.list) { out.skipped.push({ item: 'all', why: 'this store cannot queue runs' }); return out; }
  const t = now();
  const base = await baseline(store, t);
  if (base.first) {
    out.baseline = base.at.toISOString();
    log(`handoffs: switched on; from ${mdY(base.at)} on, approvals and new posts fire the next team member (nothing earlier is fired)`);
    return out;
  }
  const P = require('./producer');
  const hold = P.holdAt(t);
  let waiting = store.draftsWaiting ? await store.draftsWaiting() : 0;
  const room = () => waiting < hold && out.queued.length < MAX_PER_PASS;
  if (!room()) {
    out.held = waiting >= hold ? `${waiting} drafts are waiting for review (the hold starts at ${hold})` : `over ${MAX_PER_PASS} for one pass`;
    log(`handoffs: held by the Producer (${out.held}); nothing fired, the next pass tries again`);
    return out;
  }
  const since = Math.max(base.at.getTime(), t.getTime() - RECENT_DAYS * 864e5);
  const fresh = (c) => c.decided_at && new Date(c.decided_at).getTime() > since;
  const push = (r, item, edge, fromCard) => {
    if (r.request) { out.queued.push({ edge, item, request: r.request.id, from_card: fromCard }); waiting += 1; }
    // Already queued (by an earlier pass or by hand) is the normal case, not news.
    else if (!/already queued/.test(r.skipped || '')) out.skipped.push({ edge, item, why: r.skipped || r.error || 'not queued' });
  };

  // 1. An approved Keyword Queen card: Bob for each topic, Google Business once for the card.
  const KQ = require('./keyword-queen');
  const queenCards = (await store.list({ status: 'ready', agent: KQ.SLUG, limit: 50 })).filter(fresh).reverse();
  for (const card of queenCards) {
    const topics = (card.payload && card.payload.topics) || [];
    if (!topics.length) continue;
    for (const tp of topics) {
      if (!room()) break;
      // Same chain and key as the "Send to Bloggy Bob" button, so a topic sent by hand is never sent twice.
      const r = await store.chainRun({ chain: KQ.CHAIN, key: `card-${card.id}:${tp.n}`, agent: 'bloggy-bob', fromCard: card.id,
        ask: KQ.topicAsk(card, tp, card.decided_by, 'fired by the Producer when the card was approved (ORDER #3802)'), priority: P.PRIORITY.chain });
      push(r, tp.keyword, 'queen-to-bob', card.id);
    }
    if (!room()) break;
    const r = await store.chainRun({ chain: CHAIN_QUEEN_GBP, key: `card-${card.id}`, agent: 'gbp', fromCard: card.id,
      ask: queenGbpAsk(card, topics, card.decided_by), priority: P.PRIORITY.chain });
    push(r, `Keyword Queen card #${card.id}`, 'queen-to-gbp', card.id);
  }

  // 2. A new post went live (the daily published-posts read queued Paul for it): Google Business too.
  if (room() && store.chainRecent) {
    const posts = (await store.chainRecent('new-post-to-paul', RECENT_DAYS)).filter((p) => p.request_id && new Date(p.created_at).getTime() > base.at.getTime());
    for (const p of posts) {
      if (!room()) break;
      const m = String(p.ask || '').match(/Pin this new post:\s*(https:\/\/\S+)/);
      if (!m) { out.skipped.push({ edge: 'bob-to-gbp', item: p.key, why: 'the post link could not be read from Paul\'s request' }); continue; }
      const r = await store.chainRun({ chain: CHAIN_POST_GBP, key: p.key, agent: 'gbp', fromCard: p.from_card || null,
        ask: postGbpAsk(m[1], p.from_card), priority: P.PRIORITY.chain });
      push(r, m[1], 'bob-to-gbp', p.from_card || null);
    }
  }
  if (out.queued.length || out.skipped.length) {
    log(`handoffs: ${out.queued.length} run(s) fired (${out.queued.map((q) => `${q.edge} ${q.item}`).join('; ').slice(0, 300)})`
      + (out.skipped.length ? `, ${out.skipped.length} not fired` : ''));
  }
  return out;
}

module.exports = { FLAG, handoffsOn, EDGES, agentName, rows, cardChain, originOf, fire, baseline, queenGbpAsk, postGbpAsk,
  CHAIN_QUEEN_GBP, CHAIN_POST_GBP, BASELINE_CHAIN, MAX_PER_PASS, RECENT_DAYS };
