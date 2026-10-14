'use strict';
// ORDER #1788: the thumbnail night run. A photo with no thumbnail gets one, a
// rerun stores nothing twice, a Drive 403 stops the run cleanly and says so,
// the measured store is projected to the whole archive, and the nightly can run
// with tagging off (#1789 picks the tag model).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { backfillThumbs, THUMB_QUEUE_SQL, THUMB_STORED_SQL } = require('../jobs/photo_crawl');

function fakePool(ids) {
  const rows = new Map(ids.map((id, i) => [id, { id, order: i, thumb: null, missing: false, sets: 0 }]));
  return { rows, async query(sql, p) {
    if (/CREATE|ALTER|INDEX/.test(sql)) return { rows: [] };
    if (sql === THUMB_QUEUE_SQL) return { rows: [...rows.values()].filter((r) => !r.thumb && !r.missing).sort((a, b) => a.order - b.order).slice(0, p[0]).map((r) => ({ drive_id: r.id })) };
    if (sql === THUMB_STORED_SQL) {
      const have = [...rows.values()].filter((r) => r.thumb);
      return { rows: [{ stored: have.length, bytes: String(have.reduce((n, r) => n + r.thumb.length, 0)) }] };
    }
    if (/SET thumb = \$2/.test(sql)) {
      assert.match(sql, /AND thumb IS NULL/, 'the write itself refuses to overwrite a stored thumbnail');
      const r = rows.get(p[0]); if (!r.thumb) { r.thumb = p[1]; r.sets++; } return { rows: [] };
    }
    if (/SET thumb_missing_at/.test(sql)) { rows.get(p[0]).missing = true; return { rows: [] }; }
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: [...rows.values()].filter((r) => !r.thumb && !r.missing).length }] };
    return { rows: [] };
  } };
}
const client = (opts = {}) => ({
  thumbs: 0,
  async getFile(id) {
    if (opts.forbidden && opts.forbidden(id)) throw new Error('Drive 403: The user does not have sufficient permissions for this file.');
    return { id, thumbnailLink: `https://lh3/${id}=s220` };
  },
  async thumbnail() { this.thumbs++; return { bytes: Buffer.alloc(40 * 1024, 1), w: 400, h: 300 }; },
});

test('a photo with no thumbnail gets one, and the stored size is measured and projected', async () => {
  const pool = fakePool(['a', 'b', 'c', 'd']);
  pool.rows.get('d').missing = true;                         // stamped no-thumbnail on an earlier night
  const logs = [];
  const r = await backfillThumbs({ client: client(), pool, log: (l) => logs.push(l), batch: 2, concurrency: 2 });
  assert.strictEqual(r.filled, 3);
  for (const id of ['a', 'b', 'c']) assert.ok(pool.rows.get(id).thumb, `${id} has a thumbnail`);
  assert.strictEqual(r.stored, 3); assert.strictEqual(r.storedBytes, 3 * 40 * 1024);
  assert.match(logs.join('\n'), /stored 3 \(0 MB\), projected total 0 MB/);
});

test('projection: measured average times stored plus still to do', async () => {
  let t = 0;
  const pool = fakePool(Array.from({ length: 100 }, (_, i) => `p${i}`));
  const r = await backfillThumbs({ client: client(), pool, log: () => {}, batch: 10, concurrency: 10, budgetMin: 1, now: () => (t += 15000) });
  assert.ok(r.left > 0 && r.stored > 0);
  assert.strictEqual(r.projectedBytes, 100 * 40 * 1024);
});

test('a rerun stores nothing twice and asks Drive for nothing', async () => {
  const pool = fakePool(['a', 'b', 'c']);
  await backfillThumbs({ client: client(), pool, log: () => {}, batch: 10 });
  const c2 = client();
  const r2 = await backfillThumbs({ client: c2, pool, log: () => {}, batch: 10 });
  assert.strictEqual(r2.filled, 0); assert.strictEqual(c2.thumbs, 0);
  for (const row of pool.rows.values()) assert.strictEqual(row.sets, 1, `${row.id} written once`);
});

test('a Drive 403 stops the run cleanly, stamps nothing, and says so', async () => {
  const pool = fakePool(Array.from({ length: 30 }, (_, i) => `p${i}`));
  const logs = [];
  const r = await backfillThumbs({ client: client({ forbidden: () => true }), pool, log: (l) => logs.push(l), batch: 10, concurrency: 4 });
  assert.ok(r.stopped && /Drive 403/.test(r.stopped));
  assert.strictEqual(r.filled, 0); assert.strictEqual(r.missing, 0);
  for (const row of pool.rows.values()) assert.strictEqual(row.missing, false, 'a 403 never parks a photo for 30 days');
  assert.strictEqual(r.left, 30);
  assert.match(logs.join('\n'), /THUMBS STOPPED: Drive refused \(Drive 403/);
});

test('a 403 midway keeps what was already stored and stops before the next slice', async () => {
  const pool = fakePool(Array.from({ length: 20 }, (_, i) => `p${i}`));
  const c = client({ forbidden: (id) => Number(id.slice(1)) >= 5 });
  const r = await backfillThumbs({ client: c, pool, log: () => {}, batch: 20, concurrency: 5 });
  assert.strictEqual(r.filled, 5); assert.ok(r.stopped);
  assert.strictEqual(r.left, 15);
});

test('photo_nightly.sh: PHOTO_TAG_CAP=0 runs changes and thumbs, never the tagger', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'o1788-'));
  fs.mkdirSync(path.join(home, 'repos', 'marketing-dashboard'), { recursive: true });
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(home, 'calls.txt');
  fs.writeFileSync(path.join(bin, 'railway'), `#!/bin/bash\necho "$*" >> "${calls}"\n`, { mode: 0o755 });
  const script = path.join(__dirname, '..', 'jobs', 'photo_nightly.sh');
  const run = (cap) => {
    fs.writeFileSync(calls, '');
    const r = spawnSync('/bin/bash', [script], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, PHOTO_TAG_CAP: cap }, encoding: 'utf8' });
    return { r, calls: fs.readFileSync(calls, 'utf8') };
  };
  const off = run('0');
  assert.strictEqual(off.r.status, 0, off.r.stdout + off.r.stderr);
  assert.match(off.r.stdout, /TAGGING OFF/);
  assert.match(off.calls, /photo_crawl\.js --changes/); assert.match(off.calls, /photo_crawl\.js --thumbs/);
  assert.doesNotMatch(off.calls, /photo_tag\.js/);
  const on = run('1000');                                    // known-good: the tagger still runs when asked
  assert.match(on.calls, /photo_tag\.js --apply --cap 1000/);
  fs.rmSync(home, { recursive: true, force: true });
});
