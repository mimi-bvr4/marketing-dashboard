'use strict';
// ORDER #2120 -- on 10.21.2026 com.infinitybrain.marketing-handoff wrote
// `Problem processing request` 42 times to ihg_marketing_handoff.err with no
// time and no step, and #2118 had to match .err to .out by count. Each of
// jobs/agents_handoff.sh's six `railway run` calls now gets a CT-stamped
// `<step> start` / `<step> exit <n>` line on stderr; nothing else changes.
//
// The script runs against a fake `railway` only (never the real CLI): HOME is a
// temp dir whose repos/marketing-dashboard links to this checkout, and PATH is
// led by a temp dir holding the fake.
//
//   node --test test/order2120_handoff_err_stamps.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STEPS = ['kh_route', 'agent_requests', 'agent_asks', 'agent_handoff', 'cadet_run', 'web_run'];
const STAMP = /^\[agents_handoff \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} CT\] (\S+) (start|exit (\d+))$/;

function runWithFake(code) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'order2120-'));
  fs.mkdirSync(path.join(home, 'repos'));
  fs.symlinkSync(ROOT, path.join(home, 'repos', 'marketing-dashboard'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const fake = path.join(bin, 'railway');
  fs.writeFileSync(fake, code === 0
    ? '#!/bin/sh\nexit 0\n'
    : `#!/bin/sh\necho "Problem processing request" >&2\nexit ${code}\n`);
  fs.chmodSync(fake, 0o755);
  const r = spawnSync('bash', [path.join(ROOT, 'jobs', 'agents_handoff.sh')], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  fs.rmSync(home, { recursive: true, force: true });
  return r;
}

function stamped(stderr) {
  return stderr.split('\n').map((l) => l.match(STAMP)).filter(Boolean);
}

test('KNOWN-BAD: a failing railway leaves six start and six exit 1 lines, stamped, in step order', () => {
  const r = runWithFake(1);
  const lines = stamped(r.stderr);
  assert.strictEqual(lines.length, 12, `12 stamped stderr lines, got:\n${r.stderr}`);
  STEPS.forEach((step, i) => {
    assert.strictEqual(lines[2 * i][1], step);
    assert.strictEqual(lines[2 * i][2], 'start');
    assert.strictEqual(lines[2 * i + 1][1], step);
    assert.strictEqual(lines[2 * i + 1][2], 'exit 1');
  });
  const done = r.stdout.split('\n').find((l) => l.startsWith('=== done:'));
  assert.ok(done, 'the stdout done: line is still there');
  assert.strictEqual((done.match(/exit 1/g) || []).length, 6);
  assert.notStrictEqual(r.status, 0, 'the script still exits non-zero');
});

test('a clean railway leaves six exit 0 lines and the script exits 0', () => {
  const r = runWithFake(0);
  const lines = stamped(r.stderr);
  assert.strictEqual(lines.length, 12, `12 stamped stderr lines, got:\n${r.stderr}`);
  assert.deepStrictEqual(lines.filter((m) => m[2] === 'exit 0').map((m) => m[1]), STEPS);
  assert.strictEqual(r.status, 0);
});
