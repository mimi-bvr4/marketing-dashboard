'use strict';
// ORDER #1776 (re-queue of #1709): every sentence a competitor profile writes
// about an outside page goes through the #1703 quote gate before it is saved.
// #1668's profile invented "Executive/Corporate Dinners (ECD)". #1702 refuses
// the "(CODE)" shape; this is the hole that is left: the same invented phrase
// with no code beside it, cited to a page that never says it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const C = require('../lib/competitor-profiles');
const { createMemoryStore } = require('../lib/agent-store');
const { lint } = require('../lib/ai-tells');

const HOME = 'https://riverwoodmansion.com/';
const EVENTS = 'https://riverwoodmansion.com/events';
// Fixture page text: weddings and parties, never "Executive/Corporate Dinners".
const PAGES = {
  [HOME]: 'Riverwood Mansion. Weddings and private parties on the Cumberland since 1799.',
  [EVENTS]: 'Our event lawn seats up to 300 guests for ceremonies and receptions.',
};
const ECD_CLAIM = 'They sell Executive/Corporate Dinners as a package.';
const REAL_CLAIM = 'The event lawn seats up to 300 guests.';

function web(pages, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts });
    const p = pages[url];
    if (!p) return { status: url.includes('blocked') ? 403 : 404, text: async () => '' };
    return { status: 200, text: async () => `<html><title>t</title><body><p>${p}</p></body></html>` };
  };
}

const profile = (glance, spaces) => C.HEADINGS.map((h) => `## ${h}\n${h === 'At a glance' ? glance : h === 'Spaces and events they sell' ? spaces : 'not published'}`).join('\n\n');
const answer = (md, claims) => `${md}\n\n\`\`\`claims\n${JSON.stringify(claims)}\n\`\`\``;

async function setup() {
  const store = createMemoryStore({ lint });
  await store.syncCompetitors([{ site: 'riverwoodmansion.com', name: 'Riverwood Mansion', brands: ['ECD'], top: true }]);
  await store.saveSnapshots('scout', 'riverwoodmansion.com', [{ path: '/', title: 'Riverwood', hash: 'a', text: PAGES[HOME] }], []);
  return store;
}

test('KNOWN BAD: the #1668 Executive/Corporate Dinners claim, against a page that lacks it, is saved UNVERIFIED', async () => {
  const store = await setup();
  const md = profile('A mansion venue on the river.', ECD_CLAIM);
  const llm = { complete: async () => answer(md, [{ claim: ECD_CLAIM, url: HOME, quote: 'Executive/Corporate Dinners' }]) };
  const r = await C.writeProfiles({ store, llm, fetchImpl: web(PAGES) });
  assert.equal(r.written, 1);
  const saved = (await store.competitor('riverwoodmansion.com')).profile_md;
  assert.match(saved, /UNVERIFIED: They sell Executive\/Corporate Dinners as a package\./);
  assert.match(saved, /### Not checked this run[\s\S]*quote not found on the page fetched this run/);
  assert.doesNotMatch(saved, /```claims/, 'the claims list never reaches the saved profile');
});

test('a real quote that is on the page passes and is listed as checked', async () => {
  const store = await setup();
  const md = profile('A mansion venue on the river.', REAL_CLAIM);
  const llm = { complete: async () => answer(md, [{ claim: REAL_CLAIM, url: EVENTS, quote: 'seats up to 300 guests for ceremonies' }]) };
  await C.writeProfiles({ store, llm, fetchImpl: web(PAGES) });
  const saved = (await store.competitor('riverwoodmansion.com')).profile_md;
  assert.doesNotMatch(saved, /UNVERIFIED/);
  assert.match(saved, /### Quotes checked this run \(\d\d\.\d\d\.\d{4} \d\d:\d\d CT\)[\s\S]*"seats up to 300 guests for ceremonies" \(https:\/\/riverwoodmansion\.com\/events\)/);
});

test('a 403, a 404 and a claim with no quote all fail, never pass; one GET per URL per run with the polite UA', async () => {
  const store = await setup();
  await store.syncCompetitors([
    { site: 'riverwoodmansion.com', name: 'Riverwood Mansion', brands: ['ECD'], top: true },
    { site: 'other.com', name: 'Other', brands: ['TBB'], top: true },
  ]);
  await store.saveSnapshots('scout', 'other.com', [{ path: '/', title: 'Other', hash: 'b', text: 'Other venue.' }], []);
  const claims = [
    { claim: 'Blocked page claim one.', url: 'https://blocked.example/x', quote: 'anything at all here' },
    { claim: 'Missing page claim two.', url: 'https://riverwoodmansion.com/gone', quote: 'anything at all here' },
    { claim: 'No quote claim three.', url: HOME },
    { claim: REAL_CLAIM, url: EVENTS, quote: 'seats up to 300 guests for ceremonies' },
  ];
  const md = profile('Blocked page claim one. Missing page claim two.', `No quote claim three. ${REAL_CLAIM}`);
  const calls = [];
  const llm = { complete: async () => answer(md, claims) };
  const r = await C.writeProfiles({ store, llm, fetchImpl: web(PAGES, calls) });
  assert.equal(r.written, 2);
  const saved = (await store.competitor('other.com')).profile_md;
  for (const c of ['Blocked page claim one.', 'Missing page claim two.', 'No quote claim three.']) assert.ok(saved.includes(`UNVERIFIED: ${c}`), c);
  assert.ok(!saved.includes(`UNVERIFIED: ${REAL_CLAIM}`));
  assert.match(saved, /page answered 403/); assert.match(saved, /page answered 404/); assert.match(saved, /no quote given/);
  const urls = calls.map((c) => c.url);
  assert.equal(urls.length, new Set(urls).size, 'each URL fetched once across both profiles');
  for (const c of calls) {
    assert.ok(!c.opts.method || c.opts.method === 'GET', 'GET only');
    assert.match(c.opts.headers['User-Agent'], /IHG-Brain-QuoteCheck/);
  }
});

test('#1702 still refuses the "(ECD)" shape before the gate runs', async () => {
  const bad = 'IHG tracks it as a competitor for Executive/Corporate Dinners (ECD).';
  assert.match(C.cleanProfile(profile(bad, 'x')).error, /invented what a code stands for/);
});

test('the writer is told to list its claims, and the gate is imported, never copied', () => {
  assert.match(C.SYSTEM, /"claims"/);
  const src = fs.readFileSync(path.join(__dirname, '../lib/competitor-profiles.js'), 'utf8');
  assert.match(src, /require\('\.\/quote-gate'\)/);
  assert.doesNotMatch(src, /function (checkClaims|applyGate|snapshotter|quoteFound|norm)\b/);
});
