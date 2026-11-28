// ORDER #3948 (RULINGS_LEDGER, "MARKETING CARD HOLD UNTIL RELAUNCH", Mimi
// 11.28.2026): while MARKETING_RELAUNCH is off (the default), no agent files a
// card on Review. The agent still runs and what it found is kept as a report
// note. Handoffs and the Executioner do nothing. The Night Watch is exempt.
// The Team and Review pages say so in one line. Turning the switch on is the
// relaunch and puts everything back exactly as before.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const H = require('../lib/card-hold');
const S = require('../lib/agent-store');
const R = require('../lib/agent-runner');
const { lint } = require('../lib/ai-tells');

const card = (over = {}) => ({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'post', title: 'A fall post', body: 'A body.', ...over });
function recorder(rows = [{ id: 7 }]) {
  const seen = [];
  return { seen, pool: { query: async (sql, args) => { seen.push({ sql, args }); return { rows }; } } };
}

test('the switch: unset means the hold is in force; only on/1/true/yes lifts it', () => {
  assert.strictEqual(H.FLAG, 'MARKETING_RELAUNCH');
  assert.strictEqual(H.holdOn({}), true);
  assert.strictEqual(H.holdOn({ MARKETING_RELAUNCH: '' }), true);
  assert.strictEqual(H.holdOn({ MARKETING_RELAUNCH: 'off' }), true);
  for (const v of ['on', '1', 'TRUE', 'yes']) assert.strictEqual(H.holdOn({ MARKETING_RELAUNCH: v }), false, v);
});

test('holds(): every Marketing agent, report cards included; never the Night Watch; never another department', () => {
  for (const agent of ['bloggy-bob', 'scout', 'pr-patty', 'paid-ads', 'digest', 'gbp', 'web-agent', 'google-ads-monitor']) {
    assert.strictEqual(H.holds({ agent }, { env: {} }), true, agent);
  }
  assert.strictEqual(H.holds({ agent: 'site-guardian' }, { env: {} }), false, 'Night Watch alerts still reach Mimi');
  assert.strictEqual(H.holds({ agent: 'scout' }, { env: {}, department: 'demo' }), false);
  assert.strictEqual(H.holds({ agent: 'scout' }, { env: { MARKETING_RELAUNCH: 'on' } }), false);
});

test('pg store: under the hold, insert writes NO agent_cards row; the finding is kept as a report note', async () => {
  const { seen, pool } = recorder();
  const s = S.createPgStore(pool, { lint, env: {} });
  const r = await s.insert(card());
  assert.ok(seen.every((q) => !/INSERT INTO agent_cards/.test(q.sql)), 'no card row');
  const note = seen.find((q) => /INSERT INTO agent_report_notes/.test(q.sql));
  assert.ok(note, 'the finding is stored');
  assert.ok(note.args.includes('Held while the team is on hold: A fall post'));
  assert.ok(note.args.includes('marketing'));
  assert.strictEqual(r.held, true);
  assert.strictEqual(r.id, null, 'no card id is handed back');
  assert.strictEqual(r.note_id, 7);
});

test('pg store: relaunched, insert files the card exactly as before', async () => {
  const { seen, pool } = recorder();
  const s = S.createPgStore(pool, { lint, env: { MARKETING_RELAUNCH: 'on' } });
  await s.insert(card());
  assert.ok(seen.some((q) => /INSERT INTO agent_cards/.test(q.sql)));
  assert.ok(seen.every((q) => !/agent_report_notes/.test(q.sql)));
});

test('pg store: the Night Watch and another department still file under the hold', async () => {
  const a = recorder();
  await S.createPgStore(a.pool, { lint, env: {} }).insert(card({ agent: 'site-guardian', agent_name: 'Night Watch' }));
  assert.ok(a.seen.some((q) => /INSERT INTO agent_cards/.test(q.sql)));
  const b = recorder();
  await S.createPgStore(b.pool, { lint, env: {}, department: 'demo' }).insert(card());
  assert.ok(b.seen.some((q) => /INSERT INTO agent_cards/.test(q.sql)));
});

test('pg store: with no env given it reads the process environment (the Box and Railway need no new setting)', async () => {
  const was = process.env.MARKETING_RELAUNCH;
  delete process.env.MARKETING_RELAUNCH;
  try {
    const { seen, pool } = recorder();
    await S.createPgStore(pool, { lint }).insert(card());
    assert.ok(seen.every((q) => !/INSERT INTO agent_cards/.test(q.sql)), 'held by default');
  } finally { if (was !== undefined) process.env.MARKETING_RELAUNCH = was; }
});

test('memory store mirrors the hold only when an env is given (tests and dry runs keep their old behavior)', async () => {
  const held = S.createMemoryStore({ lint, env: {} });
  const r = await held.insert(card());
  assert.strictEqual(r.held, true);
  assert.strictEqual((await held.list({ status: 'draft' })).length, 0);
  assert.strictEqual(held.reportNotes.length, 1);
  const plain = S.createMemoryStore({ lint });
  await plain.insert(card());
  assert.strictEqual((await plain.list({ status: 'draft' })).length, 1);
});

// ---------- the runner: the agent still runs; nothing lands on Review ----------
const at = new Date(Date.UTC(2026, 10, 27, 22, 45));
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const fetchImpl = async (u) => {
  if (u.includes('/messages?')) return json(200, { messages: [{ id: 'm1' }] });
  if (u.includes('/messages/m1')) return json(200, { payload: { headers: [{ name: 'Subject', value: 'HARO Queries' }, { name: 'From', value: 'HARO <haro@helpareporter.com>' }],
    mimeType: 'text/plain', body: { data: b64('1) Summary: Winter venues\nQuery: Brides wants venues. Deadline 11.29.2026. Reply: https://app.haro.com/r/1') } } });
  return json(404, {});
};
const PITCH = { title: 'Pitch Brides: winter venues, due 11.29.2026', seen: { request_id_or_url: 'https://app.haro.com/r/1' },
  body: '### Who\nJane Roe, Brides. Respond: https://app.haro.com/r/1\n\n### More context\nWinter venues. Due 11.29.2026. We fit: Clementine Hall.\n\n### What you do\nSend the pitch below by 11.29.2026.\n\nDraft pitch: Clementine Hall seats 200 in winter.' };
const SUMMARY = { title: 'Press requests, 11.27.2026: 1 to pitch, 0 skipped', body: 'Requests in this email: 1. Read in full: 1 of 1.' };

test('runner under the hold: the run is done, 0 cards on Review, the findings kept, and the run line says why', async () => {
  const store = S.createMemoryStore({ lint, env: {} });
  const r = await R.runAgent({ slug: 'pr-patty', store, llm: { model: 'test', complete: async () => JSON.stringify({ cards: [PITCH, SUMMARY] }) },
    env: { IHG_TREE: require('os').tmpdir() }, log: () => {}, fetchImpl, now: () => at, saKey: {}, saToken: async () => 'tok', scheduled: true });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.cards.length, 0, 'nothing on Review');
  assert.strictEqual(r.held_by_hold, 2);
  assert.strictEqual((await store.list({ status: 'draft' })).length, 0);
  assert.ok(store.reportNotes.length >= 2, 'what it found is kept');
  const [row] = await store.runHistory();
  assert.strictEqual(row.status, 'done');
  assert.strictEqual(row.cards, 0);
  assert.match(row.note, /2 kept, not carded: the team is on hold until Mimi relaunches it/);
});

// ---------- handoffs and the Executioner ----------
const HJ = require('../jobs/agent_handoff');

test('handoff job under the hold: an approved pin is NOT pinned and the Producer fires nothing', async () => {
  const store = S.createMemoryStore({ lint });
  const c = await store.insert(card({ agent: 'pinterest-paul', payload: { pin: { title: 't', description: 'd', link: 'https://x.test', image_url: 'https://x.test/a.jpg', board: 'b' } } }));
  await store.decide(c.id, { action: 'approve', who: 'k@x.com' });
  let calls = 0;
  const logs = [];
  const out = await HJ.passes({ store, env: { PRODUCER_HANDOFFS: 'on' }, fetchImpl: async () => { calls++; return json(500, {}); }, log: (l) => logs.push(l) });
  assert.strictEqual(out.held, true);
  assert.strictEqual(calls, 0, 'nothing sent anywhere');
  assert.strictEqual((await store.get(c.id)).handoff, null, 'the card is left exactly as it is');
  assert.ok(logs.some((l) => /on hold until Mimi relaunches it \(MARKETING_RELAUNCH off, ORDER #3948\)/.test(l)));
});

test('handoff job relaunched: the passes run as before', async () => {
  const store = S.createMemoryStore({ lint });
  const out = await HJ.passes({ store, env: { MARKETING_RELAUNCH: 'on' }, fetchImpl: async () => json(500, {}), log: () => {} });
  assert.strictEqual(out.held, false);
  assert.deepStrictEqual(out.handoff, { seen: 0, done: 0 });
});

// ---------- the pages ----------
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('Team and Review pages carry the one plain line, fetched from /api/card-hold; no order number she can see; no date promised', () => {
  assert.strictEqual(H.TEAM_LINE, 'The team is on hold while it is being finished. Nothing needs you. It comes back when Mimi relaunches it.');
  assert.doesNotMatch(H.TEAM_LINE, /\d/, 'no date is promised');
  for (const f of ['public/agents.html', 'public/review.html']) {
    const html = read(f);
    assert.match(html, /id="cardHold"/, f);
    assert.match(html, /\/api\/card-hold/, f);
    const shown = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(shown, /3948/, `${f}: no order number Katherine can see`);
  }
});

test('GET /api/card-hold says whether the hold is on and the line to show', () => {
  assert.deepStrictEqual(H.status({}), { hold: true, flag: 'MARKETING_RELAUNCH', line: H.TEAM_LINE });
  assert.deepStrictEqual(H.status({ MARKETING_RELAUNCH: 'on' }), { hold: false, flag: 'MARKETING_RELAUNCH', line: null });
  assert.match(read('routes/agents.js'), /\/api\/card-hold/);
});

test('no em dashes and no emoji in what this order added', () => {
  const EM = String.fromCharCode(0x2014);
  for (const f of ['lib/card-hold.js', 'test/order3948_card_hold.test.js']) {
    const t = read(f);
    assert.ok(!t.includes(EM), f);
    assert.doesNotMatch(t, /[\u{1F300}-\u{1FAFF}]/u, f);
  }
});
