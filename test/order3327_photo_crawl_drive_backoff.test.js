// ORDER #3327: the nightly --changes crawl survives Drive's 403
// userRateLimitExceeded / rateLimitExceeded with truncated exponential backoff
// and jitter, gives up after a fixed cap, and keeps its place in the feed.
// Fake Drive client, fake sleep: no network and no real waiting.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const A = require('../lib/photo-archive');
const D = require('../lib/drive-client');
const J = require('../jobs/photo_crawl');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { client_email: 'test@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

function mockPool(answers = () => []) {
  const queries = [];
  return { queries, query: async (sql, params) => { queries.push({ sql, params }); return { rows: answers(sql, params) || [] }; } };
}
const storedToken = (tok) => (sql) => (/SELECT start_page_token/.test(sql) ? [{ start_page_token: tok }] : []);
const runRows = (pool) => pool.queries.filter((q) => /INSERT INTO photo_crawl_runs/.test(q.sql));

// The error the real client throws for a Drive refusal (see the HTTP test below).
function driveError(status, reason, message) {
  const e = new Error(`Drive ${status}: ${message}`);
  e.status = status;
  e.reason = reason;
  return e;
}
const RATE = () => driveError(403, 'userRateLimitExceeded', 'User rate limit exceeded.');

// `pages` maps a page token to what that page does: an answer, or a function that throws.
function fakeClient(pages) {
  const asked = [];
  return {
    asked,
    serviceAccount: 'mock',
    listPage: async () => ({ files: [] }),
    getFile: async () => ({ id: A.ROOT_FOLDER_ID, driveId: 'drv' }),
    thumbnail: async () => null,
    changesPage: async (tok) => {
      asked.push(tok);
      const p = pages[tok];
      if (typeof p === 'function') return p();
      if (!p) throw new Error(`unexpected token ${tok}`);
      return p;
    },
  };
}
function fakeSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test('the real client tags a Drive refusal with its status and reason, message unchanged', async () => {
  const fetchImpl = async (url) => {
    if (String(url) === D.TOKEN_URL) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    return { ok: false, status: 403, json: async () => ({ error: { code: 403, message: 'User rate limit exceeded.',
      errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded', message: 'User rate limit exceeded.' }] } }) };
  };
  const c = D.createDriveClient({ key: KEY, fetchImpl });
  await assert.rejects(c.changesPage('1', 'd'), (e) => {
    assert.strictEqual(e.message, 'Drive 403: User rate limit exceeded.');
    assert.strictEqual(e.status, 403);
    assert.strictEqual(e.reason, 'userRateLimitExceeded');
    assert.ok(D.isRateLimit(e));
    return true;
  });
});

test('a 403 userRateLimitExceeded, then a 200: the crawl retries, succeeds and stores the new token', async () => {
  let n = 0;
  const client = fakeClient({ 'tok-1': () => { n += 1; if (n === 1) throw RATE(); return { changes: [], newStartPageToken: 'tok-2' }; } });
  const pool = mockPool(storedToken('tok-1'));
  const s = fakeSleep();
  const r = await J.main({ argv: ['--changes'], client, pool, log: () => {}, backoff: { sleep: s.sleep, random: () => 0 } });
  assert.strictEqual(r.newStartPageToken, 'tok-2');
  assert.deepStrictEqual(client.asked, ['tok-1', 'tok-1']);
  assert.strictEqual(s.waits.length, 1);
  assert.strictEqual(runRows(pool).at(-1).params[8], 'tok-2');
});

test('rateLimitExceeded (project-wide) and a bare 429 are retried too', async () => {
  for (const err of [driveError(403, 'rateLimitExceeded', 'Rate Limit Exceeded'), driveError(429, 'rateLimitExceeded', 'Too many requests')]) {
    let n = 0;
    const client = fakeClient({ 'tok-1': () => { n += 1; if (n === 1) throw err; return { changes: [], newStartPageToken: 'tok-2' }; } });
    const s = fakeSleep();
    const r = await J.main({ argv: ['--changes'], client, pool: mockPool(storedToken('tok-1')), log: () => {},
      backoff: { sleep: s.sleep, random: () => 0 } });
    assert.strictEqual(r.newStartPageToken, 'tok-2');
  }
});

test('a 403 rate limit on every try: stops at the cap, keeps the last good token, says how many tries', async () => {
  const client = fakeClient({ 'tok-1': () => { throw RATE(); } });
  const pool = mockPool(storedToken('tok-1'));
  const s = fakeSleep();
  await assert.rejects(J.main({ argv: ['--changes'], client, pool, log: () => {}, backoff: { sleep: s.sleep, random: () => 0 } }),
    (e) => {
      assert.strictEqual(e.message, `Drive 403: User rate limit exceeded (gave up after ${D.BACKOFF.tries} tries)`);
      // the line the nightly .err gets, which the #1220 collector's RUN_WATCH reads
      assert.match(`photo_crawl FAILED: ${e.message}`, /^photo_crawl FAILED: Drive 403: User rate limit exceeded \(gave up after \d+ tries\)$/);
      return true;
    });
  assert.strictEqual(client.asked.length, D.BACKOFF.tries);
  assert.strictEqual(s.waits.length, D.BACKOFF.tries - 1);
  // No token moved: nothing was read, so the stored tok-1 stays the newest one.
  assert.strictEqual(runRows(pool).length, 0);
});

test('a 403 that is NOT a rate limit fails at once, with no retry, as it does today', async () => {
  for (const err of [driveError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.'),
    driveError(403, 'teamDriveMembershipRequired', 'The attempted action requires shared drive membership.')]) {
    const client = fakeClient({ 'tok-1': () => { throw err; } });
    const s = fakeSleep();
    await assert.rejects(J.main({ argv: ['--changes'], client, pool: mockPool(storedToken('tok-1')), log: () => {},
      backoff: { sleep: s.sleep, random: () => 0 } }), (e) => e.message === err.message);
    assert.strictEqual(client.asked.length, 1);
    assert.strictEqual(s.waits.length, 0);
  }
});

test('the wait between tries grows and never goes over the cap', async () => {
  const s = fakeSleep();
  await assert.rejects(D.withBackoff(async () => { throw RATE(); }, { sleep: s.sleep, random: () => 0.999, tries: 10 }), /gave up after 10 tries/);
  assert.strictEqual(s.waits.length, 9);
  for (let i = 1; i < s.waits.length; i += 1) assert.ok(s.waits[i] >= s.waits[i - 1], `wait ${i} did not grow: ${s.waits}`);
  assert.ok(s.waits[1] > s.waits[0]);
  assert.ok(s.waits.every((w) => w <= D.BACKOFF.maxMs), `a wait went over ${D.BACKOFF.maxMs}: ${s.waits}`);
  assert.strictEqual(s.waits.at(-1), D.BACKOFF.maxMs);
});

test('jitter: the wait carries a random part, so many Box jobs do not retry in step', async () => {
  const a = fakeSleep();
  const b = fakeSleep();
  await assert.rejects(D.withBackoff(async () => { throw RATE(); }, { sleep: a.sleep, random: () => 0, tries: 2 }));
  await assert.rejects(D.withBackoff(async () => { throw RATE(); }, { sleep: b.sleep, random: () => 0.5, tries: 2 }));
  assert.ok(b.waits[0] > a.waits[0]);
});

test('giving up mid-feed saves the page it reached, and the next night resumes there, not from zero', async () => {
  const ch = (id) => ({ fileId: id, removed: true });
  // night 1: page tok-1 reads fine, then page p2 is rate-limited on every try
  const night1 = fakeClient({ 'tok-1': { changes: [ch('a')], nextPageToken: 'p2' }, p2: () => { throw RATE(); } });
  const pool1 = mockPool((sql, params) => {
    if (/SELECT start_page_token/.test(sql)) return [{ start_page_token: 'tok-1' }];
    if (/SELECT folder_path FROM photos/.test(sql) && params[0] === 'a') return [{ folder_path: 'Venues / TBT' }];
    return [];
  });
  const lines = [];
  await assert.rejects(J.main({ argv: ['--changes'], client: night1, pool: pool1, log: (l) => lines.push(l),
    backoff: { sleep: fakeSleep().sleep, random: () => 0 } }), /gave up after/);
  // page 1's change was applied, and p2 is the token stored
  assert.ok(pool1.queries.some((q) => /UPDATE photos SET removed_at/.test(q.sql) && q.params[0] === 'a'));
  const saved = runRows(pool1);
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].params[8], 'p2');
  assert.ok(lines.some((l) => /CHANGES PARTIAL/.test(l) && /p2|resume/i.test(l)));

  // night 2: starts from p2, never asks for tok-1 again
  const night2 = fakeClient({ p2: { changes: [], newStartPageToken: 'tok-9' } });
  const r = await J.main({ argv: ['--changes'], client: night2, pool: mockPool(storedToken('p2')), log: () => {},
    backoff: { sleep: fakeSleep().sleep, random: () => 0 } });
  assert.deepStrictEqual(night2.asked, ['p2']);
  assert.strictEqual(r.newStartPageToken, 'tok-9');
});
