'use strict';
// ORDER #2366: the public /health reports the deployed commit, short form, the
// way dispatch's /healthz does. REPLY #2364 proved a signed-out /api/* answers
// 401 before routing, so without this a post-merge check cannot tell a deployed
// route from a missing one.
//
// Driven through the REAL gate and the REAL fleet router, signed out, the same
// shape as #1370's test. No network, no database, no real secret.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');

process.env.JWT_SECRET = 'marketing-test-secret-not-real';
delete process.env.DATABASE_URL;

const { pageGate } = require('../middleware/page-gate');
const fleet = require('../routes/fleet');

function serve(t) {
  const a = express();
  a.use(pageGate);
  a.use('/', fleet);
  return new Promise(resolve => {
    const s = http.createServer(a).listen(0, () => {
      t.after(() => new Promise(r => s.close(r)));
      resolve(s);
    });
  });
}
function getHealth(s) {
  return new Promise((resolve, reject) => {
    http.get({ port: s.address().port, path: '/health' }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}
function withSha(value, fn) {
  const before = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (value === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = value;
  return fn().finally(() => {
    if (before === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = before;
  });
}

test('guard 1: with RAILWAY_GIT_COMMIT_SHA set, version is its first 7 characters', async t => {
  const s = await serve(t);
  await withSha('26798047418f22250e956356e0ea9581d611c593', async () => {
    const r = await getHealth(s);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.version, '2679804');
  });
});

test('guard 2 (known-bad): with the variable UNSET, version is "unknown" and it still answers 200', async t => {
  const s = await serve(t);
  await withSha(undefined, async () => {
    const r = await getHealth(s);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.version, 'unknown');
  });
});

test('guard 3: /health is still reachable signed out, through the real gate', async t => {
  const s = await serve(t);
  const r = await getHealth(s);   // no cookie, no Authorization header
  assert.strictEqual(r.status, 200);
});

test('guard 4: status and service are unchanged, and version is the only field added', async t => {
  const s = await serve(t);
  await withSha('abcdef0123456789', async () => {
    const r = await getHealth(s);
    assert.strictEqual(r.body.status, 'ok');
    assert.strictEqual(r.body.service, 'marketing-dashboard');
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['service', 'status', 'version']);
  });
});
