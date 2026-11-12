// ORDER #3276: PR Patty read only the first 8000 characters of each press email,
// so the 11.12.2026 HARO Morning Edition (28,645 characters) stopped partway
// through request 6 of 20. She now reads the whole email, and the coverage is
// measured by code and stated, never guessed and never cut silently.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const ma = require('../lib/mail-alerts');
const { mailAlertsSource } = require('../lib/agent-sources');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { client_email: 'x@y.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

// A HARO edition in the real layout: an index, then each request in full.
function haro(n, { pad = 1200 } = {}) {
  const titles = Array.from({ length: n }, (_, i) => (i === 12 ? 'Aesthetic Christmas Tree Decor - Article for Yahoo' : `Request number ${i + 1} topic`));
  const index = titles.map((t, i) => `${i + 1}) ${t} (Outlet ${i + 1})`).join('\n');
  const full = titles.map((t, i) => [
    `${i + 1}) Summary: ${t}`, `Name: Reporter ${i + 1}`, 'Category: General', `Email: query-${i + 1}@helpareporter.net`,
    `Media Outlet: Outlet ${i + 1}`, 'Deadline: 5:00 PM ET - 14 November', '', 'Query:', '',
    `QUERY-BODY-${i + 1} ` + 'Looking for expert input on this topic. '.repeat(Math.ceil(pad / 40)), '', 'Requirements:', 'US based', '', 'Back to Top', '',
  ].join('\n')).join('\n');
  return `HARO Queries for November 12, 2026 - Morning Edition\n\nINDEX\n\n${index}\n\n-----\n\n${full}`;
}

function fetchFor(bodies) {
  const calls = [];
  const f = async (u, o = {}) => {
    calls.push(o.method || 'GET');
    if (u.includes('/messages?')) return json(200, { messages: Object.keys(bodies).map((id) => ({ id })) });
    const id = u.match(/messages\/(\w+)\?/)[1];
    if (!bodies[id]) return json(404, { error: { message: 'Requested entity was not found.' } });
    return json(200, { payload: { headers: [{ name: 'From', value: 'HARO <haro@helpareporter.com>' }, { name: 'Subject', value: 'HARO Queries for November 12, 2026 - Morning Edition' }, { name: 'Date', value: 'Thu, 12 Nov 2026 10:32:44 +0000' }],
      mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64(bodies[id]) } }, { mimeType: 'text/html', body: { data: b64('<p>html copy</p>') } }] } });
  };
  return { f, calls };
}

const SRC = { type: 'mail_alerts', match: ['haro', 'help a reporter'], days: 1 };

test('a 20-request HARO edition longer than the old 8000 cap is read in full: 20 of 20', async () => {
  const body = haro(20);
  assert.ok(body.length > 8000 * 3, `fixture is ${body.length} characters`);
  const { f, calls } = fetchFor({ m1: body });
  const r = await mailAlertsSource(SRC, { env: {}, fetch: f, saKey: KEY, saToken: async () => 'tok' });
  assert.ok(r.ok, r.why);
  assert.ok(calls.every((m) => m === 'GET'), 'Gmail is read with GET only');
  for (let i = 1; i <= 20; i++) assert.ok(r.text.includes(`QUERY-BODY-${i} `), `request ${i} is in the text`);
  assert.match(r.text, /Aesthetic Christmas Tree Decor/);
  assert.match(r.text, /MEASURED BY CODE: Requests in this email: 20\. Read in full: 20 of 20\./);
  assert.doesNotMatch(r.text, /truncated|CUT HERE|NOT read/);
  assert.match(r.table, /Read in full: 20 of 20/);
  assert.deepStrictEqual(r.measured, { emails: 1, unread: 0, cut: 0 });
});

test('an email over the read ceiling is cut out loud: what was read, what was not, and why', async () => {
  const body = haro(20, { pad: Math.ceil(ma.BODY_CHARS / 12) });
  assert.ok(body.length > ma.BODY_CHARS);
  const { f } = fetchFor({ m1: body });
  const r = await mailAlertsSource(SRC, { env: {}, fetch: f, saKey: KEY, saToken: async () => 'tok' });
  assert.ok(r.ok, r.why);
  const m = r.text.match(/MEASURED BY CODE: Requests in this email: 20\. Read in full: (\d+) of 20\. NOT read in full: (\d+) to 20\. Reason: the email is (\d+) characters and only the first (\d+) were read\./);
  assert.ok(m, r.text.slice(0, 600));
  assert.strictEqual(Number(m[2]), Number(m[1]) + 1, 'every request after the last whole one is listed');
  assert.ok(Number(m[1]) < 20);
  assert.strictEqual(Number(m[3]), body.trim().length);
  assert.match(r.text, /\[CUT HERE: the email is \d+ characters; only the first 200000 were read\]/);
  assert.deepStrictEqual(r.measured, { emails: 1, unread: 0, cut: 1 });
});

test('an email that could not be read is named, never dropped silently', async () => {
  const { f } = fetchFor({ m1: haro(3) });
  const list = async (u, o) => (u.includes('/messages?') ? json(200, { messages: [{ id: 'm1' }, { id: 'gone' }] }) : f(u, o));
  const r = await mailAlertsSource(SRC, { env: {}, fetch: list, saKey: KEY, saToken: async () => 'tok' });
  assert.ok(r.ok);
  assert.match(r.text, /1 email\(s\) could not be read: gone \(Requested entity was not found\.\)/);
  assert.match(r.table, /Could not be read: gone/);
});

test('coverage: a request with no Query block is not counted as read; an email without numbered requests makes no claim', () => {
  const body = haro(4).replace(/(4\) Summary:[\s\S]*?)Query:/, '$1');
  assert.deepStrictEqual(ma.requestCoverage(body), { total: 4, read: 3, missing: [4] });
  assert.match(ma.coverageLine(ma.requestCoverage(body)), /Read in full: 3 of 4\. NOT read in full: 4\. Reason: those requests are missing/);
  assert.strictEqual(ma.requestCoverage('Qwoted roundup\nWedding planner needed for Brides. Deadline Oct 15.'), null);
  assert.strictEqual(ma.coverageLine(null), null);
  // an index that lists more requests than the text carries in full
  const short = haro(5).replace(/\n5\) Summary:[\s\S]*$/, '');
  const cov = ma.requestCoverage(short.replace('INDEX\n\n', 'INDEX\n\n6) Extra listed request (Outlet 6)\n'));
  assert.strictEqual(cov.total, 6);
  assert.deepStrictEqual(cov.missing, [5, 6]);
});

test('every text/plain part is read, in order', () => {
  const t = ma.bodyText({ mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: b64('part one') } }, { mimeType: 'text/plain', body: { data: b64('part two') } }] });
  assert.strictEqual(t, 'part one\n\npart two');
});
