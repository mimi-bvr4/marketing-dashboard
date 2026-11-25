// ORDER #3795: Google Ads API access now comes from the Cloud project
// (ihg-sales-brain), not a developer token. Pinned here:
//   - no developer-token header is ever sent, on either read;
//   - a Test-level project's CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION answer is
//     a clear Waiting line (with its one fix) on the live check, on --accounts
//     and on the hourly poll, never a bare 403 or "could not run".
// Every call goes through a fake fetch; no live account is read.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/google-ads-read');
const C = require('../lib/agent-checks');
const job = require('../jobs/ads_monitor');

const ACC = '1234567890';
const NOT_APPROVED_BODY = {
  error: {
    code: 403,
    status: 'PERMISSION_DENIED',
    message: 'The caller does not have permission',
    details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure',
      errors: [{ errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, message: 'test project' }] }],
  },
};

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const a = answers(url, opts);
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  };
  fn.calls = calls;
  return fn;
}

test('no developer-token header on either read, and none named anywhere in the client', async () => {
  const f = fakeFetch((url) => (url.endsWith(R.LIST_PATH) ? { status: 200, body: { resourceNames: [`customers/${ACC}`] } } : { status: 200, body: { results: [] } }));
  const c = R.createClient({ env: {}, fetchImpl: f, token: async () => 'tok' });
  await c.accessible();
  await c.search(ACC, 'SELECT customer.id FROM customer LIMIT 1');
  assert.strictEqual(f.calls.length, 2);
  for (const k of f.calls) {
    assert.deepStrictEqual(Object.keys(k.opts.headers).map((h) => h.toLowerCase()).filter((h) => /developer/.test(h)), []);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'google-ads-read.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/developer-token|developer_token|developerToken/i.test(src), 'the client code never sets a developer token');
});

test('errorCodes reads Google Ads codes by value, whatever category they sit under', () => {
  assert.deepStrictEqual(R.errorCodes(NOT_APPROVED_BODY), [R.NOT_APPROVED]);
  assert.deepStrictEqual(R.errorCodes({ error: { details: [{ errors: [{ errorCode: { someOtherError: R.NOT_APPROVED } }] }] } }), [R.NOT_APPROVED]);
  assert.deepStrictEqual(R.errorCodes({}), []);
  assert.deepStrictEqual(R.errorCodes({ error: { status: 'PERMISSION_DENIED' } }), []);
});

test('the client carries the code, and waitingLine names the project and the Explorer fix', async () => {
  const f = fakeFetch(() => ({ status: 403, body: NOT_APPROVED_BODY }));
  const c = R.createClient({ env: {}, fetchImpl: f, token: async () => 'tok' });
  let err;
  await c.search(ACC, 'SELECT customer.id FROM customer LIMIT 1').catch((e) => { err = e; });
  assert.ok(err);
  assert.strictEqual(err.status, 403);
  assert.deepStrictEqual(err.codes, [R.NOT_APPROVED]);
  assert.match(err.message, /CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION/);
  const w = R.waitingLine(err);
  assert.match(w, /^Waiting on Google: /);
  assert.match(w, /ihg-sales-brain/);
  assert.match(w, /Explorer access/);
  assert.match(w, /Overview page in Cloud Console/);
  assert.strictEqual(R.waitingLine(new Error('Google Ads answered 403: PERMISSION_DENIED')), null, 'a plain 403 is not this Waiting state');
});

test('listAccounts does not hide a Test-level project inside an account name', async () => {
  const f = fakeFetch((url) => (url.endsWith(R.LIST_PATH) ? { status: 200, body: { resourceNames: [`customers/${ACC}`] } } : { status: 403, body: NOT_APPROVED_BODY }));
  const c = R.createClient({ env: {}, fetchImpl: f, token: async () => 'tok' });
  await assert.rejects(R.listAccounts(c), (e) => R.waitingLine(e) !== null);
});

test('the live check: a Test-level project is a clear Waiting line, not "the Brain sees N accounts" and not "could not run"', async () => {
  const chk = { id: 'api:google-ads', kind: 'google_ads_api', label: 'x' };
  const e = Object.assign(new Error('Google Ads answered 403: PERMISSION_DENIED (CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION)'), { status: 403, codes: [R.NOT_APPROVED] });
  const got = await C.runCheck(chk, { adsAccounts: async () => { throw e; } });
  assert.strictEqual(got.ok, false);
  assert.strictEqual(got.reason, R.waitingLine(e));
  const other = await C.runCheck(chk, { adsAccounts: async () => { throw new Error('boom'); } });
  assert.match(other.reason, /could not run: boom/);
  // The live context reads one account after listing, so a Test project cannot pass the setup proof.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-checks.js'), 'utf8');
  assert.match(src, /c\.search\(ids\[0\], 'SELECT customer\.id FROM customer LIMIT 1'\)/);
});

test('--accounts and the hourly poll print the Waiting line and exit 1, writing nothing', async () => {
  const e = Object.assign(new Error('Google Ads answered 403'), { status: 403, codes: [R.NOT_APPROVED] });
  const client = { accessible: async () => [ACC], search: async () => { throw e; } };
  const lines = [];
  assert.strictEqual(await job.main({ argv: ['--accounts'], log: (l) => lines.push(l), env: {}, client }), 1);
  assert.deepStrictEqual(lines, [R.waitingLine(e)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads3795-'));
  const poll = [];
  assert.strictEqual(await job.main({ argv: [], log: (l) => poll.push(l), env: { ADS_API_LIVE: 'on', ADS_MONITOR_STATE_DIR: dir }, client }), 1);
  assert.deepStrictEqual(poll, [R.waitingLine(e)]);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  // Any other failure still throws as before.
  await assert.rejects(job.main({ argv: ['--accounts'], log: () => {}, env: {}, client: { accessible: async () => { throw new Error('boom'); } } }), /boom/);
});
