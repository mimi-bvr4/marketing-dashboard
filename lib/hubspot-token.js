// ORDER #1733: the one place the dashboard's HubSpot token becomes a request
// header. server.js's CRM search and lib/hubspot-email-stats.js both use it, so
// the token is read in one spot and never copied. Nothing here logs it.
'use strict';

function hubspotToken(env = process.env) {
  const t = String(env.HUBSPOT_TOKEN || '').trim();
  return t || null;
}

function hubspotHeaders(env = process.env, extra = {}) {
  return { Authorization: `Bearer ${hubspotToken(env)}`, ...extra };
}

module.exports = { hubspotToken, hubspotHeaders };
