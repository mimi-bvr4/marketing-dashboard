'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const nodePath = require('node:path');
const { load, assertStartable } = require('./config');
const { THEMES, RENDERABLE, findTheme } = require('./data/themes');
const { VENUES, byCode } = require('./data/venues');
const { STYLES } = require('./render/styles');
const { esc, page } = require('./render/html');
const hubspot = require('./hubspot');

const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'];
const SPLIT_MAX_AGE = 60 * 60 * 24 * 90;
const BODY_LIMIT = 20 * 1024;

// Ad params go into hidden fields only. Even there they are cut to a safe
// alphabet and length; nothing from the URL is ever shown on a page.
function cleanParam(value) {
  return String(value || '').slice(0, 200).replace(/[^A-Za-z0-9._~:+%-]/g, '_');
}

function trackingFrom(params) {
  const out = {};
  for (const key of TRACKING_PARAMS) {
    const v = params.get(key);
    if (v) out[key] = cleanParam(v);
  }
  return out;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch (e) {
      // a malformed cookie is ignored, never fatal
    }
  }
  return out;
}

function securityHeaders(res, cfg) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  const csp = cfg.hubspotTracking
    ? "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' https:; connect-src 'self' https:; img-src 'self' data: https:; form-action 'self'; frame-ancestors 'none'"
    : "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'";
  res.setHeader('Content-Security-Policy', csp);
}

function send(res, status, body, headers = {}) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.statusCode = status;
  res.end(body);
}

// ORDER #1202: /hub-assets/<file>. Fonts, icons and stylesheets are served
// from ASSETS_DIR. A PHOTO is served only when its file name is in the
// cleared set, which #1008's cleared-photo index fills once it is on main
// (lib/photo-archive.js lives on order-1008-photo-archive-decision-core,
// unmerged). Until then the set is empty, so no photo file is ever served,
// whatever is sitting in the folder.
const ASSETS_DIR = nodePath.join(__dirname, 'assets');
const ASSET_TYPES = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
const PHOTO_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif' };

function serveAsset(res, name, dir, cleared) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name) || name.includes('..')) return send(res, 404, 'Not found');
  const ext = nodePath.extname(name).toLowerCase();
  let type = ASSET_TYPES[ext];
  if (!type && PHOTO_TYPES[ext] && cleared.has(name)) type = PHOTO_TYPES[ext];
  if (!type) return send(res, 404, 'Not found');
  let body;
  try {
    body = fs.readFileSync(nodePath.join(dir, name));
  } catch (e) {
    return send(res, 404, 'Not found');
  }
  return send(res, 200, body, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createApp(opts = {}) {
  const cfg = opts.config || load();
  assertStartable(cfg); // prod 49701209 or a non-sandbox portal: throw, the hub does not start
  const base = cfg.basePath || '';
  const themes = opts.themes || THEMES;
  const venues = opts.venues || VENUES;
  const rng = opts.rng || (() => crypto.randomInt(2));
  const fetchImpl = opts.fetch || globalThis.fetch;
  const assetsDir = opts.assetsDir || ASSETS_DIR;
  const clearedPhotos = opts.clearedPhotos || new Set();

  function redirectHome(res) {
    send(res, 302, '', { Location: `${base}/` });
  }

  function ctxFor(path, params, extra = {}) {
    return {
      base,
      preview: cfg.preview,
      noindex: cfg.preview,
      hubspotTracking: cfg.hubspotTracking,
      hubspotPortal: cfg.hubspotPortal,
      path,
      tracking: trackingFrom(params),
      ...extra,
    };
  }

  function html(res, ctx, doc, status = 200, headers = {}) {
    if (ctx.noindex) headers['X-Robots-Tag'] = 'noindex, nofollow';
    send(res, status, page(ctx, doc), { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  }

  function home(req, res, params) {
    const ctx = ctxFor('/', params, { cta: 'Request venue information' });
    const model = {
      eyebrow: 'Nashville wedding venues',
      headline: 'Seven distinctive venues. One seamless experience.',
      heroSlot: 'Hero image',
      venues: venues.map((venue) => ({ venue })),
      cta: 'Explore all venues',
    };
    html(res, ctx, {
      title: 'Nashville Wedding Venues + Event Spaces | Infinity Hospitality',
      description: 'Seven distinctive Nashville venues and one team to help you choose.',
      body: STYLES.collection(ctx, model),
    });
  }

  function themePage(req, res, params, theme, variant, cookies) {
    let chosen = variant;
    const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
    if (variant === '' && Array.isArray(theme.split) && theme.split.length === 2) {
      const name = `vh_split_${theme.slug}`;
      const sticky = cookies[name];
      if (sticky !== undefined && theme.split.includes(sticky === '_' ? '' : sticky)) {
        chosen = sticky === '_' ? '' : sticky;
      } else {
        chosen = theme.split[rng() === 1 ? 1 : 0];
        headers['Set-Cookie'] = `${name}=${chosen || '_'}; Max-Age=${SPLIT_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${cfg.preview ? '' : '; Secure'}`;
      }
    }
    const styleName = theme.styles[chosen];
    const style = STYLES[styleName];
    if (!style) return redirectHome(res);

    // Message match: only an approved key swaps the headline.
    const swapKey = params.get('hl');
    const swaps = theme.headlineSwaps || {};
    const headline = swapKey && Object.prototype.hasOwnProperty.call(swaps, swapKey) ? swaps[swapKey] : theme.promise;

    const path = `/${theme.slug}${variant ? `/${variant}` : ''}`;
    const fitting = theme.venues
      .map((f) => ({ ...f, venue: byCode(f.code, venues) }))
      .filter((f) => f.venue);
    const ctx = ctxFor(path, params, {
      noindex: true, // theme pages: always noindex (Amendment A), preview or not
      themeSlug: theme.slug,
      styleName,
      eventType: theme.eventType,
      cta: theme.cta,
      formVenues: fitting.map((f) => f.code),
    });
    const model = {
      eyebrow: theme.eyebrow,
      headline,
      intro: theme.intro,
      heroSlot: theme.heroSlot || theme.eyebrow,
      heroPhoto: theme.heroPhoto,
      cta: theme.cta,
      heroCta: theme.cta,
      collectionTitle: theme.eyebrow,
      venues: fitting,
      faq: theme.faq,
    };
    html(res, ctx, { title: `${theme.eyebrow} | Infinity Hospitality`, body: style(ctx, model) }, 200, headers);
  }

  function robots(res) {
    // LANDMINE (Amendment A): never Disallow theme pages; AdsBot and Meta's
    // crawler must fetch them. noindex keeps them out of search.
    send(res, 200, `User-agent: *\nAllow: /\n\nSitemap: ${cfg.siteUrl}/sitemap.xml\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  function sitemap(res) {
    // The hub home only. Never a theme URL.
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${esc(cfg.siteUrl)}/</loc></url>\n</urlset>\n`;
    send(res, 200, body, { 'Content-Type': 'application/xml; charset=utf-8' });
  }

  function thanks(res, params, note) {
    const ctx = ctxFor('/thanks', params, { noindex: true });
    const body = `<section class="hero" style="min-height:70vh"><p class="eyebrow">Inquiry</p><h1 class="display">${esc(note.title)}</h1><p class="lede">${esc(note.text)}</p><a class="btn-light" href="${esc(base + '/')}">Back to the venues</a></section>`;
    html(res, ctx, { title: 'Thank you | Infinity Hospitality', body }, note.status || 200);
  }

  async function inquire(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      return send(res, 413, 'Too large');
    }
    const form = new URLSearchParams(raw);
    const one = (k, max = 200) => String(form.get(k) || '').trim().slice(0, max);
    const themeSlug = one('theme');
    const theme = findTheme(themeSlug, themes);
    const validTheme = theme && RENDERABLE.has(theme.status) ? theme.slug : '';
    const style = Object.prototype.hasOwnProperty.call(STYLES, one('style')) ? one('style') : '';
    const landing = /^\/[a-z0-9/-]{0,80}$/.test(one('landing_page')) ? one('landing_page') : '/';
    const venueCodes = form.getAll('venues').filter((c) => byCode(c, venues));
    const lead = {
      firstname: one('firstname', 100),
      lastname: one('lastname', 100),
      email: one('email', 200),
      phone: one('phone', 40),
      event_type: ['Wedding', 'Corporate', 'Social', 'Non-Profit'].includes(one('event_type')) ? one('event_type') : '',
      event_date: one('event_date', 100),
      guest_count: one('guest_count', 40),
      venues: venueCodes,
      venue_unsure: form.get('venue_unsure') === '1' ? 'true' : '',
      message: one('message', 2000),
      theme: validTheme,
      style,
      landing_page: landing,
    };
    const tracking = {};
    for (const key of TRACKING_PARAMS) {
      const v = form.get(key);
      if (v) tracking[key] = cleanParam(v);
    }
    Object.assign(lead, tracking);
    if (!lead.firstname || !lead.lastname || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) {
      return thanks(res, new URLSearchParams(), { status: 400, title: 'Almost there.', text: 'Please add your name and a valid email, then send it again.' });
    }
    const query = new URLSearchParams(tracking).toString();
    const pageUri = `${cfg.siteUrl}${landing}${query ? `?${query}` : ''}`;
    const cookies = parseCookies(req.headers.cookie);
    const payload = hubspot.buildPayload(lead, { pageUri, hutk: cleanParam(cookies.hubspotutk || '') || undefined, pageName: validTheme || 'hub' });
    const result = await hubspot.submit({ portalId: cfg.hubspotPortal, formGuid: cfg.hubspotFormGuid, payload, fetchImpl });
    if (result.ok) {
      res.setHeader('Location', `${base}/thanks`);
      return send(res, 303, '');
    }
    if (result.reason === 'not-configured') {
      return thanks(res, new URLSearchParams(), { status: 503, title: 'Preview: form not connected.', text: 'The sandbox test form is not set on this preview yet, so nothing was sent.' });
    }
    return thanks(res, new URLSearchParams(), { status: 502, title: 'That did not go through.', text: 'Please try again in a moment.' });
  }

  return async function handler(req, res) {
    securityHeaders(res, cfg);
    const url = new URL(req.url, 'http://local');
    let path = url.pathname.replace(/\/+$/, '') || '/';
    const params = url.searchParams;
    try {
      if (req.method === 'POST' && path === '/inquire') return await inquire(req, res);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      if (path === '/') return home(req, res, params);
      if (path.startsWith('/hub-assets/')) return serveAsset(res, path.slice('/hub-assets/'.length), assetsDir, clearedPhotos);
      if (path === '/robots.txt') return robots(res);
      if (path === '/sitemap.xml') return sitemap(res);
      if (path === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
      if (path === '/thanks') return thanks(res, params, { title: 'Thank you.', text: "We have your note and we'll be in touch soon." });
      const m = /^\/([a-z0-9-]{1,60})(?:\/([a-z0-9]{1,10}))?$/.exec(path);
      if (m) {
        const theme = findTheme(m[1], themes);
        const variant = m[2] || '';
        if (theme && RENDERABLE.has(theme.status) && theme.styles[variant]) {
          return themePage(req, res, params, theme, variant, parseCookies(req.headers.cookie));
        }
      }
      return redirectHome(res); // unknown, draft, paused or retired: never a list of themes
    } catch (err) {
      return send(res, 500, 'Something went wrong', { 'Content-Type': 'text/plain' });
    }
  };
}

module.exports = { createApp, cleanParam };
