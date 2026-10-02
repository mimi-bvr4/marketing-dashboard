'use strict';
// ORDER #1202: shared helpers for the hub tests. Ported from #1198's
// test/helpers.js (venue-hub 902f051), now pointed at hub/.

const http = require('node:http');
const path = require('node:path');
const { createApp } = require('../hub/app');
const { load } = require('../hub/config');

// The hub handler on its own, the way #1198's 26 tests drove it.
async function start(opts = {}) {
  const config = { ...load({}), ...(opts.config || {}) };
  const server = http.createServer(createApp({ ...opts, config }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const close = () => new Promise((r) => server.close(r));
  return { base, get, close };
}

// The REAL server.js, loaded fresh with the env given. Every module of this
// repo is dropped from the require cache first, so each call sees its own
// VENUE_HUB_HOSTS. node_modules stay cached.
const ROOT = path.join(__dirname, '..');
const ENV_KEYS = ['VENUE_HUB_HOSTS', 'VENUE_HUB_HUBSPOT_PORTAL', 'VENUE_HUB_FORM_GUID', 'VENUE_HUB_PREVIEW',
  'PUBLIC_BASE_URL', 'DISPATCH_BRIDGE_URL', 'JWT_SECRET', 'GA4_CREDENTIALS_JSON', 'DATABASE_URL', 'HUBSPOT_TOKEN', 'ANTHROPIC_API_KEY'];

function loadDashboard(env = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(ROOT) && !k.includes(`${path.sep}node_modules${path.sep}`)) delete require.cache[k];
  }
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    PUBLIC_BASE_URL: 'https://marketing.infinityhospitalitygroup.com',
    DISPATCH_BRIDGE_URL: 'https://dispatch.infinityhospitalitygroup.com',
    JWT_SECRET: 'marketing-test-secret-not-real',
  }, env);
  return require('../server.js');
}

// Closed via the test context so a failing assertion cannot leave a listener
// behind and hang `node --test` (the #661 lesson).
function serve(app, t) {
  return new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => s.close(r)));
      resolve(s);
    });
  });
}

function request(server, urlPath, { method = 'GET', headers = {}, body } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { start, loadDashboard, serve, request };
