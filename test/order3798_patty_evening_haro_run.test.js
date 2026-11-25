// ORDER #3798 (Mimi 11.24.2026): PR Patty runs once a day, on the 3 HARO
// emails (after the third, or at 6:15 PM CT with fewer), and each fit is an
// action card (who, more context, what YOU do + the drafted pitch), with the
// skipped requests in one daily summary. Behind PATTY_EVENING_RUN, default OFF.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const E = require('../lib/patty-evening');
const ma = require('../lib/mail-alerts');
const P = require('../lib/producer');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');
const { main } = require('../jobs/patty_evening');
const R = require('../lib/agent-runner');

const ON = { PATTY_EVENING_RUN: 'on' };
// Nashville times on Wednesday 11.25.2026 (CST, UTC-6).
const at = (hm) => new Date(Date.UTC(2026, 10, 25, Number(hm.slice(0, 2)) + 6, Number(hm.slice(3))));
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('the switch ships OFF; off, the 06:00 list keeps Patty; on, it leaves her out', () => {
  assert.strictEqual(E.eveningOn({}), false);
  assert.strictEqual(E.eveningOn({ PATTY_EVENING_RUN: 'off' }), false);
  assert.strictEqual(E.eveningOn(ON), true);
  assert.deepStrictEqual(E.withoutEveningAgents(['pr-patty', 'gbp'], {}), ['pr-patty', 'gbp']);
  assert.deepStrictEqual(E.withoutEveningAgents(['pr-patty', 'gbp'], ON), ['gbp']);
});

test('Nashville clock: midnight in CST and CDT, and the hour:minute', () => {
  assert.strictEqual(E.chicagoMidnightEpoch('2026-11-25'), Date.UTC(2026, 10, 25, 6) / 1000);
  assert.strictEqual(E.chicagoMidnightEpoch('2026-07-01'), Date.UTC(2026, 6, 1, 5) / 1000);
  assert.strictEqual(E.nashvilleHm(at('18:15')), '18:15');
  assert.strictEqual(E.nashvilleHm(at('00:05')), '00:05');
  assert.strictEqual(E.haroQuery('2026-11-25'), `after:${Date.UTC(2026, 10, 25, 6) / 1000} {haro "help a reporter"}`);
});

test('editions: a forward and its original count once; a non-HARO subject never counts', () => {
  assert.strictEqual(E.countEditions([
    'HARO Queries for November 25, 2026 - Morning Edition',
    'Fwd: HARO Queries for November 25, 2026 - Morning Edition',
    'HARO Queries for November 25, 2026 - Afternoon Edition',
    'Qwoted Request Roundup',
  ]), 2);
});

test('the decision: run on the third email, or at 6:15 PM CT with fewer; never twice', () => {
  assert.deepStrictEqual(E.decide({ now: at('16:45'), editions: 3, ranToday: false }), { run: true, why: 'all 3 HARO emails are in' });
  assert.strictEqual(E.decide({ now: at('17:00'), editions: 2, ranToday: false }).run, false);
  // KNOWN-BAD: one minute before the fallback is still a wait.
  assert.strictEqual(E.decide({ now: at('18:14'), editions: 2, ranToday: false }).run, false);
  const fb = E.decide({ now: at('18:15'), editions: 2, ranToday: false });
  assert.strictEqual(fb.run, true); assert.match(fb.why, /6:15 PM CT fallback: 2 of 3/);
  const err = E.decide({ now: at('18:30'), editions: 0, ranToday: false, countError: 'no key' });
  assert.strictEqual(err.run, true); assert.match(err.why, /could not be counted \(no key\)/);
  assert.strictEqual(E.decide({ now: at('18:15'), editions: 3, ranToday: true }).run, false);
});

test('the mail search can be limited to the Nashville day', () => {
  assert.strictEqual(ma.searchQuery({ match: ['haro'], days: 1 }), 'newer_than:1d {haro}');
  assert.strictEqual(ma.searchQuery({ match: ['haro', 'help a reporter'], days: 1, afterEpoch: 1795586400 }), 'after:1795586400 {haro "help a reporter"}');
});

function harness({ editions = 0, countThrows = null } = {}) {
  const store = createMemoryStore({ lint });
  const runs = [];
  const counted = [];
  const count = async (x) => { counted.push(x.ymd); if (countThrows) throw new Error(countThrows); return editions; };
  const runAgentImpl = async (x) => { runs.push(x); return { ok: true, cards: [{ title: 'Pitch Brides: winter venues, due 11.27.2026' }], unavailable: [] }; };
  return { store, runs, counted, count, runAgentImpl };
}

test('job, switch OFF: nothing is counted and nothing runs', async () => {
  const h = harness({ editions: 3 });
  const lines = [];
  const rc = await main({ argv: [], env: {}, log: (l) => lines.push(l), now: () => at('18:15'), store: h.store, llm: null, count: h.count, runAgentImpl: h.runAgentImpl });
  assert.strictEqual(rc, 0);
  assert.deepStrictEqual([h.counted.length, h.runs.length], [0, 0]);
  assert.match(lines[0], /PATTY_EVENING_RUN is off/);
});

test('job, switch ON: waits on 2 of 3, runs on the third, then never again that day', async () => {
  const h = harness({ editions: 2 });
  const o = { argv: [], env: ON, log: () => {}, store: h.store, llm: null, count: h.count, runAgentImpl: h.runAgentImpl };
  assert.strictEqual(await main({ ...o, now: () => at('16:30') }), 0);
  assert.strictEqual(h.runs.length, 0);
  const h3 = { ...o, count: async () => 3 };
  assert.strictEqual(await main({ ...h3, now: () => at('16:45') }), 0);
  assert.strictEqual(h.runs.length, 1);
  assert.strictEqual(h.runs[0].slug, 'pr-patty');
  assert.strictEqual(h.runs[0].scheduled, true);
  const row = (await h.store.producerDay('2026-11-25')).find((r) => r.agent === 'pr-patty');
  assert.match(row.why, /^evening HARO run: all 3 HARO emails are in; 1 card\(s\)/);
  // Later fires the same day, including the 6:15 fallback, do nothing.
  await main({ ...h3, now: () => at('17:00') });
  await main({ ...o, now: () => at('18:15') });
  assert.strictEqual(h.runs.length, 1);
});

test('job, switch ON: fewer than 3 by 6:15 PM CT runs once; a count failure still runs at 6:15', async () => {
  const h = harness({ editions: 1 });
  await main({ argv: [], env: ON, log: () => {}, now: () => at('18:15'), store: h.store, llm: null, count: h.count, runAgentImpl: h.runAgentImpl });
  assert.strictEqual(h.runs.length, 1);
  const e = harness({ countThrows: 'Gmail answered 403' });
  const lines = [];
  await main({ argv: [], env: ON, log: (l) => lines.push(l), now: () => at('18:15'), store: e.store, llm: null, count: e.count, runAgentImpl: e.runAgentImpl });
  assert.strictEqual(e.runs.length, 1);
  assert.ok(lines.some((l) => /could not be counted \(Gmail answered 403\)/.test(l)));
});

test('the Producer leaves Patty out of the 06:00 run only while the switch is on', async () => {
  const runDay = async (env) => {
    const ran = [];
    await P.runDay({ ymd: '2026-11-25', store: createMemoryStore({ lint }), maxCardsOf: () => 2, draftsWaiting: async () => 0, env,
      runOne: async (a) => { ran.push(a); return { ok: true, cards: [], unavailable: [] }; } });
    return ran;
  };
  assert.ok((await runDay({})).includes('pr-patty'));
  const on = await runDay(ON);
  assert.ok(!on.includes('pr-patty'));
  assert.ok(on.includes('gbp'), 'Google Business still runs');
});

test('agent_run --due --dry leaves Patty out with the switch on, keeps her with it off', async () => {
  const { main: agentRun } = require('../jobs/agent_run');
  const ran = async (env) => {
    const lines = [];
    await agentRun({ argv: ['--due', '--dry', '--date', '2026-11-25'], env, llm: null, log: (l) => lines.push(String(l)), fetchImpl: async () => json(404, {}) });
    return lines;
  };
  const off = await ran({ IHG_TREE: require('os').tmpdir(), BRAIN_SA_KEY: '/nope/key.json' });
  assert.ok(off.some((l) => /^pr-patty: /.test(l)), 'Patty ran (switch off)');
  const on = await ran({ ...ON, IHG_TREE: require('os').tmpdir(), BRAIN_SA_KEY: '/nope/key.json' });
  assert.ok(on.some((l) => /pr-patty: not in this run; her one run is the evening HARO run/.test(l)));
  assert.ok(!on.some((l) => /^pr-patty: (done|FAILED|skipped|waiting)/.test(l)));
});

const GOOD = '### Who\nJane Roe, Brides. Respond: https://app.qwoted.com/r/1\n\n### More context\nWinter venues. Due 11.27.2026.\n\n### What you do\nSend the pitch below by 11.27.2026.\n\nDraft pitch: ...';

test('press cards: a pitch card needs Who, More context and What you do; the summary card is exempt', () => {
  assert.deepStrictEqual(R.pressGaps({ title: 'Pitch Brides: winter venues, due 11.27.2026', body: GOOD }), []);
  assert.deepStrictEqual(R.pressGaps({ title: 'Pitch Brides', body: '### Who\nJane\n\nDraft pitch: hi' }), ['More context', 'What you do']);
  assert.deepStrictEqual(R.pressGaps({ title: 'Press requests, 11.25.2026: 1 to pitch, 19 skipped', body: 'Skipped:\n- x: not our field' }), []);
});

test('PR Patty asks for press cards, reads only today with the switch on, and marks a card missing its headings', async () => {
  const def = R.loadAgent('pr-patty');
  assert.strictEqual(def.press_cards, true);
  assert.ok(def.max_cards >= 6, 'room for one card per fit plus the summary');
  assert.strictEqual(def.sources.find((s) => s.type === 'mail_alerts').today_ct, true);
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const queries = [];
  const fetchImpl = async (u) => {
    if (u.includes('/messages?')) { queries.push(decodeURIComponent(u.split('q=')[1])); return json(200, { messages: [{ id: 'm1' }] }); }
    if (u.includes('/messages/m1')) return json(200, { payload: { headers: [{ name: 'Subject', value: 'HARO Queries - Evening Edition' }, { name: 'From', value: 'HARO <haro@helpareporter.com>' }],
      mimeType: 'text/plain', body: { data: b64('1) Summary: Winter wedding venues\nQuery: Brides wants Nashville venues. Deadline 11.27.2026. Reply: https://app.haro.com/r/1') } } });
    return json(404, {});
  };
  const calls = [];
  const llm = { model: 'test', complete: async (x) => { calls.push(x); return JSON.stringify({ cards: [
    { title: 'Pitch Brides: winter venues, due 11.27.2026', body: '### Who\nJane Roe, Brides.\n\nDraft pitch: hi', seen: { request_id_or_url: 'https://app.haro.com/r/1' } },
    { title: 'Press requests, 11.25.2026: 1 to pitch, 0 skipped', body: 'Requests in this email: 1. Read in full: 1 of 1.' },
  ] }); } };
  const store = createMemoryStore({ lint });
  const r = await R.runAgent({ slug: 'pr-patty', store, llm, env: { ...ON, IHG_TREE: require('os').tmpdir() }, log: () => {}, fetchImpl,
    now: () => at('16:45'), saKey: {}, saToken: async () => 'tok' });
  assert.ok(r.ok, r.error);
  assert.match(calls[0].system, /PRESS CARDS\. Summarize the day's requests, then act/);
  assert.strictEqual(queries[0].split(' ')[0], `after:${E.chicagoMidnightEpoch('2026-11-25')}`);
  const pitch = r.cards.find((c) => /^Pitch Brides/.test(c.title));
  assert.match(pitch.body, /Missing from this card \(code check\):\*\* More context, What you do\./);
  const summary = r.cards.find((c) => /^Press requests, /.test(c.title));
  assert.doesNotMatch(summary.body, /Missing from this card/);
});
