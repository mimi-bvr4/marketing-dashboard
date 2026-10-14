'use strict';
// ORDER #1797: photo-archive work runs only in the END-OF-WEEK BONUS window,
// Fri 18:00 CT through Mon 23:59 CT, and stops cleanly while the Box is out of
// usage (the driver's usage_limit_until.txt). The thumbnails and the tagger ask
// before every batch; the nightly asks before anything; the plist only fires on
// Fri, Sat, Sun and Mon nights.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('../lib/photo-window');
const { backfillThumbs, THUMB_QUEUE_SQL, THUMB_STORED_SQL } = require('../jobs/photo_crawl');
const { tagBatch } = require('../lib/photo-tagger');

// 10.14.2026 is a Wednesday; CDT is UTC-5 all of this week.
const at = (s) => new Date(`${s}-05:00`);

test('the window: Thu 23:59 skip, Fri 17:59 skip, Fri 18:00 run, Mon 23:59 run, Tue 00:00 skip', () => {
  assert.strictEqual(W.inBonusWindow(at('2026-10-15T23:59:00')), false, 'Thursday 23:59');
  assert.strictEqual(W.inBonusWindow(at('2026-10-16T17:59:00')), false, 'Friday 17:59');
  assert.strictEqual(W.inBonusWindow(at('2026-10-16T18:00:00')), true, 'Friday 18:00');
  assert.strictEqual(W.inBonusWindow(at('2026-10-17T03:00:00')), true, 'Saturday');
  assert.strictEqual(W.inBonusWindow(at('2026-10-18T12:00:00')), true, 'Sunday');
  assert.strictEqual(W.inBonusWindow(at('2026-10-19T23:59:00')), true, 'Monday 23:59');
  assert.strictEqual(W.inBonusWindow(at('2026-10-20T00:00:00')), false, 'Tuesday 00:00');
  assert.strictEqual(W.inBonusWindow(at('2026-10-14T12:52:00')), false, 'Wednesday, the day it was ruled');
});

test('the window is read on the Nashville clock, not UTC', () => {
  // Fri 23:30 UTC is Fri 18:30 CT (open); Tue 03:00 UTC is Mon 22:00 CT (open).
  assert.strictEqual(W.inBonusWindow(new Date('2026-10-16T23:30:00Z')), true);
  assert.strictEqual(W.inBonusWindow(new Date('2026-10-20T03:00:00Z')), true);
  // Tue 05:30 UTC is Tue 00:30 CT (closed), though UTC says Tuesday either way.
  assert.strictEqual(W.inBonusWindow(new Date('2026-10-20T05:30:00Z')), false);
});

function usageFile(line) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o1797-'));
  const f = path.join(dir, 'usage_limit_until.txt');
  if (line != null) fs.writeFileSync(f, line + '\n');
  return f;
}

test('usage guard: reads the driver\'s usage_limit_until.txt line the way usage_limit.gate() does', () => {
  const sat = at('2026-10-17T22:15:00');
  const held = usageFile('USAGE LIMIT UNTIL 2026-10-18 11:00 CT | weekly limit, reset time as printed | read 10.17.2026 21:00 CT | x');
  assert.strictEqual(W.usageHeldUntil(sat, held), '2026-10-18 11:00');
  const passed = usageFile('USAGE LIMIT UNTIL 2026-10-17 11:00 CT | weekly limit | read x | x');
  assert.strictEqual(W.usageHeldUntil(sat, passed), null, 'a passed reset holds nothing');
  assert.strictEqual(W.usageHeldUntil(sat, usageFile('garbage')), null, 'unreadable reads as none, like the driver');
  assert.strictEqual(W.usageHeldUntil(sat, usageFile(null)), null, 'no file, no limit');
  assert.ok(fs.existsSync(held), 'the photo job never clears the driver\'s file');
});

test('photoGate: closed outside the window, closed while out of usage, open otherwise', () => {
  const none = usageFile(null);
  assert.match(W.photoGate({ now: () => at('2026-10-14T12:52:00'), usageFile: none })(), /outside the photo bonus window/);
  assert.strictEqual(W.photoGate({ now: () => at('2026-10-17T22:15:00'), usageFile: none })(), null);
  const held = usageFile('USAGE LIMIT UNTIL 2026-10-18 11:00 CT | weekly limit | read x | x');
  assert.match(W.photoGate({ now: () => at('2026-10-17T22:15:00'), usageFile: held })(), /out of usage until 2026-10-18 11:00 CT/);
});

function fakePool(ids) {
  const rows = new Map(ids.map((id, i) => [id, { id, order: i, thumb: null }]));
  return { rows, async query(sql, p) {
    if (sql === THUMB_QUEUE_SQL) return { rows: [...rows.values()].filter((r) => !r.thumb).sort((a, b) => a.order - b.order).slice(0, p[0]).map((r) => ({ drive_id: r.id })) };
    if (sql === THUMB_STORED_SQL) return { rows: [{ stored: [...rows.values()].filter((r) => r.thumb).length, bytes: '0' }] };
    if (/SET thumb = \$2/.test(sql)) { rows.get(p[0]).thumb = p[1]; return { rows: [] }; }
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: [...rows.values()].filter((r) => !r.thumb).length }] };
    return { rows: [] };
  } };
}
const client = { async getFile(id) { return { id, thumbnailLink: 'x' }; }, async thumbnail() { return { bytes: Buffer.alloc(10), w: 400, h: 300 }; } };

test('thumbnails: the gate is asked before every batch, and a closed gate pauses cleanly', async () => {
  const pool = fakePool(Array.from({ length: 30 }, (_, i) => `p${i}`));
  let asks = 0;
  const logs = [];
  const r = await backfillThumbs({ client, pool, log: (l) => logs.push(l), batch: 10, concurrency: 10,
    gate: () => (++asks > 1 ? 'outside the photo bonus window (test)' : null) });
  assert.strictEqual(r.filled, 10, 'one batch ran, then the gate closed');
  assert.strictEqual(r.stopped, null, 'a pause is not a Drive stop, so the run is not red');
  assert.match(r.paused, /outside the photo bonus window/);
  assert.strictEqual(r.left, 20, 'the rest waits for the next window');
  assert.match(logs.join('\n'), /THUMBS PAUSED: outside the photo bonus window/);
});

test('thumbnails: a gate closed from the start touches nothing', async () => {
  const pool = fakePool(['a', 'b']);
  const r = await backfillThumbs({ client, pool, log: () => {}, gate: () => 'the Box is out of usage (test)' });
  assert.strictEqual(r.filled, 0); assert.strictEqual(r.left, 2);
});

test('tagger: a closed gate stops before the first batch and sends nothing', async () => {
  let thumbs = 0;
  const logs = [];
  const r = await tagBatch({ photos: [{ drive_id: 'a' }, { drive_id: 'b' }], getThumb: async () => { thumbs++; return Buffer.alloc(1); },
    model: {}, vocab: {}, prompt: '', log: (l) => logs.push(l), gate: () => 'outside the photo bonus window (test)' });
  assert.strictEqual(thumbs, 0, 'no photo was read, so no model call was made');
  assert.strictEqual(r.results.length, 0);
  assert.match(r.paused, /outside/);
  assert.match(logs.join('\n'), /TAGGING PAUSED/);
});

function nightly(nowIso, usage) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'o1797n-'));
  fs.mkdirSync(path.join(home, 'repos', 'marketing-dashboard'), { recursive: true });
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(home, 'calls.txt'); fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(bin, 'railway'), `#!/bin/bash\necho "$*" >> "${calls}"\n`, { mode: 0o755 });
  const r = spawnSync('/bin/bash', [path.join(__dirname, '..', 'jobs', 'photo_nightly.sh')], { encoding: 'utf8',
    env: { HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, PHOTO_TAG_CAP: '0',
      PHOTO_WINDOW_NOW: nowIso, PHOTO_USAGE_FILE: usage || path.join(home, 'none') } });
  const out = { r, calls: fs.readFileSync(calls, 'utf8') };
  fs.rmSync(home, { recursive: true, force: true });
  return out;
}

test('photo_nightly.sh: on a Wednesday nothing runs and the exit is 0', () => {
  const { r, calls } = nightly('2026-10-14T22:15:00-05:00');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PHOTO WINDOW CLOSED/);
  assert.strictEqual(calls, '', 'no railway call: no crawl, no thumbnails, no tagging');
});

test('photo_nightly.sh: Tuesday 00:00 skips, Friday 18:00 runs', () => {
  assert.strictEqual(nightly('2026-10-20T00:00:00-05:00').calls, '');
  assert.match(nightly('2026-10-16T18:00:00-05:00').calls, /photo_crawl\.js --thumbs/);
});

test('photo_nightly.sh: inside the window but out of usage, nothing runs', () => {
  const held = usageFile('USAGE LIMIT UNTIL 2026-10-18 11:00 CT | weekly limit | read x | x');
  const { r, calls } = nightly('2026-10-17T22:15:00-05:00', held);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /out of usage until 2026-10-18 11:00 CT/);
  assert.strictEqual(calls, '');
});

test('the plist fires on Fri, Sat, Sun and Mon nights only, inside the window', () => {
  const xml = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'launchd', 'com.infinitybrain.photo-archive-nightly.plist'), 'utf8');
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const entries = [...body.matchAll(/<dict>\s*<key>Weekday<\/key>\s*<integer>(\d)<\/integer>\s*<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>\s*<\/dict>/g)]
    .map((m) => ({ dow: Number(m[1]), hour: Number(m[2]), minute: Number(m[3]) }));
  assert.deepStrictEqual(entries.map((e) => e.dow), [5, 6, 0, 1]);
  // Each fire time is inside the window on the Nashville clock (Fri 10.16 .. Mon 10.19).
  const day = { 5: '16', 6: '17', 0: '18', 1: '19' };
  for (const e of entries) {
    const d = at(`2026-10-${day[e.dow]}T${String(e.hour).padStart(2, '0')}:${String(e.minute).padStart(2, '0')}:00`);
    assert.ok(W.inBonusWindow(d), `Weekday ${e.dow} ${e.hour}:${e.minute} is inside the window`);
  }
  assert.match(body, /<key>RunAtLoad<\/key>\s*<false\/>/, 'loading still fires nothing');
});
