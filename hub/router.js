'use strict';

// ORDER #1202: the venue hub lives inside marketing-dashboard, split by HOST.
//
// marketing-dashboard is an internal, gated app: pageGate bounces every
// unauthenticated page to SSO. A public site in the same process is safe only
// if the split is by host and is tested, so there are two mounts:
//
//   publicHosts  mounted in server.js ABOVE fleetGate and pageGate. On a host
//                named in VENUE_HUB_HOSTS it serves ONLY the allow-list below
//                and answers everything else 404. A 404, never a 302 to SSO and
//                never JSON, because either would tell a stranger the
//                dashboard exists. It never calls next() on a public host, so
//                no dashboard middleware (sessions, fleet tokens, the DB, GA4)
//                ever sees a public request.
//   preview      mounted at /hub BELOW pageGate, on every other host: the
//                private preview, signed-in staff only (surface
//                marketing.dashboard). Replaces #1198's Railway preview step.
//
// VENUE_HUB_HOSTS has NO default. Unset or empty, the hub is OFF everywhere:
// publicHosts passes straight through and preview passes straight through, so
// every request gets the dashboard's existing gated behavior.
//
// Isolation: nothing here reads a session, a staff table or the GA4
// credential. A hub error is caught here and answers 500 for that one request;
// it never reaches Express's error handler or the process.
//
// X-Robots-Tag: noindex, nofollow on EVERY hub response (and on the public
// host's 404s) until Mimi rules the hub public (#1011 Step 2).

const { createApp } = require('./app');
const { load } = require('./config');
const { THEMES } = require('./data/themes');

const NOINDEX = 'noindex, nofollow';
const THEME_PATH = /^\/([a-z0-9-]{1,60})(?:\/([a-z0-9]{1,10}))?$/;

function parseHosts(raw) {
  return new Set(String(raw || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
}

function hostOf(req) {
  // The Host header only. X-Forwarded-Host is never trusted to pick a side.
  return String(req.headers.host || '').trim().toLowerCase().replace(/:\d+$/, '');
}

function normalPath(req) {
  let p;
  try {
    p = new URL(req.url, 'http://local').pathname;
  } catch (e) {
    return null;
  }
  return p.replace(/\/+$/, '') || '/';
}

// The public allow-list. Anything not matched here is 404 on a public host.
function allowed(method, p, themes) {
  const read = method === 'GET' || method === 'HEAD';
  if (method === 'POST') return p === '/inquire'; // the sandbox form
  if (!read) return false;
  if (p === '/' || p === '/robots.txt' || p === '/sitemap.xml' || p === '/thanks') return true;
  if (p.startsWith('/hub-assets/')) return true;
  const m = THEME_PATH.exec(p);
  // A theme path is on the list only when the slug is a theme the hub knows.
  // The hub itself then decides: render, or 302 home for a draft or an unknown
  // variant. An unknown slug (/photos, /settings, /reports) is never the hub's.
  return Boolean(m && themes.some((t) => t.slug === m[1]));
}

function notFound(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('Not found');
}

function guarded(handler, log) {
  return function run(req, res) {
    res.setHeader('X-Robots-Tag', NOINDEX);
    return Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => {
        log(`[venue-hub] request failed: ${err && err.message}`);
        if (res.headersSent) return res.destroy();
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Something went wrong');
      });
  };
}

function createHubRouter(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || ((m) => console.error(m));
  const hosts = parseHosts(env.VENUE_HUB_HOSTS);
  const themes = (opts.appOpts && opts.appOpts.themes) || THEMES;
  const off = (req, res, next) => next();

  if (!hosts.size) return { publicHosts: off, preview: off, enabled: false, hosts, reason: 'VENUE_HUB_HOSTS unset' };

  let publicApp;
  let previewApp;
  try {
    const cfg = { ...load(env), ...(opts.config || {}) };
    publicApp = createApp({ ...(opts.appOpts || {}), config: { ...cfg, basePath: '' } });
    previewApp = createApp({ ...(opts.appOpts || {}), config: { ...cfg, basePath: '/hub' } });
  } catch (err) {
    // The hub refused to start (prod portal, non-sandbox portal). The hub
    // stays OFF and the dashboard keeps running.
    log(`[venue-hub] OFF: ${err.message}`);
    const refuse = (req, res, next) => {
      if (!hosts.has(hostOf(req))) return next();
      res.setHeader('X-Robots-Tag', NOINDEX);
      return notFound(res);
    };
    return { publicHosts: refuse, preview: off, enabled: false, hosts, reason: err.message };
  }

  const runPublic = guarded(publicApp, log);
  const runPreview = guarded(previewApp, log);

  function publicHosts(req, res, next) {
    if (!hosts.has(hostOf(req))) return next();
    res.removeHeader('X-Powered-By');
    const p = normalPath(req);
    if (p === null || !allowed(req.method, p, themes)) {
      res.setHeader('X-Robots-Tag', NOINDEX);
      return notFound(res);
    }
    return runPublic(req, res);
  }

  function preview(req, res, next) {
    if (hosts.has(hostOf(req))) return next(); // never reached: publicHosts answered first
    return runPreview(req, res);
  }

  return { publicHosts, preview, enabled: true, hosts };
}

module.exports = { createHubRouter, parseHosts, hostOf, allowed, NOINDEX };
