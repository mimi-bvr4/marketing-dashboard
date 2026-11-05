// ORDER #2958: the Agents page's "Waiting on" lines are current, never a stale
// run reason, and every one names its owner. "(+N more)" opens to show the rest.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { characterOf, liveMissing, STALE_RUN_DAYS } = require('../routes/agents');
const { loadAgent, listAgents } = require('../lib/agent-runner');

const NOW = new Date('2026-11-04T20:00:00-06:00');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

test('a still-pending source shows its LIVE why, not the old run reason', () => {
  const gbp = loadAgent('gbp');
  const label = gbp.sources.find((s) => s.type === 'pending').label;
  const run = { started_at: daysAgo(0.5), unavailable: [{ label, type: 'pending', why: 're-probe on or after 10.20.2026 (ORDER #1589)' }] };
  const needs = characterOf(gbp, [], run, NOW).needs;
  assert.ok(!needs.some((n) => /10\.20\.2026 \(ORDER #1589\)/.test(n)), 'the stale run reason is gone');
  assert.ok(needs.some((n) => n.startsWith(`${label}:`) && /1-9567000042317/.test(n)), 'the live source why is shown');
});

test('a pending reason whose source is connected since is dropped', () => {
  const d = { sources: [], character: { needs: [] } };
  const run = { started_at: daysAgo(1), unavailable: [{ label: 'old thing', type: 'pending', why: 'waiting' }] };
  assert.deepStrictEqual(liveMissing(d, run, NOW), []);
});

test('a read failure shows while the run is fresh and leaves after STALE_RUN_DAYS', () => {
  const d = { sources: [] };
  const u = [{ label: 'posts already published on our WordPress sites', type: 'wp_posts', why: 'no public posts read (none listed)' }];
  assert.strictEqual(liveMissing(d, { started_at: daysAgo(1), unavailable: u }, NOW).length, 1);
  assert.deepStrictEqual(liveMissing(d, { started_at: daysAgo(STALE_RUN_DAYS + 17), unavailable: u }, NOW), []); // Bloggy Bob, 10.11
  assert.deepStrictEqual(liveMissing(d, null, NOW), []);
});

test('every static need names who it waits on, and none says the browser install', () => {
  const owner = /^(Mimi's decision:|Mimi:|Katherine:|Katherine to |Google:)/;
  for (const slug of listAgents()) {
    for (const n of (loadAgent(slug).character || {}).needs || []) assert.match(n, owner, `${slug}: "${n}"`);
  }
  assert.deepStrictEqual(loadAgent('web').character.needs, []); // Chromium is on the Box (#2958 proved a shot)
});

test('the card makes "(+N more)" expandable', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'agents.html'), 'utf8');
  assert.match(html, /<details class="more" data-more="\$\{esc\(a\.slug\)\}"><summary>\(\+\$\{a\.character\.needs\.length - 1\} more\)<\/summary>/);
  assert.match(html, /a\.character\.needs\.slice\(1\)\.map/);
});
