// ORDER #3495: Pinterest per-venue (#3164) adds the 4 brand accounts, so all 11
// of our Pinterest accounts have a row. Fake client only: nothing here reaches Pinterest.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PV = require('../lib/pinterest-venues');
const pt = require('../lib/pinterest');
const pc = require('../lib/pinterest-connect');
const { createPinterestRouter } = require('../routes/pinterest');

const ON = { PINTEREST_PER_VENUE: 'on', PINTEREST_APP_ID: 'app' };
const res = (status, body) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body), json: async () => body });
const SECRET_DEC = 'fake-refresh-dec-0004';
const SECRET_NEW = 'fake-refresh-dd-0005';

test('all 11 accounts have a row: the 7 canonical venues first, then the 4 brand accounts', () => {
  assert.strictEqual(PV.ACCOUNTS.length, 11);
  assert.deepStrictEqual(PV.VENUES.map((v) => v.code), ['TBB', 'TBT', 'ECD', 'SWF', 'STE', 'COR', 'EST']);
  assert.deepStrictEqual(PV.ACCOUNTS.slice(0, 7), PV.VENUES);
  // #3506 (Mimi 11.17.2026, "IH as a group"): the 4th is Infinity Hospitality Group.
  assert.deepStrictEqual(PV.BRANDS.map((b) => b.code), ['DEC', 'NLP', 'DD', 'IHG']);
  assert.deepStrictEqual(PV.BRANDS.map((b) => b.name), ['Dream Events & Catering', 'Nashville Lighting and Production', 'DailyDish',
    'Infinity Hospitality Group']);
});

test('the brand rows are labelled as brands, never as venues; no brand code is a venue code', () => {
  for (const b of PV.BRANDS) assert.strictEqual(b.brand, true, b.name);
  for (const v of PV.VENUES) assert.ok(!v.brand, v.code);
  const venueCodes = new Set(PV.VENUES.map((v) => v.code));
  for (const b of PV.BRANDS) assert.ok(!venueCodes.has(b.code), b.code);
  // The codes are the ones the dashboard already uses for these brands (lib/competitor-profiles.js).
  const { BRAND_NAMES } = require('../lib/competitor-profiles');
  for (const b of PV.BRANDS.filter((x) => x.code)) assert.strictEqual(BRAND_NAMES[b.code], b.name, b.code);
  // Brand sites are pages Paul may pin.
  for (const b of PV.BRANDS.filter((x) => x.site)) assert.ok(pt.OUR_SITES.includes(b.site), b.site);
});

test('the 4th account is Infinity Hospitality Group (#3506), never Nashville Event Bartending; shared sites offer it first', () => {
  const fourth = PV.BRANDS[3];
  assert.ok(!fourth.unconfirmed);
  assert.strictEqual(fourth.code, 'IHG');
  assert.strictEqual(fourth.shared, true);
  assert.strictEqual(PV.byCode('NEB'), null);
  assert.strictEqual(PV.byCode('IHG'), fourth);
  assert.strictEqual(PV.byCode(null), null);
  assert.deepStrictEqual(PV.venueForLink('https://nashvilleeventbartending.com/blog/x/'), { pick: true, offer: 'IHG' });
  assert.deepStrictEqual(PV.venueForLink('https://infinityhospitalitygroup.com/blog/x/'), { pick: true, offer: 'IHG' });
});

test('a post on a brand site offers that brand account; Keychain names follow pinterest-refresh-token-<code>', () => {
  assert.deepStrictEqual(PV.venueForLink('https://dreameventsandcatering.com/blog/menu/'), { venue: 'DEC' });
  assert.deepStrictEqual(PV.venueForLink('https://www.dailydishcatering.com/blog/box-lunch/'), { venue: 'DD' });
  assert.deepStrictEqual(PV.venueForLink('https://nashvillelightingandproduction.com/blog/uplighting/'), { venue: 'NLP' });
  assert.strictEqual(PV.tokenItem('DEC'), 'pinterest-refresh-token-dec');
  assert.strictEqual(PV.tokenItem('DD'), 'pinterest-refresh-token-dd');
  assert.strictEqual(PV.tokenItem('NLP'), 'pinterest-refresh-token-nlp');
  // The canonical venues still route as #3164 built them.
  assert.deepStrictEqual(PV.venueForLink('https://saddlewoodsfarm.com/blog/x/'), { venue: 'SWF' });
});

test('Connected counts all 11 accounts', () => {
  const rows = [{ venue: 'SWF', connected: true }, { venue: 'DEC', connected: true }, { venue: 'NEB', connected: true }];
  assert.deepStrictEqual(PV.connectedLine(rows), { connected: 2, total: 11, line: 'Connected: 2 of 11 accounts', page: '/settings/pinterest' });
});

test('a brand connect is traded like a venue one, and no token is in any log or anything the dashboard reads', async () => {
  const accounts = PV.createMemoryAccounts();
  const state = PV.newState('DD');
  assert.match(state, /^DD\.[0-9a-f]{36}$/);
  await accounts.addConnect({ state, venue: 'DD', who: 'khowe@infinityhospitality.net', redirectUri: 'https://m/cb' });
  await accounts.setCode(state, 'good');
  const kc = { 'pinterest-app-id': 'app', 'pinterest-app-secret': 'sec', 'pinterest-refresh-token-dec': SECRET_DEC };
  const fetchImpl = async (u, o = {}) => {
    if (u.endsWith('/oauth/token')) {
      const b = String(o.body || '');
      if (b.includes('grant_type=authorization_code')) return res(200, { access_token: 'x', refresh_token: SECRET_NEW });
      return res(200, { access_token: b.includes(SECRET_DEC) ? 'tok-dec' : 'tok-dd' });
    }
    if (u.includes('/boards')) return res(200, { items: [{ id: 'b1', name: o.headers.Authorization === 'Bearer tok-dec' ? 'Dream Menus' : 'Box Lunches' }], bookmark: null });
    return res(404, {});
  };
  const lines = [];
  const out = await pc.syncAccounts({ accounts, fetchImpl, secrets: (n) => kc[n] || null, save: (item, v) => { kc[item] = v; }, log: (l) => lines.push(l) });
  assert.deepStrictEqual(out, { traded: 1, connected: 2, total: 11 });
  assert.strictEqual(kc['pinterest-refresh-token-dd'], SECRET_NEW);
  const list = await accounts.list();
  assert.deepStrictEqual(list.filter((a) => a.connected).map((a) => a.venue).sort(), ['DD', 'DEC']);
  assert.ok(!list.some((a) => a.venue === null || a.venue === 'NEB'), 'no row for an account we do not have');
  const visible = JSON.stringify(list) + JSON.stringify(await accounts.recentConnects()) + lines.join('\n');
  for (const s of [SECRET_DEC, SECRET_NEW]) assert.ok(!visible.includes(s), 'a token leaked');
});

test('Pinterest\'s own refusal text comes back to the page', async () => {
  const accounts = PV.createMemoryAccounts();
  const state = PV.newState('NLP');
  await accounts.addConnect({ state, venue: 'NLP', who: 'khowe@infinityhospitality.net', redirectUri: 'https://m/cb' });
  await accounts.setCode(state, 'refused');
  const fetchImpl = async () => res(403, { message: 'Your app is in trial access and cannot be authorized by this user.' });
  await pc.syncAccounts({ accounts, fetchImpl, secrets: (n) => ({ 'pinterest-app-id': 'app', 'pinterest-app-secret': 'sec' }[n] || null), save: () => {}, log: () => {} });
  const done = (await accounts.recentConnects()).find((c) => c.venue === 'NLP');
  assert.match(done.outcome, /Pinterest refused the approval: Your app is in trial access and cannot be authorized by this user\./);
});

function call(router, { method, url, body }) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {}, query: Object.fromEntries(new URL('http://x' + url).searchParams), body: body || {}, params: {},
      mktUser: { email: 'khowe@infinityhospitality.net' } };
    const out = { statusCode: 200, headers: {} };
    const resObj = {
      status(c) { out.statusCode = c; return resObj; },
      json(j) { out.body = j; resolve(out); },
      send(s) { out.body = s; resolve(out); },
      sendFile(f) { out.file = f; resolve(out); },
      redirect(u) { out.statusCode = 302; out.location = u; resolve(out); },
      setHeader() {}, getHeader() {},
    };
    router.handle(req, resObj, () => resolve({ statusCode: 404 }));
  });
}

test('the accounts API lists 11 rows, brand rows marked; IHG can be connected, NEB cannot (#3506)', async () => {
  const accounts = PV.createMemoryAccounts();
  const r = createPinterestRouter({ accounts, store: null, env: ON });
  const got = await call(r, { method: 'GET', url: '/api/pinterest/accounts' });
  assert.strictEqual(got.body.venues.length, 11);
  assert.strictEqual(got.body.total, 11);
  const fourth = got.body.venues[10];
  assert.strictEqual(fourth.brand, true); assert.strictEqual(fourth.unconfirmed, false); assert.strictEqual(fourth.code, 'IHG');
  assert.deepStrictEqual(got.body.venues.filter((v) => v.brand).map((v) => v.code), ['DEC', 'NLP', 'DD', 'IHG']);
  const neb = await call(r, { method: 'POST', url: '/api/pinterest/connect/NEB' });
  assert.strictEqual(neb.statusCode, 404);
  const ihg = await call(r, { method: 'POST', url: '/api/pinterest/connect/IHG' });
  assert.match(ihg.body.url, /state=IHG\.[0-9a-f]{36}/);
  const dd = await call(r, { method: 'POST', url: '/api/pinterest/connect/DD' });
  assert.match(dd.body.url, /state=DD\.[0-9a-f]{36}/);
  // A two-letter brand code comes back through the callback.
  const state = new URL(dd.body.url).searchParams.get('state');
  const back = await call(r, { method: 'GET', url: `/settings/pinterest/callback?state=${state}&code=abc` });
  assert.strictEqual(back.location, '/settings/pinterest?result=waiting&venue=DD');
  // Pinterest's own words when it refuses on its approval page.
  const no = await call(r, { method: 'GET', url: '/settings/pinterest/callback?error=access_denied&error_description=App%20is%20in%20trial%20access' });
  assert.strictEqual(no.location, '/settings/pinterest?result=declined&why=App%20is%20in%20trial%20access');
});

test('the Connect page carries the Trial access line, shows Pinterest\'s refusal text, and labels brands', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'pinterest-accounts.html'), 'utf8');
  assert.match(page, /Trial access/);
  assert.match(page, /may be refused/);
  assert.match(page, /Pinterest said: /);
  assert.match(page, /q\.get\('why'\)/);
  assert.match(page, /Brand/);
  assert.match(page, /unconfirmed/);
  void os;
});
