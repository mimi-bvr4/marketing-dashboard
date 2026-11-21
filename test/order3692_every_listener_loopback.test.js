'use strict';
// ORDER #3692 (#3658 planning / #3673 dispatch follow-on): no marketing-dashboard
// test file starts a server without the loopback host. A `.listen(0)` or
// `.listen(0, cb)` binds the dual-stack wildcard `::`; while `node --test` runs
// files in parallel, another suite can bind 127.0.0.1:<that same port> and
// answer requests meant for this one (planning #3652 proved the shadow; REPLY
// #3655's base red was one). Every `.listen(` under test/ must pass '127.0.0.1'.
// server.js's own production listen is outside test/ and is not scanned.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;

// This file carries bare-listen strings as scanner fixtures.
const EXEMPT = new Set([path.basename(__filename)]);

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Argument text of the call whose '(' sits at `open`.
function argsOf(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

// Every `.listen(` call, outside a comment line, whose arguments do not name
// '127.0.0.1'. Returns "<line>: <text>" per offender.
function bareListens(src) {
  const lines = src.split('\n');
  const bad = [];
  const re = /\.listen\(/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    const text = lines[line - 1].trim();
    if (/^(\/\/|\*|\/\*)/.test(text)) continue;
    if (/['"]127\.0\.0\.1['"]/.test(argsOf(src, m.index + m[0].length - 1))) continue;
    bad.push(line + ': ' + text);
  }
  return bad;
}

test('the scan finds the test listeners at all (guards against a scan that silently matches nothing)', () => {
  let n = 0;
  for (const f of jsFiles(TEST_DIR)) {
    if (EXEMPT.has(path.basename(f))) continue;
    n += (fs.readFileSync(f, 'utf8').match(/\.listen\(/g) || []).length;
  }
  assert.ok(n >= 40, 'expected at least 40 .listen( calls under test/, found ' + n);
});

test("no marketing-dashboard test file listens without the loopback host: every .listen( passes '127.0.0.1'", () => {
  const offenders = [];
  for (const f of jsFiles(TEST_DIR)) {
    if (EXEMPT.has(path.basename(f))) continue;
    const bad = bareListens(fs.readFileSync(f, 'utf8'));
    if (bad.length) offenders.push(path.relative(TEST_DIR, f) + ' (' + bad.length + ') first at ' + bad[0]);
  }
  assert.deepEqual(offenders, [], 'test servers listening on the wildcard:\n  ' + offenders.join('\n  '));
});

test('the scanner itself: a bare listen is caught, a loopback listen and a comment are not', () => {
  const bad = [
    'const srv = app.listen(0);',
    'await new Promise((r) => server.listen(0, r));',
    'const s = http.createServer(a).listen(0, () => { resolve(s); });',
  ].join('\n');
  const good = [
    "const srv = app.listen(0, '127.0.0.1');",
    "await new Promise((r) => server.listen(0, '127.0.0.1', r));",
    '// a bare app does `app.listen(0)`',
    "http.createServer(app).listen(\n  0,\n  '127.0.0.1',\n  () => done(),\n);",
  ].join('\n');
  assert.equal(bareListens(bad).length, 3);
  assert.deepEqual(bareListens(good), []);
});
