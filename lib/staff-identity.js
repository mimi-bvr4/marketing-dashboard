// ORDER #1241: who a signed-in person is, asked of dispatch.
//
// The same read planning makes (planning server/lib/dispatch_bridge.js
// staffIdentity): dispatch's /api/brain/portal/staff-identity answers, by
// email, whether the person is active staff, their rung and bundle, and a
// named surface_access map. #1194 put 'marketing.photos' on that map, resolved
// dispatch-side with the #659 page tick boxes. No role is invented here.
//
//   Env: DISPATCH_BRIDGE_URL    already read by lib/sso.js (same default)
//        DISPATCH_BRIDGE_TOKEN  bearer = BRAIN_BRIDGE_TOKEN on dispatch
//
// 🔴 FAILS CLOSED. No token, a dispatch error, an unknown email or an older
// dispatch that omits a field all answer "no access". A lookup failure is never
// cached, so the next request asks again.
'use strict';

const { dispatchBase } = require('./sso');

const TTL_MS = 5 * 60 * 1000;
const NONE = Object.freeze({ active: false, person_id: null, rung: null, bundle: null, surface_access: {} });

function configured(env = process.env) { return !!env.DISPATCH_BRIDGE_TOKEN; }

function createIdentityClient({ fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now() } = {}) {
  const cache = new Map();   // email -> { at, value }
  async function lookup(email) {
    const key = String(email || '').trim().toLowerCase();
    if (!key || !configured(env)) return { ...NONE, reason: key ? 'not configured' : 'no email' };
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    let data;
    try {
      const res = await fetchImpl(`${dispatchBase()}/api/brain/portal/staff-identity?email=${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${env.DISPATCH_BRIDGE_TOKEN}` } });
      if (!res.ok) return { ...NONE, reason: `dispatch ${res.status}` };
      data = await res.json();
    } catch (e) {
      return { ...NONE, reason: 'dispatch unreachable' };
    }
    const value = {
      active: !!data.active,
      person_id: data.person_id || null,
      rung: Number.isFinite(data.rung) ? data.rung : null,
      bundle: data.bundle || null,
      surface_access: (data.surface_access && typeof data.surface_access === 'object') ? data.surface_access : {},
    };
    cache.set(key, { at: now(), value });
    return value;
  }
  return { lookup, configured: () => configured(env) };
}

module.exports = { createIdentityClient, configured, TTL_MS };
