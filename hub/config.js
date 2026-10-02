'use strict';

// ORDER #1202 (was #1198 in its own repo): the hub posts to the HubSpot
// SANDBOX only. The portal id comes from env VENUE_HUB_HUBSPOT_PORTAL and has
// NO default: unset means the form sends nothing. Production 49701209, or any
// portal that is not the sandbox, makes createApp() throw, so the hub refuses
// to start (hub/router.js then keeps the hub OFF and the dashboard runs on).
//
// Every name is VENUE_HUB_* on purpose. The dashboard's own HUBSPOT_TOKEN,
// GA4_CREDENTIALS_JSON, JWT_SECRET and DATABASE_URL are never read here.
const SANDBOX_PORTAL = '51163869';
const PROD_PORTAL = '49701209';

function load(env = process.env) {
  return {
    siteUrl: (env.VENUE_HUB_SITE_URL || 'https://nashvilleweddingvenue.com').replace(/\/+$/, ''),
    // Preview mode: the whole site sends noindex and shows fact-check markers.
    // On by default; only Step 2 turns it off.
    preview: env.VENUE_HUB_PREVIEW !== '0',
    hubspotPortal: String(env.VENUE_HUB_HUBSPOT_PORTAL || '').trim(),
    hubspotFormGuid: String(env.VENUE_HUB_FORM_GUID || '').trim(),
    // The HubSpot tracking script (it sets the hutk cookie). OFF unless asked.
    hubspotTracking: env.VENUE_HUB_HUBSPOT_TRACKING === '1',
    // Meta Pixel / CAPI / Google conversion uploads: behind a flag, OFF.
    // Nothing in Step 1 reads this as true.
    adConversions: false,
    // '' on a public host, '/hub' on the dashboard's private preview.
    basePath: '',
  };
}

function assertStartable(cfg) {
  const portal = String(cfg.hubspotPortal || '');
  if (portal === PROD_PORTAL) {
    throw new Error('ORDER #1202: production HubSpot 49701209 is refused; the hub will not start');
  }
  if (portal && portal !== SANDBOX_PORTAL) {
    throw new Error(`ORDER #1202: only sandbox ${SANDBOX_PORTAL} is allowed, got ${portal}; the hub will not start`);
  }
}

module.exports = { load, assertStartable, SANDBOX_PORTAL, PROD_PORTAL };
