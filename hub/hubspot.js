'use strict';

// The lead form -> HubSpot Forms API (the unauthenticated submit endpoint
// every website form uses). It is a form submission, never an API write.
// Nothing is stored here: the lead passes straight through.

const { SANDBOX_PORTAL, PROD_PORTAL } = require('./config');

const ENDPOINT = 'https://api.hsforms.com/submissions/v3/integration/submit';

// Form field -> HubSpot property name. The first group already exists in
// prod (read-only property reads, REPLY #1011 Step 0). The `hub_*` names are
// PROPOSED for the sandbox test form and are Mary's call before Step 2:
// #1011 says no new prod property without her. null = not sent.
const FIELD_MAP = {
  firstname: 'firstname',
  lastname: 'lastname',
  email: 'email',
  phone: 'phone',
  event_type: 'event_type',
  venues: 'venue_s_',
  message: 'message',
  event_date: 'hub_event_date',
  guest_count: 'hub_guest_count',
  venue_unsure: 'hub_venue_unsure',
  theme: 'hub_theme',
  style: 'hub_style',
  landing_page: 'hub_landing_page',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_content: 'utm_content',
  utm_term: 'utm_term',
  gclid: 'hub_gclid',
  fbclid: 'hub_fbclid',
};

function assertSandbox(portalId) {
  if (String(portalId) === PROD_PORTAL) {
    throw new Error('ORDER #1202: production HubSpot 49701209 is refused in Step 1');
  }
  if (String(portalId) !== SANDBOX_PORTAL) {
    throw new Error(`ORDER #1202: only sandbox ${SANDBOX_PORTAL} is allowed, got ${portalId}`);
  }
}

function buildPayload(lead, { pageUri, hutk, pageName, now = Date.now() }) {
  const fields = [];
  for (const [key, prop] of Object.entries(FIELD_MAP)) {
    if (!prop) continue;
    let value = lead[key];
    if (Array.isArray(value)) value = value.join(';');
    if (value == null || value === '') continue;
    fields.push({ objectTypeId: '0-1', name: prop, value: String(value) });
  }
  const context = { pageUri, pageName };
  if (hutk) context.hutk = hutk;
  return { submittedAt: String(now), fields, context };
}

async function submit({ portalId, formGuid, payload, fetchImpl = globalThis.fetch }) {
  // ORDER #1202: the portal has no default. Unset is "not connected", never prod.
  if (!portalId) return { ok: false, reason: 'not-configured' };
  assertSandbox(portalId);
  if (!/^[0-9a-f-]{36}$/i.test(formGuid || '')) {
    return { ok: false, reason: 'not-configured' };
  }
  const url = `${ENDPOINT}/${portalId}/${formGuid}`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status, reason: res.ok ? 'sent' : 'rejected' };
  } catch (err) {
    return { ok: false, reason: 'unreachable' };
  }
}

module.exports = { ENDPOINT, FIELD_MAP, assertSandbox, buildPayload, submit };
