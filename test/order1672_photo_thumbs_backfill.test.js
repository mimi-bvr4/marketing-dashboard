'use strict';
// ORDER #1672: thumbnails for the 110,737 photos the first load skipped.
// Newest first, timed, a missing thumbnail is stamped and skipped, never spun on.
const { test } = require('node:test');
const assert = require('node:assert');
const { backfillThumbs, parseArgs, THUMB_QUEUE_SQL } = require('../jobs/photo_crawl');

function fakePool(ids) {
  const rows = new Map(ids.map((id, i) => [id, { id, order: i, thumb: null, missing: false }]));
  return { rows, async query(sql, p) {
    if (/CREATE|ALTER|INDEX/.test(sql)) return { rows: [] };
    if (sql === THUMB_QUEUE_SQL) return { rows: [...rows.values()].filter((r) => !r.thumb && !r.missing).sort((a, b) => a.order - b.order).slice(0, p[0]).map((r) => ({ drive_id: r.id })) };
    if (/SET thumb = \$2/.test(sql)) { rows.get(p[0]).thumb = p[1]; return { rows: [] }; }
    if (/SET thumb_missing_at/.test(sql)) { rows.get(p[0]).missing = true; return { rows: [] }; }
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: [...rows.values()].filter((r) => !r.thumb && !r.missing).length }] };
    return { rows: [] };
  } };
}
const client = (opts = {}) => ({
  calls: [],
  async getFile(id) { this.calls.push(id); if (opts.gone && opts.gone.includes(id)) throw new Error('Drive 404: File not found'); return { id, thumbnailLink: opts.noLink && opts.noLink.includes(id) ? null : `https://lh3/${id}=s220` }; },
  async thumbnail(f) { return { bytes: Buffer.alloc(30 * 1024, 1), w: 400, h: 300 }; },
});

test('args: --thumbs is its own mode, 45 minute default budget, concurrency 8', () => {
  const a = parseArgs(['--thumbs']);
  assert.strictEqual(a.mode, 'thumbs'); assert.strictEqual(a.budgetMin, 45); assert.strictEqual(a.concurrency, 8);
  assert.throws(() => parseArgs(['--thumbs', '--changes']));
});

test('queue is newest first and skips removed, filled and recently-missing rows', () => {
  assert.match(THUMB_QUEUE_SQL, /ORDER BY taken_date DESC NULLS LAST, created_time DESC NULLS LAST/);
  assert.match(THUMB_QUEUE_SQL, /thumb IS NULL AND removed_at IS NULL/);
  assert.match(THUMB_QUEUE_SQL, /interval '30 days'/);
});

test('fills every photo it can, stamps no-thumbnail and deleted files, reports what is left', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `p${i}`);
  const pool = fakePool(ids);
  const logs = [];
  const r = await backfillThumbs({ client: client({ noLink: ['p3'], gone: ['p7'] }), pool, log: (l) => logs.push(l), batch: 10, concurrency: 4 });
  assert.strictEqual(r.filled, 23); assert.strictEqual(r.missing, 2); assert.strictEqual(r.failed, 0); assert.strictEqual(r.left, 0);
  assert.strictEqual(r.avgKb, 30);
  assert.match(logs.join('\n'), /filled 23, no thumbnail from Drive 2, failed 0, average 30 KB, still to do 0/);
});

test('the budget stops it between slices, and a run that cannot progress stops instead of spinning', async () => {
  let t = 0;
  const pool = fakePool(Array.from({ length: 50 }, (_, i) => `p${i}`));
  const r = await backfillThumbs({ client: client(), pool, log: () => {}, batch: 10, concurrency: 5, budgetMin: 1, now: () => (t += 20000) });
  assert.ok(r.filled > 0 && r.left > 0, 'partial, with work left for tomorrow');
  const bad = { async getFile() { throw new Error('Drive 500'); }, async thumbnail() {} };
  const r2 = await backfillThumbs({ client: bad, pool: fakePool(['a', 'b']), log: () => {}, batch: 10 });
  assert.strictEqual(r2.failed, 2); assert.strictEqual(r2.left, 2);
});
