// ORDER #3164: the Box half of "Connect" on Settings, Pinterest accounts.
// RUNS ON THE BOX, inside jobs/agent_handoff.js (every 15 minutes), only while
// PINTEREST_PER_VENUE is on.
//
//   1. Each code the dashboard parked (a person approved our app while signed in
//      to that venue's Pinterest) is traded for that venue's refresh token, which
//      is written to the Box Keychain as pinterest-refresh-token-<venuecode>. The
//      code is wiped from Postgres whatever happens. The token never leaves this
//      process except into the Keychain, and is never printed or logged.
//   2. Every venue is then checked: Connected or not, and that account's boards
//      (boards:read), saved to pinterest_accounts so the dashboard can show them.
//
// Writes to Pinterest: none. POST /oauth/token is the login trade, not a pin.
'use strict';

const { execFileSync } = require('child_process');
const PV = require('./pinterest-venues');
const pt = require('./pinterest');

// The token goes to `security` on stdin (its -i command mode), never on the
// command line, so it is not visible in the process list.
const SAFE = /^[A-Za-z0-9._~+/=-]{8,4096}$/;
function saveSecret(item, value, run = execFileSync) {
  if (!SAFE.test(String(value))) throw new Error('Pinterest returned a token in an unexpected shape; not saved');
  run('security', ['-i'], { input: `add-generic-password -U -a ihg-box -s ${item} -w ${value}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
}

async function exchangeCode({ code, redirectUri, fetchImpl = globalThis.fetch, secrets = pt.keychain }) {
  const id = secrets('pinterest-app-id'); const secret = secrets('pinterest-app-secret');
  if (!id || !secret) return { ok: false, retry: true, why: 'the Pinterest app is not on the Box yet (Keychain items pinterest-app-id, pinterest-app-secret)' };
  const r = await fetchImpl(`${pt.API}/oauth/token`, { method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}` });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) return { ok: false, why: `Pinterest refused the approval: ${j.message || r.status}. Press Connect again.` };
  return { ok: true, refresh: j.refresh_token };
}

async function syncAccounts({ accounts, fetchImpl = globalThis.fetch, secrets = pt.keychain, save = saveSecret, log = console.log }) {
  let traded = 0;
  for (const c of await accounts.pendingCodes()) {
    const v = PV.byCode(c.venue);
    if (!v) { await accounts.finishConnect(c.state, 'not one of our venues'); continue; }
    const r = await exchangeCode({ code: c.code, redirectUri: c.redirect_uri, fetchImpl, secrets });
    if (r.retry) { log(`pinterest connect ${v.code}: will retry, ${r.why}`); continue; }
    if (!r.ok) { await accounts.finishConnect(c.state, `failed: ${r.why}`); log(`pinterest connect ${v.code}: ${r.why}`); continue; }
    try { save(PV.tokenItem(v.code), r.refresh); }
    catch (e) { await accounts.finishConnect(c.state, `failed: the Box could not save it (${e.message})`); log(`pinterest connect ${v.code}: Keychain save failed`); continue; }
    await accounts.finishConnect(c.state, 'connected');
    log(`pinterest connect ${v.code}: connected (Keychain ${PV.tokenItem(v.code)})`);
    traded++;
  }
  let connected = 0;
  for (const v of PV.VENUES) {
    const t = await pt.accessToken({ fetchImpl, secrets, venue: v.code });
    if (!t.ok) { await accounts.save(v.code, { connected: false, boards: [], why: t.unconnected ? null : t.why }); continue; }
    try {
      const list = await pt.boards({ token: t.token, fetchImpl });
      await accounts.save(v.code, { connected: true, boards: list, why: null });
      connected++;
    } catch (e) { await accounts.save(v.code, { connected: true, boards: [], why: e.message }); connected++; }
  }
  log(`pinterest accounts: ${traded} newly connected, Connected: ${connected} of ${PV.VENUES.length} venues`);
  return { traded, connected, total: PV.VENUES.length };
}

module.exports = { syncAccounts, exchangeCode, saveSecret };
