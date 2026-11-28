// ORDER #3817 (Mimi 11.25.2026, popup answering #3807's [RULING]: "B: publish
// live", replacing her 10.09.2026 "Bob drafts into WordPress and never
// publishes"). With BLOG_PUBLISH_ON_APPROVE on, an approved Bloggy Bob card is
// published live on its site; off (the default) it stays an unpublished draft.
// The same gates as Approve must pass first, or nothing is published and the
// card says why.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const WP = require('../lib/wp-publish');
const { handoff, createMemoryStore } = require('../jobs/agent_handoff');
const { actionLine } = require('../lib/card-action');
const { approveWill } = require('../lib/approve-will');
const EX = require('../lib/executioner');

const ON = { BLOG_PUBLISH_ON_APPROVE: 'on' };
const OFF = {};
const login = () => ({ user: 'brain@infinityhospitality.net', pass: 'x' });
const REGISTER = fs.readFileSync(path.join(__dirname, 'fixtures', 'claims_register', '07_Marketing_and_Brand', 'Claims_Register_11.18.2026.md'), 'utf8');

const POST = { site: 'saddlewoodsfarm.com', title: 'Fall weddings at the farm',
  content_md: '# Fall weddings at the farm\n\nOctober light makes the barn glow.\n\nWe can host your ceremony on the lawn and your dinner in the Pavilion.' };

// A fake WordPress: create -> draft; publish (POST /posts/<id> status publish) -> publish.
function fakeWp({ publishCode = 200, readAfterPublish = 'publish' } = {}) {
  const calls = [];
  let published = false;
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method || 'GET', body });
    if (/\/wp\/v2\/posts$/.test(url)) return { status: 201, text: async () => JSON.stringify({ id: 77, status: 'draft' }) };
    if (/\/wp\/v2\/posts\/77$/.test(url) && opts.method === 'POST') {
      if (publishCode !== 200) return { status: publishCode, text: async () => JSON.stringify({ code: 'rest_cannot_publish', message: 'Sorry' }) };
      published = true;
      return { status: 200, text: async () => JSON.stringify({ id: 77, status: 'publish' }) };
    }
    return { status: 200, text: async () => JSON.stringify({ id: 77, status: published ? readAfterPublish : 'draft', link: 'https://saddlewoodsfarm.com/fall-weddings-at-the-farm/' }) };
  };
  return { calls, fetchImpl };
}

async function approvedBob(store, post = POST, body = 'Card text.') {
  const c = await store.insert({ agent: 'bloggy-bob', agent_name: 'Bloggy Bob', job: 'blog draft', title: 'Draft: Fall weddings', body, payload: { post } });
  await store.decide(c.id, { action: 'approve', who: 'k@x' });
  return c;
}

const { lint } = require('../lib/ai-tells');
const store = () => createMemoryStore({ lint });
// A card approved before a rule tightened (or edited around the check): the
// store's Approve check lets it through, so only the publish gate stands.
const laxStore = () => createMemoryStore({ lint: () => ({ fails: [], flags: [] }) });

const run = (store, env, w, extra = {}) => handoff({ store, fetchImpl: w.fetchImpl, login, env, log: () => {}, register: REGISTER, ...extra });

test('switch ships OFF: approved card is an unpublished draft, no publish call, the card says so', async () => {
  assert.strictEqual(WP.on({}), false);
  assert.strictEqual(WP.on({ BLOG_PUBLISH_ON_APPROVE: 'yes' }), false);
  assert.strictEqual(WP.on(ON), true);
  const s = store(); const w = fakeWp();
  const c = await approvedBob(s);
  await run(s, OFF, w);
  assert.ok(!w.calls.some((x) => x.body && x.body.status === 'publish'), 'no publish while off');
  const h = (await s.get(c.id)).handoff;
  assert.strictEqual(h.ok, true); assert.strictEqual(h.status, 'draft'); assert.ok(!h.published);
  const line = actionLine({ ...c, status: 'draft' }, OFF).line;
  assert.match(line, /unpublished WordPress draft/);
});

test('switch ON: approved card is published live, read back, and the card carries the live URL', async () => {
  const s = store(); const w = fakeWp();
  const c = await approvedBob(s);
  await run(s, ON, w);
  const pub = w.calls.filter((x) => x.body && x.body.status === 'publish');
  assert.strictEqual(pub.length, 1, 'exactly one publish');
  assert.match(pub[0].url, /\/wp-json\/wp\/v2\/posts\/77$/, 'publishes the draft this card just made, by id');
  const h = (await s.get(c.id)).handoff;
  assert.strictEqual(h.published, true);
  assert.strictEqual(h.status, 'publish');
  assert.strictEqual(h.live_link, 'https://saddlewoodsfarm.com/fall-weddings-at-the-farm/');
  assert.strictEqual(h.link, h.live_link, 'the Executioner link is the live URL');
  const card = await s.get(c.id);
  const l = EX.cardLine(card);
  assert.match(l.line, /^Published live /);
  assert.strictEqual(l.link, h.live_link);
});

test('switch ON: the action line reads "Publish this blog live on <site>"', () => {
  const card = { agent: 'bloggy-bob', status: 'draft', title: 'Draft: x', payload: { post: POST } };
  assert.match(actionLine(card, ON).line, /^Publish this blog live on saddlewoodsfarm\.com/);
  assert.doesNotMatch(actionLine(card, ON).line, /unpublished/);
  assert.match(approveWill(card, ON).line, /publish it live on saddlewoodsfarm\.com/);
  assert.match(approveWill(card, OFF).line, /unpublished WordPress draft/);
});

test('KNOWN-BAD gates: each failing gate means no publish, the draft stays, and the card says why', async () => {
  const cases = [
    ['an em dash', { ...POST, content_md: POST.content_md + '\n\nThe barn — our favorite.' }, 'Card text.', /em dash/],
    ['a dollar figure', { ...POST, content_md: POST.content_md + '\n\nPackages start at $4,500.' }, 'Card text.', /dollar/],
    ['a capacity number', { ...POST, content_md: POST.content_md + '\n\nThe Pavilion seats up to 300 guests.' }, 'Card text.', /capacity/],
    ['a Fact-Checker UNVERIFIED claim', POST, 'Card text.\n\n### Not checked this run\n\n- UNVERIFIED: x (https://a.example/): quote not found', /Fact-Checker/],
    ['an unregistered provenance claim', { ...POST, content_md: POST.content_md + '\n\nOurs is the oldest barn venue in Tennessee.' }, 'Card text.', /claims register/],
  ];
  for (const [name, post, body, why] of cases) {
    const s = laxStore(); const w = fakeWp();
    const c = await approvedBob(s, post, body);
    await run(s, ON, w);
    assert.ok(!w.calls.some((x) => x.body && x.body.status === 'publish'), `${name}: never published`);
    const h = (await s.get(c.id)).handoff;
    assert.strictEqual(h.ok, true, `${name}: the draft is still saved`);
    assert.strictEqual(h.published, false, name);
    assert.match(h.publish_why, why, name);
    assert.match(EX.cardLine(await s.get(c.id)).line, /not published/i, name);
  }
});

test('a provenance claim the register marks TRUE passes the claims-register gate', () => {
  const ok = WP.publishGate({ title: 't', body: 'b', payload: { post: { ...POST, content_md: 'The Pavilion was built by skilled Pennsylvania Amish craftsmen, and it shows.' } } }, { register: REGISTER });
  assert.deepStrictEqual(ok.filter((x) => /claims register/.test(x)), []);
});

test('KNOWN-BAD: no claims register readable means no publish (fail closed)', () => {
  const why = WP.publishGate({ title: 't', body: 'b', payload: { post: POST } }, { register: null });
  assert.ok(why.some((x) => /claims register could not be read/.test(x)), why.join('; '));
});

test('KNOWN-BAD: WordPress refuses the publish, or reads back not live: still a draft, card says why, no retry', async () => {
  for (const [w, re] of [[fakeWp({ publishCode: 403 }), /WordPress refused/], [fakeWp({ readAfterPublish: 'draft' }), /ALARM/]]) {
    const s = store();
    const c = await approvedBob(s);
    await run(s, ON, w);
    const h = (await s.get(c.id)).handoff;
    assert.strictEqual(h.ok, true); assert.strictEqual(h.published, false); assert.match(h.publish_why, re);
    const n = w.calls.length;
    await run(s, ON, w);
    assert.strictEqual(w.calls.length, n, 'a handed-off card is never taken again');
  }
});

test('publishDraft refuses with the switch off, before any network call', async () => {
  const w = fakeWp();
  const r = await WP.publishDraft({ site: 'saddlewoodsfarm.com', id: 77, env: OFF, fetchImpl: w.fetchImpl, login });
  assert.strictEqual(r.ok, false); assert.strictEqual(w.calls.length, 0);
});

test('THE FENCE: lib/wp-publish.js sets one status in one place, only on an existing post id, and nothing else', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wp-publish.js'), 'utf8');
  for (const bad of ["'future'", "'private'", "'pending'", "'trash'", 'DELETE', "method: 'PUT'", "method: 'PATCH'", 'force=true', "'draft'"]) {
    assert.ok(!src.includes(bad), `wp-publish.js must not contain ${bad}`);
  }
  assert.match(src, /const PUBLISH = 'publish';/);
  assert.strictEqual((src.match(/status: PUBLISH/g) || []).length, 1, 'exactly one place sets the status');
  assert.ok(!/wp\/v2\/posts`/.test(src), 'never calls the create endpoint');
  // The draft fence is unchanged: lib/wp-draft.js still cannot publish.
  const draft = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wp-draft.js'), 'utf8');
  assert.ok(!draft.includes("'publish'") && !draft.includes('"publish"'));
});
