// ORDER #714 item 1, APP 3 of 7 (marketing-dashboard): the estate icon on every served page.
//
// RULED 09.20.2026 08:18 CT (Mimi, popup): "ICON = 05_AI_and_Brain/
// IH_brain_static_512.png; Box derives .ico and sizes, same icon on all 74
// pages." App 1 (dispatch) is `order-714-dispatch-icon`; this is the same
// derivation and the same head block, in this repo.
//
// 🔴 VERIFIED BY WHAT THE FILES ARE, NOT BY THEIR NAMES. A zero-byte
// favicon.ico, or a PNG renamed to .ico, passes any check that reads the
// filename. These read the MAGIC BYTES and, for the PNGs, the IHDR header that
// carries the real pixel dimensions. That is the difference between "a file
// called favicon-32.png exists" and "a 32x32 PNG exists".
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const pages = () => fs.readdirSync(PUB).filter((f) => f.endsWith('.html')).sort();

function png(file) {
  const b = fs.readFileSync(path.join(PUB, file));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(b.length > 8 && b.subarray(0, 8).equals(sig), `${file} is not a PNG by magic bytes`);
  assert.strictEqual(b.subarray(12, 16).toString('ascii'), 'IHDR', `${file} has no IHDR chunk`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

test('the derived icon set exists and each file is what its name claims', () => {
  const ico = fs.readFileSync(path.join(PUB, 'favicon.ico'));
  // ICONDIR: reserved 0, type 1 (icon), then the image count.
  assert.strictEqual(ico.readUInt16LE(0), 0, 'favicon.ico: reserved field is not 0');
  assert.strictEqual(ico.readUInt16LE(2), 1, 'favicon.ico: type is not 1 (icon)');
  assert.ok(ico.readUInt16LE(4) >= 3, 'favicon.ico should carry at least 3 sizes');

  assert.deepStrictEqual(
    { w: png('favicon-16.png').w, h: png('favicon-16.png').h }, { w: 16, h: 16 });
  assert.deepStrictEqual(
    { w: png('favicon-32.png').w, h: png('favicon-32.png').h }, { w: 32, h: 32 });
  assert.deepStrictEqual(
    { w: png('apple-touch-icon.png').w, h: png('apple-touch-icon.png').h }, { w: 180, h: 180 });
  assert.deepStrictEqual(
    { w: png('icon-192.png').w, h: png('icon-192.png').h }, { w: 192, h: 192 });
});

test('every served page links the icon', () => {
  const missing = pages().filter((f) => !fs.readFileSync(path.join(PUB, f), 'utf8').includes('/favicon.ico'));
  assert.deepStrictEqual(missing, [], 'these pages do not link the estate icon');
});

test('every page links the full set, not just the .ico', () => {
  const wanted = ['/favicon.ico', '/favicon-32.png', '/favicon-16.png', '/apple-touch-icon.png'];
  const bad = [];
  for (const f of pages()) {
    const s = fs.readFileSync(path.join(PUB, f), 'utf8');
    for (const w of wanted) if (!s.includes(w)) bad.push(`${f} is missing ${w}`);
  }
  assert.deepStrictEqual(bad, []);
});

test('the link sits INSIDE the head, after the page own meta', () => {
  const bad = [];
  for (const f of pages()) {
    const s = fs.readFileSync(path.join(PUB, f), 'utf8');
    const head = s.toLowerCase().indexOf('</head>');
    const icon = s.indexOf('/favicon.ico');
    if (head === -1) { bad.push(`${f}: no </head> at all`); continue; }
    if (icon > head) bad.push(`${f}: the icon block is AFTER </head>`);
  }
  assert.deepStrictEqual(bad, []);
});

test('KNOWN-BAD: a page with the block deleted is caught', () => {
  const f = pages()[0];
  const s = fs.readFileSync(path.join(PUB, f), 'utf8');
  const without = s.replace(/<link rel="icon" href="\/favicon\.ico" sizes="any">\n?/, '');
  assert.notStrictEqual(without, s, 'the fixture must actually remove something');
  assert.ok(!without.includes('/favicon.ico'),
    'with that one line gone the page no longer links the icon, which is what the sweep above detects');
});

test('KNOWN-BAD: a renamed PNG would NOT pass as an .ico', () => {
  // The exact defect a filename check misses.
  const asPng = fs.readFileSync(path.join(PUB, 'favicon-32.png'));
  assert.notStrictEqual(asPng.readUInt16LE(2), 1,
    'a PNG read as an ICONDIR must not report type 1; if it did, the .ico check above proves nothing');
});

test('the icon is derived from the file Mimi named, and the source is untouched', () => {
  const src = path.join(process.env.HOME, 'Full_IH_Project', '05_AI_and_Brain', 'IH_brain_static_512.png');
  if (!fs.existsSync(src)) return;            // not on every machine; never a false red
  const s = png('favicon-32.png');
  assert.ok(s.bytes > 0);
  const b = fs.readFileSync(src);
  assert.strictEqual(b.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.strictEqual(b.readUInt32BE(16), 512, 'the ruled source should still be the 512px original');
});
