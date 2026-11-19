'use strict';
// ORDER #3625 (rides on #3622): Mimi put the Canva app's keys in the Box Keychain
// (canva-client-id, canva-client-secret). The dashboard's sign-in link needs the
// client id, which is not a secret. Instead of a Railway variable (one more step
// for Mimi), the Box publishes it to the dashboard's database on every Archivist
// run, and the dashboard reads it from there. CANVA_CLIENT_ID still wins if set.
// The client SECRET never leaves the Box.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const C = require('../lib/canva');
const { createCanvaRouter } = require('../routes/canva');

async function withServer(router, who, fn) {
  const app = express();
  app.use((req, res, next) => { if (who) req.mktUser = { email: who }; next(); });
  app.use(router);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

const keychainOf = (items) => (name) => (name in items ? items[name] : null);

test('the Box publishes the Keychain client id to the dashboard, and never the secret', async () => {
  const connects = C.createMemoryConnects();
  const logs = [];
  const secrets = keychainOf({ 'canva-client-id': 'OC-AbC123_xyz', 'canva-client-secret': 'CSECRET-zz' });
  assert.strictEqual(await C.publishClientId({ connects, secrets, log: (l) => logs.push(l) }), 'published');
  assert.strictEqual(await connects.clientId(), 'OC-AbC123_xyz');
  assert.strictEqual(await C.publishClientId({ connects, secrets, log: (l) => logs.push(l) }), 'unchanged', 'no write when it already matches');
  const all = logs.join('\n') + JSON.stringify([...Object.entries(connects)].map(([k]) => k));
  assert.ok(!all.includes('CSECRET'), 'the secret is never logged or stored');
  assert.ok(!logs.join('\n').includes('OC-AbC123_xyz'), 'the id itself is not logged either');
});

test('no Keychain item: nothing is published and the run says so plainly', async () => {
  const connects = C.createMemoryConnects();
  const logs = [];
  assert.strictEqual(await C.publishClientId({ connects, secrets: keychainOf({}), log: (l) => logs.push(l) }), 'missing');
  assert.strictEqual(await connects.clientId(), null);
  assert.match(logs.join('\n'), /canva-client-id/);
});

test('a client id in an unexpected shape is not published', async () => {
  const connects = C.createMemoryConnects();
  assert.strictEqual(await C.publishClientId({ connects, secrets: keychainOf({ 'canva-client-id': 'bad id; drop' }), log: () => {} }), 'bad shape');
  assert.strictEqual(await connects.clientId(), null);
});

test('the dashboard: no Railway variable, but the Box published the id: the sign-in link works', async () => {
  const connects = C.createMemoryConnects();
  await withServer(createCanvaRouter({ connects, env: {} }), 'mimi@infinityhospitality.net', async (base) => {
    assert.strictEqual((await fetch(`${base}/settings/canva/connect`, { redirect: 'manual' })).status, 409, 'nothing published yet: not ready');
    assert.strictEqual((await (await fetch(`${base}/api/canva/connects`)).json()).ready, false);
    await connects.setClientId('OC-FromBox');
    const r = await fetch(`${base}/settings/canva/connect`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(new URL(r.headers.get('location')).searchParams.get('client_id'), 'OC-FromBox');
    assert.strictEqual((await (await fetch(`${base}/api/canva/connects`)).json()).ready, true);
  });
});

test('CANVA_CLIENT_ID on the dashboard still wins over the published one', async () => {
  const connects = C.createMemoryConnects();
  await connects.setClientId('OC-FromBox');
  await withServer(createCanvaRouter({ connects, env: { CANVA_CLIENT_ID: 'OC-Railway' } }), 'mimi@infinityhospitality.net', async (base) => {
    const r = await fetch(`${base}/settings/canva/connect`, { redirect: 'manual' });
    assert.strictEqual(new URL(r.headers.get('location')).searchParams.get('client_id'), 'OC-Railway');
  });
});

test('the table is additive (CREATE TABLE IF NOT EXISTS) and holds only the client id', () => {
  assert.match(C.SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS canva_app \(/);
  const block = C.SCHEMA_SQL.slice(C.SCHEMA_SQL.indexOf('canva_app'));
  assert.ok(!/secret|token/i.test(block), 'no secret or token column');
  assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE)\b/i.test(C.SCHEMA_SQL));
});
