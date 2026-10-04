'use strict';
// ORDER #1241: the /photos page, end to end.
//
// The #1008 acceptance list, driven through a real Express app carrying THE REAL
// #654 page gate and the real routes/photos.js, over a real socket. Only the
// edges are stand-ins: an in-memory store with the #1239 table shapes, and a
// dispatch identity answer. No supertest: it is not a dependency of this repo,
// and adding one moves package.json. The node:http harness is #661's.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.PUBLIC_BASE_URL = 'https://marketing.infinityhospitalitygroup.com';
process.env.DISPATCH_BRIDGE_URL = 'https://dispatch.infinityhospitalitygroup.com';
process.env.JWT_SECRET = 'marketing-test-secret-not-real';

const { pageGate } = require('../middleware/page-gate');
const { BOUNCE_MARKER } = require('../lib/sso');
const { createPhotosRouter, effectiveRights } = require('../routes/photos');
const { vocabSeed } = require('../lib/photo-schema');
const { createIdentityClient } = require('../lib/staff-identity');
const { createPgStore, EDIT_SQL } = require('../lib/photo-store');
const { rowsByDealId } = require('../lib/photo-sheet-rule');
const { VENUES_DEFAULT } = require('../lib/photo-config');

// ------------------------------------------------------------- fixtures

const P = (id, folder, extra = {}) => ({
  drive_id: id, name: `${id}.jpg`, kind: 'image', folder_path: folder, brand: 'IH', venue: null, space: null,
  event_type: null, event_class: null, setup: null, guest_band: null, deal_id: null, manual_internal: false,
  rights_reason: null, taken_date: '2024-06-10', month: 'June', season: 'summer', year: 2024,
  orientation: 'landscape', width: 4000, height: 3000, has_thumb: true, ...extra,
});

function fixture() {
  const photos = [
    P('p1', 'Venues / TBT / Patio / Wedding Reception', { venue: 'TBT', space: 'Patio', season: 'fall', event_class: 'wedding' }),
    P('p2', 'Venues / ECD / Sunset Terrace', { venue: 'ECD', space: 'Sunset Terrace', event_class: 'wedding', deal_id: '333' }),
    P('p3', 'Venues / TBT / Patio', { venue: 'TBT', space: 'Patio', event_class: 'wedding', manual_internal: true }),
    P('p4', 'NLP / Corporate', { brand: 'NLP', venue: 'TBB', event_type: 'Corporate', event_class: 'corporate' }),
    P('p5', 'NLP / Corporate', { brand: 'NLP', venue: 'TBT', event_class: 'corporate' }),
    P('p6', 'NLP / Corporate', { brand: 'NLP', venue: 'TBB', event_class: 'corporate' }),
    P('p7', 'Venues / SWF', { venue: 'SWF', name: 'media wall test.jpg' }),
    P('staff1', 'Staff Photos / 2024', { venue: 'TBT', space: 'Patio' }),
    P('p9', 'Venues / ECD / Ballroom', { venue: 'ECD', space: 'Ballroom', deal_id: '111' }),
  ];
  const ai = (drive_id, tag) => ({ drive_id, tag, source: 'ai', confidence: 0.9 });
  const tags = [
    ai('p1', 'string lights'), ai('p1', 'long tables'), ai('p2', 'string lights'), ai('p3', 'string lights'),
    ai('p4', 'stage'), ai('p4', 'led wall'), ai('p5', 'stage and band'), ai('p6', 'step-and-repeat'),
    ai('staff1', 'string lights'),
    ai('p9', 'string lights'), { drive_id: 'p9', tag: 'string lights', source: 'human_remove', who: 'person:k' },
  ];
  const { tags: v, syns } = vocabSeed();
  return { photos, tags, vocabRows: v.map(([tag, grp]) => ({ tag, grp })), synonymRows: syns.map(([word, tag]) => ({ word, tag })) };
}

// The #1239 tables, in memory, with the store's write semantics.
function memoryStore(data = fixture()) {
  const writes = [];
  return {
    data, writes,
    async loadIndex() { return JSON.parse(JSON.stringify(data)); },
    async getThumb(id) {
      const p = data.photos.find((x) => x.drive_id === id && !/^staff photos/i.test(x.folder_path));
      return p && p.has_thumb ? Buffer.from(`JPEG:${id}`) : null;
    },
    async editTag(id, action, tag, who) {
      writes.push({ id, action, tag, who });
      const undo = action === 'add' ? 'human_remove' : 'human_add';
      const src = action === 'add' ? 'human_add' : 'human_remove';
      data.tags = data.tags.filter((t) => !(t.drive_id === id && t.source === undo && t.tag.toLowerCase() === tag.toLowerCase()));
      if (!data.tags.some((t) => t.drive_id === id && t.source === src && t.tag === tag)) data.tags.push({ drive_id: id, tag, source: src, who });
    },
    async setInternal(id, internal, who) {
      writes.push({ id, internal, who });
      const p = data.photos.find((x) => x.drive_id === id);
      p.manual_internal = internal;
      return true;
    },
  };
}

// Katherine's sheet, two tabs, keyed by DEALID only.
const SHEET = [
  { title: 'IH - 2024', values: [
    ['', 'Event Name', 'Venue', 'Cool with using photos on socials/sales materials?', 'Notes', 'DEALID'],
    ['JUNE'],
    ['', '06.10.24 ECD Sample Wedding', 'ECD', 'YES', '', '333'],
    ['', '06.11.24 ECD Other Wedding', 'ECD', 'NO', '', '111'],
  ] },
];

const PEOPLE = {
  'exec@x': { active: true, person_id: 'e1', rung: 3, bundle: 'Exec', surface_access: { 'marketing.dashboard': true, 'marketing.photos': true } },
  'katherine@x': { active: true, person_id: 'k1', rung: 2, bundle: 'Marketing', surface_access: { 'marketing.dashboard': true, 'marketing.photos': true } },
  'sales@x': { active: true, person_id: 's1', rung: 2, bundle: 'Sales', surface_access: { 'marketing.dashboard': false, 'marketing.photos': true } },
  'chef@x': { active: true, person_id: 'c1', rung: 1, bundle: 'Chef', surface_access: { 'marketing.dashboard': false, 'marketing.photos': false } },
};
const identity = { lookup: async (email) => PEOPLE[email] || { active: false, surface_access: {} } };

function app(store = memoryStore(), opts = {}) {
  const a = express();
  a.use(express.json());
  a.use(pageGate);
  a.use(createPhotosRouter({ store, identity, sheet: async () => SHEET, cacheMs: 0, log: () => {}, ...opts }));
  a.use((req, res) => res.status(200).send('FELL THROUGH'));
  return a;
}

function serve(a, t) {
  return new Promise((resolve) => {
    const s = http.createServer(a).listen(0, () => { t.after(() => new Promise((r) => s.close(r))); resolve(s); });
  });
}
function call(server, urlPath, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString(), json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const as = (email) => ({ Cookie: `mkt_session=${jwt.sign({ role: 'sso', email }, process.env.JWT_SECRET)}` });
const ids = (r) => r.json.results.map((p) => p.id).sort();

// ------------------------------------------------------------- the acceptance list

test('ACCEPTANCE: "string lights" returns photos from more than one venue', async (t) => {
  const s = await serve(app(), t);
  const r = await call(s, '/api/photos?q=string%20lights', { headers: as('sales@x') });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(ids(r), ['p1', 'p2', 'p3']);
  assert.ok(new Set(r.json.results.map((p) => p.venue)).size > 1);
});

test('ACCEPTANCE: TBT + Patio + fall narrows correctly', async (t) => {
  const s = await serve(app(), t);
  const r = await call(s, '/api/photos?q=string%20lights&venue=TBT&space=Patio&season=fall', { headers: as('sales@x') });
  assert.deepStrictEqual(ids(r), ['p1']);
  assert.deepStrictEqual(r.json.facets.season, { fall: 1, summer: 1 }, 'each facet counts with the OTHER filters on');
});

test('ACCEPTANCE: "stage" + corporate returns photos from more than one venue', async (t) => {
  const s = await serve(app(), t);
  const r = await call(s, '/api/photos?q=stage&event_class=corporate', { headers: as('sales@x') });
  assert.deepStrictEqual(ids(r), ['p4', 'p5']);
  assert.ok(new Set(r.json.results.map((p) => p.venue)).size > 1);
});

test('ACCEPTANCE: "step and repeat" and "media wall" return the same set', async (t) => {
  const s = await serve(app(), t);
  const a = await call(s, '/api/photos?q=step%20and%20repeat', { headers: as('sales@x') });
  const b = await call(s, '/api/photos?q=media%20wall', { headers: as('sales@x') });
  assert.deepStrictEqual(ids(a), ids(b));
  assert.deepStrictEqual(ids(a), ['p6', 'p7']);
});

test('ACCEPTANCE: Staff Photos never appears: not in search, not as a photo, not as a thumbnail', async (t) => {
  const s = await serve(app(), t);
  const all = await call(s, '/api/photos?limit=100', { headers: as('exec@x') });
  assert.ok(!ids(all).includes('staff1'));
  const lights = await call(s, '/api/photos?q=string%20lights&venue=TBT&space=Patio', { headers: as('exec@x') });
  assert.ok(!ids(lights).includes('staff1'));
  assert.strictEqual((await call(s, '/api/photos/staff1', { headers: as('exec@x') })).status, 404);
  assert.strictEqual((await call(s, '/photos/thumb/staff1', { headers: as('exec@x') })).status, 404);
});

test('ACCEPTANCE: an internal-only photo, or one with the unknown default, offers no download', async (t) => {
  const s = await serve(app(), t);
  const internal = (await call(s, '/api/photos/p3', { headers: as('sales@x') })).json;
  assert.strictEqual(internal.rights.state, 'internal_only');
  assert.strictEqual(internal.download_url, null);
  assert.strictEqual(internal.share_url, null);
  assert.strictEqual(internal.rights.badge, "Internal only, don't send to clients");
  const unknown = (await call(s, '/api/photos/p1', { headers: as('sales@x') })).json;
  assert.strictEqual(unknown.rights.state, 'unknown', 'a Venues photo with no event link is unknown at launch');
  assert.strictEqual(unknown.download_url, null);
  assert.strictEqual(unknown.share_url, null);
  assert.strictEqual(unknown.rights.badge, 'Check with marketing');
  assert.ok(unknown.drive_url, 'Open in Drive is always offered');
  const sheetNo = (await call(s, '/api/photos/p9', { headers: as('sales@x') })).json;
  assert.strictEqual(sheetNo.rights.state, 'internal_only', 'the sheet says NO for DEALID 111');
  assert.strictEqual(sheetNo.download_url, null);
  const cleared = (await call(s, '/api/photos/p2', { headers: as('sales@x') })).json;
  assert.strictEqual(cleared.rights.state, 'cleared', 'the sheet says YES for DEALID 333');
  assert.ok(cleared.download_url && cleared.share_url, 'a cleared photo offers Download and Copy link');
});

test('ACCEPTANCE: a signed-out hit on /photos or on a thumbnail URL gets the sign-in wall', async (t) => {
  const s = await serve(app(), t);
  for (const p of ['/photos', '/photos/thumb/p1']) {
    const cold = await call(s, p);
    assert.strictEqual(cold.status, 302, `${p}: bounced to sign in`);
    assert.ok(cold.headers.location.startsWith('https://dispatch.infinityhospitalitygroup.com/api/auth/google'));
    const again = await call(s, p, { headers: { Cookie: `${BOUNCE_MARKER}=1` } });
    assert.strictEqual(again.status, 401, `${p}: the wall, once dispatch did not know them`);
    assert.match(again.body, /Marketing Dashboard: sign in/);
    assert.ok(!again.body.includes('JPEG:'), 'no thumbnail bytes leak to a signed-out request');
  }
  assert.strictEqual((await call(s, '/api/photos')).status, 401);
});

test('ACCEPTANCE: a non-editor POST gets 403, and so does anyone without the surface', async (t) => {
  const store = memoryStore();
  const s = await serve(app(store), t);
  const tag = await call(s, '/api/photos/p1/tags', { method: 'POST', headers: as('sales@x'), body: { action: 'add', tag: 'candles' } });
  assert.strictEqual(tag.status, 403);
  const rights = await call(s, '/api/photos/p1/rights', { method: 'POST', headers: as('sales@x'), body: { internal: true } });
  assert.strictEqual(rights.status, 403);
  const pw = jwt.sign({ role: 'admin', name: 'marketing-admin' }, process.env.JWT_SECRET);
  const shared = await call(s, '/api/photos/p1/tags', { method: 'POST', headers: { Authorization: `Bearer ${pw}` }, body: { action: 'add', tag: 'candles' } });
  assert.strictEqual(shared.status, 403, 'the shared marketing password is not a person and cannot edit');
  assert.deepStrictEqual(store.writes, [], 'nothing was written');
  assert.strictEqual((await call(s, '/api/photos', { headers: as('chef@x') })).status, 403);
  assert.strictEqual((await call(s, '/photos', { headers: as('chef@x') })).status, 403);
  assert.strictEqual((await call(s, '/photos/thumb/p1', { headers: as('chef@x') })).status, 403);
  assert.strictEqual((await call(s, '/api/photos', { headers: as('stranger@x') })).status, 403);
});

test('ACCEPTANCE: a human-removed tag never returns, however often the AI has it', async (t) => {
  const store = memoryStore();
  const s = await serve(app(store), t);
  assert.ok(!ids(await call(s, '/api/photos?q=string%20lights', { headers: as('exec@x') })).includes('p9'),
    'p9 carries an AI "string lights" and a human removal: the removal wins');
  const r = await call(s, '/api/photos/p1/tags', { method: 'POST', headers: as('katherine@x'), body: { action: 'remove', tag: 'String Lights' } });
  assert.strictEqual(r.status, 200);
  assert.ok(!r.json.tags.includes('string lights'));
  store.data.tags.push({ drive_id: 'p1', tag: 'string lights', source: 'ai', confidence: 0.99 });   // the nightly re-tag
  const after = await call(s, '/api/photos?q=string%20lights', { headers: as('exec@x') });
  assert.deepStrictEqual(ids(after), ['p2', 'p3']);
  assert.deepStrictEqual(store.writes[0], { id: 'p1', action: 'remove', tag: 'string lights', who: 'person:k1' },
    'recorded by person id, never by name');
});

// ------------------------------------------------------------- the rest of the build

test('an editor adds a tag, it is searchable, and a person word or consumable is refused', async (t) => {
  const store = memoryStore();
  const s = await serve(app(store), t);
  const ok = await call(s, '/api/photos/p4/tags', { method: 'POST', headers: as('exec@x'), body: { action: 'add', tag: 'Uplighting' } });
  assert.strictEqual(ok.status, 200);
  assert.ok(ids(await call(s, '/api/photos?q=uplighting', { headers: as('sales@x') })).includes('p4'));
  for (const bad of ['asian guests', 'bride name']) {
    const r = await call(s, '/api/photos/p4/tags', { method: 'POST', headers: as('exec@x'), body: { action: 'add', tag: bad } });
    assert.strictEqual(r.status, 400, bad);
  }
  assert.strictEqual(store.writes.length, 1);
});

test('an editor sets internal only, and the download disappears at once', async (t) => {
  const store = memoryStore();
  const s = await serve(app(store), t);
  assert.ok((await call(s, '/api/photos/p2', { headers: as('sales@x') })).json.download_url);
  const r = await call(s, '/api/photos/p2/rights', { method: 'POST', headers: as('katherine@x'), body: { internal: true } });
  assert.strictEqual(r.status, 200);
  const after = (await call(s, '/api/photos/p2', { headers: as('sales@x') })).json;
  assert.strictEqual(after.rights.state, 'internal_only');
  assert.strictEqual(after.download_url, null);
  assert.strictEqual((await call(s, '/api/photos/p2/rights', { method: 'POST', headers: as('katherine@x'), body: { internal: 'yes' } })).status, 400);
});

test('the page and the thumbnail are served to a viewer; photos.html cannot be fetched around the check', async (t) => {
  const s = await serve(app(), t);
  const page = await call(s, '/photos', { headers: as('sales@x') });
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /ihg-tokens\.css/);
  const thumb = await call(s, '/photos/thumb/p1', { headers: as('sales@x') });
  assert.strictEqual(thumb.status, 200);
  assert.strictEqual(thumb.headers['content-type'], 'image/jpeg');
  assert.strictEqual(thumb.body, 'JPEG:p1');
  const raw = await call(s, '/photos.html', { headers: as('chef@x') });
  assert.strictEqual(raw.status, 301);
  assert.strictEqual(raw.headers.location, '/photos');
});

test('the "N of M tagged" line, path breadcrumbs as filters, and editor-only fields', async (t) => {
  const store = memoryStore();
  store.data.photos.push(P('p10', 'Venues / TBT / Patio', { venue: 'TBT' }));
  const s = await serve(app(store), t);
  const r = await call(s, '/api/photos', { headers: as('sales@x') });
  assert.deepStrictEqual(r.json.progress, { tagged: 7, total: 9 }, 'staff1 is not counted; p7 and p10 have no AI tags yet');
  const d = (await call(s, '/api/photos/p1', { headers: as('sales@x') })).json;
  assert.deepStrictEqual(d.breadcrumbs.map((b) => b.path), ['Venues', 'Venues / TBT', 'Venues / TBT / Patio', 'Venues / TBT / Patio / Wedding Reception']);
  assert.strictEqual(d.can_edit, false);
  assert.ok(!('removed_tags' in d));
  const byPath = await call(s, `/api/photos?path=${encodeURIComponent('Venues / TBT / Patio')}`, { headers: as('sales@x') });
  assert.deepStrictEqual(ids(byPath), ['p1', 'p10', 'p3']);
  assert.strictEqual((await call(s, '/api/photos/p1', { headers: as('katherine@x') })).json.can_edit, true);
});

test('a fleet token never reads photos', async (t) => {
  const a = express();
  a.use((req, res, next) => { req.fleetClient = { id: 1 }; next(); });
  a.use(pageGate);
  a.use(createPhotosRouter({ store: memoryStore(), identity, cacheMs: 0, log: () => {} }));
  const s = await serve(a, t);
  assert.strictEqual((await call(s, '/api/photos')).status, 403);
});

test('server.js mounts the photos router below the page gate and above express.static', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const gate = src.indexOf('app.use(pageGate)');
  const photos = src.indexOf('app.use(createPhotosRouter(');
  const stat = src.indexOf('app.use(express.static(');
  assert.ok(gate > 0 && photos > gate && stat > photos, `gate ${gate} < photos ${photos} < static ${stat}`);
});

// ------------------------------------------------------------- rights rule

test('launch default: a Venues photo with no event link is unknown, and the flip is one config line', () => {
  assert.strictEqual(VENUES_DEFAULT, 'unknown');
  const p = { folder_path: 'Venues / TBT', deal_id: null, manual_internal: false };
  assert.strictEqual(effectiveRights(p, {}, VENUES_DEFAULT).state, 'unknown');
  assert.strictEqual(effectiveRights(p, {}, 'cleared').state, 'cleared');
});

test('a DEALID photo is unknown while no sheet is connected, never cleared by default', () => {
  const p = { folder_path: 'Venues / ECD', deal_id: '333', manual_internal: false };
  assert.strictEqual(effectiveRights(p, null, 'cleared').state, 'unknown');
  assert.strictEqual(effectiveRights({ ...p, manual_internal: true }, null, 'cleared').state, 'internal_only');
});

test('sheet rule: DEALID only, month rows skipped, headers by text, a duplicate DEALID is refused', () => {
  const tabs = [
    { title: 'IH - 2024', values: [['Notes', 'DEALID', 'Event Name', 'Cool with using photos on socials/sales materials?'],
      ['JUNE'], ['', '333', 'A', 'YES'], ['', '444', 'B', 'YES']] },
    { title: 'DEC/DD - 2024', values: [['Event Name', 'Deal ID', 'Cool with using photos on socials/sales materials?'],
      ['June'], ['C', '444', 'NO']] },
    { title: 'Old', values: [['Event Name', 'Venue']] },
  ];
  const { rowsByDealId: rows, refused } = rowsByDealId(tabs);
  assert.deepStrictEqual(Object.keys(rows), ['333']);
  assert.strictEqual(rows['333']['Cool with using photos on socials/sales materials?'], 'YES');
  assert.ok(refused.some((r) => r.deal_id === '444'), 'on two rows: refused, not picked');
  assert.ok(refused.some((r) => r.tab === 'Old' && /no DEALID/.test(r.reason)));
});

// ------------------------------------------------------------- identity client

test('identity: fails closed with no token, asks dispatch with the bearer, caches success but never a failure', async () => {
  assert.strictEqual((await createIdentityClient({ env: {} }).lookup('a@x')).active, false);
  const calls = [];
  let fail = true;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    if (fail) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, json: async () => ({ active: true, person_id: 'k1', rung: 2, bundle: 'Marketing', surface_access: { 'marketing.photos': true } }) };
  };
  const c = createIdentityClient({ env: { DISPATCH_BRIDGE_TOKEN: 'tok' }, fetchImpl });
  assert.strictEqual((await c.lookup('K@X')).active, false);
  fail = false;
  const id = await c.lookup('k@x');
  assert.strictEqual(id.surface_access['marketing.photos'], true);
  await c.lookup('k@x');
  assert.strictEqual(calls.length, 2, 'the failure was not cached; the success was');
  assert.strictEqual(calls[1].url, 'https://dispatch.infinityhospitalitygroup.com/api/brain/portal/staff-identity?email=k%40x');
  assert.strictEqual(calls[1].auth, 'Bearer tok');
});

// ------------------------------------------------------------- the store's SQL

test('store: a tag edit is one transaction that never touches an AI row', async () => {
  const seen = [];
  const client = { query: async (sql, args) => { seen.push({ sql, args }); return { rows: [] }; }, release: () => seen.push('release') };
  const store = createPgStore({ connect: async () => client });
  await store.editTag('p1', 'remove', 'string lights', 'person:k1');
  assert.strictEqual(seen[0].sql, 'BEGIN');
  assert.strictEqual(seen[1].sql, EDIT_SQL.remove[0]);
  assert.match(seen[2].sql, /'human_remove'/);
  assert.deepStrictEqual(seen[2].args, ['p1', 'string lights', 'person:k1']);
  assert.strictEqual(seen[3].sql, 'COMMIT');
  assert.strictEqual(seen[4], 'release');
  for (const s of [...EDIT_SQL.add, ...EDIT_SQL.remove]) assert.ok(!/'ai'/.test(s), 'no edit statement names an AI row');
});
