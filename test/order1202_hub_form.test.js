'use strict';

// ORDER #1202: #1198's form tests (venue-hub 902f051, test/form.test.js),
// ported to hub/. Skeleton fields + event type + hidden fields, submitted to
// sandbox 51163869 only, carrying hutk + pageUri, nothing stored.
// CHANGED from #1198: the portal now comes from env VENUE_HUB_HUBSPOT_PORTAL
// with no default, and prod refuses to START the hub (the order's item 3).

const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./order1202_hub_helpers');
const hubspot = require('../hub/hubspot');
const { load } = require('../hub/config');
const { createApp } = require('../hub/app');

const GUID = '11111111-2222-3333-4444-555555555555';
const SANDBOX = { hubspotPortal: '51163869', hubspotFormGuid: GUID };

function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status < 300, status };
  };
  fn.calls = calls;
  return fn;
}

const LEAD = new URLSearchParams([
  ['firstname', 'Test'], ['lastname', 'Person'], ['email', 'test@example.com'], ['phone', '555-0100'],
  ['event_type', 'Wedding'], ['event_date', 'May 2027'], ['guest_count', '100–150'],
  ['venues', 'SWF'], ['venues', 'TBT'], ['venues', 'XXX'], ['message', 'hello'],
  ['theme', 'garden'], ['style', 'compare'], ['landing_page', '/garden/b'],
  ['utm_source', 'meta'], ['utm_campaign', 'spring garden'], ['gclid', 'abc-123'], ['fbclid', 'fb.1'],
]);
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

test('the form carries the skeleton fields, event type and every hidden field', async () => {
  const app = await start();
  try {
    const html = await (await app.get('/garden/b?utm_source=meta&utm_medium=paid&utm_campaign=spring&utm_content=v1&gclid=G1&fbclid=F1')).text();
    for (const name of ['firstname', 'lastname', 'email', 'phone', 'event_type', 'event_date', 'guest_count', 'venues', 'venue_unsure', 'message']) {
      assert.match(html, new RegExp(`name="${name}"`), name);
    }
    for (const [k, v] of [['theme', 'garden'], ['style', 'compare'], ['landing_page', '/garden/b'], ['utm_source', 'meta'], ['utm_medium', 'paid'], ['utm_campaign', 'spring'], ['utm_content', 'v1'], ['gclid', 'G1'], ['fbclid', 'F1']]) {
      assert.match(html, new RegExp(`type="hidden" name="${k}" value="${v.replace('/', '\\/')}"`), k);
    }
    assert.match(html, /Wedding date/);
    // The theme page offers only its fitting venues.
    assert.ok(html.includes('value="SWF"') && !html.includes('value="TBB"'));
  } finally {
    await app.close();
  }
});

test('a non-wedding theme shows event labels, not "wedding date"', async () => {
  const { THEMES } = require('../hub/data/themes');
  const themes = structuredClone(THEMES);
  const corp = themes.find((t) => t.slug === 'corporate');
  corp.status = 'preview';
  corp.venues = [{ code: 'TBT', fit: 'x' }];
  const app = await start({ themes });
  try {
    const html = await (await app.get('/corporate')).text();
    assert.match(html, /Event date/);
    assert.ok(!html.includes('Wedding date'));
    assert.match(html, /<option selected>Corporate<\/option>/);
  } finally {
    await app.close();
  }
});

test('a submit goes to the sandbox form with hutk + pageUri and redirects to /thanks', async () => {
  const f = fakeFetch(200);
  const app = await start({ fetch: f, config: SANDBOX });
  try {
    const res = await app.get('/inquire', {
      method: 'POST',
      headers: { ...FORM, cookie: 'hubspotutk=abc123def' },
      body: LEAD.toString(),
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/thanks');
    assert.equal(f.calls.length, 1);
    const { url, body } = f.calls[0];
    assert.equal(url, `https://api.hsforms.com/submissions/v3/integration/submit/51163869/${GUID}`);
    assert.equal(body.context.hutk, 'abc123def');
    assert.equal(body.context.pageUri, 'https://nashvilleweddingvenue.com/garden/b?utm_source=meta&utm_campaign=spring_garden&gclid=abc-123&fbclid=fb.1');
    const got = Object.fromEntries(body.fields.map((x) => [x.name, x.value]));
    assert.equal(got.venue_s_, 'SWF;TBT', 'unknown venue codes are dropped');
    assert.equal(got.hub_theme, 'garden');
    assert.equal(got.hub_style, 'compare');
    assert.equal(got.utm_source, 'meta');
    assert.equal(got.hub_gclid, 'abc-123');
    assert.equal(got.event_type, 'Wedding');
  } finally {
    await app.close();
  }
});

test('KNOWN-BAD: production portal 49701209 is refused in code, and the hub will not start on it', async () => {
  assert.throws(() => hubspot.assertSandbox('49701209'), /49701209 is refused/);
  assert.throws(() => hubspot.assertSandbox('12345'), /only sandbox/);
  const f = fakeFetch();
  await assert.rejects(hubspot.submit({ portalId: '49701209', formGuid: GUID, payload: {}, fetchImpl: f }));
  assert.equal(f.calls.length, 0);
  // From env: prod, or any portal that is not the sandbox, refuses to start.
  assert.throws(() => createApp({ config: load({ VENUE_HUB_HUBSPOT_PORTAL: '49701209' }) }), /49701209 is refused/);
  assert.throws(() => createApp({ config: load({ VENUE_HUB_HUBSPOT_PORTAL: '12345' }) }), /only sandbox/);
  // No default: with nothing set the portal is empty, never prod.
  assert.equal(load({}).hubspotPortal, '');
  assert.equal(load({ VENUE_HUB_HUBSPOT_PORTAL: '51163869' }).hubspotPortal, '51163869');
});

test('with no form GUID or no portal set, nothing is sent and the visitor is told plainly', async () => {
  for (const config of [{ hubspotPortal: '51163869' }, { hubspotFormGuid: GUID }]) {
    const f = fakeFetch();
    const app = await start({ fetch: f, config });
    try {
      const res = await app.get('/inquire', { method: 'POST', headers: FORM, body: LEAD.toString() });
      assert.equal(res.status, 503, JSON.stringify(config));
      assert.equal(f.calls.length, 0);
    } finally {
      await app.close();
    }
  }
});

test('a tampered theme, style or landing page is not passed through', async () => {
  const f = fakeFetch();
  const app = await start({ fetch: f, config: SANDBOX });
  try {
    const bad = new URLSearchParams(LEAD);
    bad.set('theme', 'industrial'); // a draft
    bad.set('style', '<x>');
    bad.set('landing_page', 'https://evil.example/');
    await app.get('/inquire', { method: 'POST', headers: FORM, body: bad.toString() });
    const got = Object.fromEntries(f.calls[0].body.fields.map((x) => [x.name, x.value]));
    assert.equal(got.hub_theme, undefined);
    assert.equal(got.hub_style, undefined);
    assert.equal(got.hub_landing_page, '/');
  } finally {
    await app.close();
  }
});

test('a missing name or bad email is bounced without a send', async () => {
  const f = fakeFetch();
  const app = await start({ fetch: f, config: SANDBOX });
  try {
    const bad = new URLSearchParams(LEAD);
    bad.set('email', 'not-an-email');
    const res = await app.get('/inquire', { method: 'POST', headers: FORM, body: bad.toString() });
    assert.equal(res.status, 400);
    assert.equal(f.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('no lead is stored: the hub source has no file, db or log write of the body', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['app.js', 'hubspot.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'hub', f), 'utf8');
    assert.ok(!/writeFile|appendFile|createWriteStream|console\.log|require\('pg'\)|sqlite/.test(src), f);
  }
});

test('ad conversions (Pixel / CAPI / uploads) are OFF', () => {
  assert.equal(load({ AD_CONVERSIONS: '1', VENUE_HUB_AD_CONVERSIONS: '1' }).adConversions, false);
});
