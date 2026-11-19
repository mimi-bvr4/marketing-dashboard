// ORDER #3627 (Mimi 11.19.2026): ONE Pinterest Paul card for the Pinterest
// Standard-upgrade demo video (step 5 of the #3164 script). RUNS ON THE BOX,
// inside jobs/agent_handoff.js (every 15 minutes), right after the Pinterest
// accounts are synced.
//
// What it does, once:
//   1. The first run that finds the Infinity Hospitality Group row Connected with
//      the sandbox board "IH Pin Publisher demo" on it queues ONE Pinterest Paul
//      run for one real, published post on infinityhospitalitygroup.com (the
//      newest one the WordPress posts list shows).
//   2. When that run's card exists and is still a draft, the card's pin is set to
//      the IHG account and the demo board (the same choosePin a person's pick on
//      /review uses), so the card shows on /review with the board already picked.
//   Approve then goes through the normal hand-off, which pins to the SANDBOX only
//   while PINTEREST_SANDBOX is on (lib/pinterest.js). Nothing here pins.
//
// 🔴 THE FENCES (code, not prompt):
//   1. demoAllowed() is the only way in: PINTEREST_SANDBOX on, PINTEREST_PER_VENUE
//      on, the account is IHG (TRIAL_ACCOUNT), and its row is Connected with the
//      demo board. Any other account, agent or board is refused.
//   2. At most ONE demo card, ever: each attempt is an agent_chains row (claimed
//      with ON CONFLICT DO NOTHING), and a second attempt is queued only when the
//      first run FAILED and made no card. MAX_ATTEMPTS is 2.
//   3. The Producer's hold (lib/producer.js decide) never gated the run-request
//      queue this run goes through; it holds scheduled calendar runs only, and
//      Paul is not on the calendar. So this file bypasses nothing for anyone: it
//      only queues the one demo run. No other agent or account is queued here.
'use strict';

const pt = require('./pinterest');
const PV = require('./pinterest-venues');
const { BOARD_NAME } = require('./pinterest-sandbox-board');

const CHAIN_DEMO = 'pinterest-ihg-demo';
const MAX_ATTEMPTS = 2;
const keyOf = (n) => `IHG demo card, attempt ${n}`;
const DEMO_SITE = 'infinityhospitalitygroup.com';
const WHO = 'the Box (the IHG demo card for the Pinterest Standard video, ORDER #3627)';

// The one check. Returns { ok: true, account } or { ok: false, why }.
function demoAllowed({ env = process.env, accounts = [], venue = pt.TRIAL_ACCOUNT, agent = 'pinterest-paul', board = BOARD_NAME } = {}) {
  if (!pt.sandboxOn(env)) return { ok: false, why: 'PINTEREST_SANDBOX is off' };
  if (!PV.perVenueOn(env)) return { ok: false, why: 'PINTEREST_PER_VENUE is off' };
  if (agent !== 'pinterest-paul') return { ok: false, why: 'only Pinterest Paul makes the demo card' };
  if (String(venue || '').toUpperCase() !== pt.TRIAL_ACCOUNT) return { ok: false, why: `only the ${pt.TRIAL_ACCOUNT} account gets the demo card` };
  if (board !== BOARD_NAME) return { ok: false, why: `only the "${BOARD_NAME}" board` };
  const row = (accounts || []).find((a) => a.venue === pt.TRIAL_ACCOUNT);
  if (!row || !row.connected) return { ok: false, why: 'Infinity Hospitality Group is not Connected yet (Settings, Pinterest accounts)' };
  if (!(row.boards || []).some((b) => b && b.name === BOARD_NAME)) return { ok: false, why: `the IHG sandbox has no "${BOARD_NAME}" board yet` };
  return { ok: true, account: row };
}

// The newest published post on the IHG site, from the live WordPress posts list.
async function newestIhgPost({ fetchImpl }) {
  const { readWpPosts } = require('./agent-sources');
  const { posts, miss } = await readWpPosts([DEMO_SITE], { fetch: fetchImpl });
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return null; } };
  const list = posts.filter((p) => /^https:\/\//.test(p.link || '') && hostOf(p.link) === DEMO_SITE)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!list.length) return { why: miss.length ? `the IHG posts list was not read (${miss.join(', ')})` : 'the IHG site lists no published post' };
  return { post: list[0] };
}

const cardIdsOf = (note) => [...String(note || '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

// Where the demo stands: the attempts made and their requests.
async function attempts(store) {
  const rows = await store.chainKeys(CHAIN_DEMO, Array.from({ length: MAX_ATTEMPTS }, (_, i) => keyOf(i + 1)));
  const reqs = await store.runRequests(200);
  return rows.map((r) => ({ key: r.key, request: reqs.find((q) => q.id === r.request_id) || null }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// Step 1: queue the one demo run when allowed. Returns what happened, in words.
async function queueDemo({ store, accounts, env = process.env, fetchImpl = globalThis.fetch, log = () => {} }) {
  const ok = demoAllowed({ env, accounts });
  if (!ok.ok) return { queued: false, why: ok.why };
  const made = await attempts(store);
  const last = made[made.length - 1];
  if (last) {
    const st = last.request && last.request.status;
    if (st !== 'failed') return { queued: false, why: `the demo run is already ${st || 'queued'}` };
    if (cardIdsOf(last.request.note).length) return { queued: false, why: 'the demo run already made a card' };
    if (made.length >= MAX_ATTEMPTS) return { queued: false, why: `the demo run failed ${MAX_ATTEMPTS} times; press Run now on Paul with an IHG post link` };
  }
  const p = await newestIhgPost({ fetchImpl });
  if (!p.post) { log(`pinterest demo: not queued, ${p.why}`); return { queued: false, why: p.why }; }
  const ask = `Pin this post: ${p.post.link}\n\n`
    + `The ONE Infinity Hospitality Group demo card for the Pinterest Standard-upgrade video (ORDER #3627). `
    + `Account: Infinity Hospitality Group. Board: ${BOARD_NAME}. The Box sets both on the card. `
    + 'Approve pins it in the Pinterest SANDBOX only; nothing reaches live Pinterest.';
  const r = await store.chainRun({ chain: CHAIN_DEMO, key: keyOf(made.length + 1), agent: 'pinterest-paul', ask, priority: 2, requestedBy: WHO });
  if (!r.request) return { queued: false, why: r.skipped };
  log(`pinterest demo: queued Pinterest Paul run ${r.request.id} for ${p.post.link} (IHG, "${BOARD_NAME}", attempt ${made.length + 1})`);
  return { queued: true, request: r.request, link: p.post.link };
}

// Step 2: put the IHG account and the demo board on the demo card, while it is a draft.
async function pickDemoBoard({ store, accounts, env = process.env, log = () => {} }) {
  const ok = demoAllowed({ env, accounts });
  if (!ok.ok) return { picked: false, why: ok.why };
  for (const a of await attempts(store)) {
    for (const id of cardIdsOf(a.request && a.request.status === 'done' ? a.request.note : '')) {
      const card = await store.get(id);
      if (!card || card.agent !== 'pinterest-paul' || !card.payload || !card.payload.pin) continue;
      const pin = card.payload.pin;
      if (pin.venue === pt.TRIAL_ACCOUNT && pin.board === BOARD_NAME) return { picked: false, why: 'already picked', card: id };
      if (card.status !== 'draft') return { picked: false, why: `card ${id} is ${card.status}`, card: id };
      const out = PV.choosePin(card, { venue: pt.TRIAL_ACCOUNT, board: BOARD_NAME }, accounts);
      if (out.error) { log(`pinterest demo: card ${id} not set, ${out.error}`); return { picked: false, why: out.error, card: id }; }
      const saved = await store.setPinPayload(id, out.payload);
      if (!saved) return { picked: false, why: 'only a draft pin can be changed', card: id };
      log(`pinterest demo: card ${id} set to Infinity Hospitality Group, "${BOARD_NAME}"`);
      return { picked: true, card: id };
    }
  }
  return { picked: false, why: 'no demo card yet' };
}

module.exports = { demoAllowed, queueDemo, pickDemoBoard, newestIhgPost, attempts, cardIdsOf, CHAIN_DEMO, MAX_ATTEMPTS, keyOf, WHO };
