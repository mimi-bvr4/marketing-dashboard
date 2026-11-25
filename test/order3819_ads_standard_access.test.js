// ORDER #3819 (Mimi, 11.25.2026): the Brain's service account is added to each
// Google Ads account as STANDARD, not Read only, so it is done once. Today the
// Brain only pulls data: Standard unlocks nothing in code. Pinned here:
//   - the startup check proves the mutate refusal still holds, before a token;
//   - an answer that reports a mutate is an ALARM, refused, nothing used;
//   - the hourly job prints the ALARM, writes nothing and exits 3;
//   - the docs and the Paid Ads Auditor card say "access: Standard (writes disabled in code)";
//   - no service account key is in the repo.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/google-ads-read');
const job = require('../jobs/ads_monitor');

const ACC = '1234567890';
const ROOT = path.join(__dirname, '..');
const PHRASE = 'access: Standard (writes disabled in code)';

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const a = answers(url, opts);
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  };
  fn.calls = calls;
  return fn;
}

test('#3819 startup check: the mutate refusal holds, and the access is Standard (writes disabled in code)', () => {
  assert.strictEqual(R.startupCheck(), 'Standard (writes disabled in code)');
  assert.strictEqual(R.ACCESS, 'Standard (writes disabled in code)');
});

test('#3819 KNOWN-BAD: a guard or GAQL check that lets a write through makes the startup check an ALARM', () => {
  const isAlarm = (e) => e.alarm === 'MUTATE' && /^ALARM: Google Ads reported a mutate/.test(e.message);
  assert.throws(() => R.startupCheck({ guardFn: () => {} }), isAlarm);
  assert.throws(() => R.startupCheck({ guardFn: (p) => { if (!/campaigns:mutate/.test(p)) throw new Error(`refused: ${p} is a mutate endpoint`); } }), isAlarm);
  assert.throws(() => R.startupCheck({ gaqlFn: (q) => q }), isAlarm);
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'google-ads-read.js'), 'utf8');
  assert.ok(/startupCheck\(\); \/\/ #3819/.test(src), 'createClient runs the startup check before anything else');
});

test('#3819 an answer that reports a mutate is an ALARM: refused, nothing from it used', async () => {
  for (const body of [
    { mutateOperationResponses: [{ campaignResult: { resourceName: `customers/${ACC}/campaigns/1` } }] },
    { results: [{ campaign: { id: '1' } }], partial: { mutateGoogleAdsResponse: {} } },
    { error: { status: 'PERMISSION_DENIED', message: 'The caller attempted a mutate on this customer' } },
  ]) {
    const f = fakeFetch(() => ({ status: body.error ? 403 : 200, body }));
    const c = R.createClient({ env: {}, fetchImpl: f, token: async () => 'tok' });
    await assert.rejects(c.search(ACC, 'SELECT campaign.id FROM campaign'), (e) => e.alarm === 'MUTATE' && /refused, nothing from this answer was used/.test(e.message));
  }
  // an ordinary read is not an alarm
  assert.strictEqual(R.mutateEvidence({ results: [{ campaign: { id: '1', name: 'Bell Tower' } }] }), null);
  assert.strictEqual(R.mutateEvidence({ error: { status: 'PERMISSION_DENIED' } }), null);
});

test('#3819 the hourly job: an ALARM goes to stderr, nothing is written, exit 3 (flag on)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads3819-'));
  const out = []; const err = [];
  const client = {
    accessible: async () => { throw R.mutateAlarm(`POST customers/${ACC}/googleAds:search: mutateOperationResponses`); },
    search: async () => [],
  };
  const code = await job.main({ argv: [], env: { ADS_API_LIVE: '1', ADS_MONITOR_STATE_DIR: dir }, client, log: (s) => out.push(s), alarm: (s) => err.push(s) });
  assert.strictEqual(code, 3);
  assert.strictEqual(err.length, 1);
  assert.match(err[0], /^ALARM: Google Ads reported a mutate/);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing written');
});

test('#3819 the hourly job with the flag off still runs the startup check and reads nothing', async () => {
  const out = [];
  const code = await job.main({ argv: [], env: {}, log: (s) => out.push(s), alarm: () => assert.fail('no alarm') });
  assert.strictEqual(code, 0);
  assert.match(out.join('\n'), /ADS_API_LIVE is off/);
});

test('#3819 the docs and the Paid Ads Auditor card say access: Standard (writes disabled in code), never Read only', () => {
  const agent = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'paid-ads', 'agent.json'), 'utf8'));
  const text = JSON.stringify(agent);
  assert.ok(text.includes(PHRASE), 'agent.json carries the phrase');
  assert.ok(agent.character.traits.some((t) => String(t.instead).includes(PHRASE)), 'the card shows it as a trait');
  assert.ok(!/as Read only/.test(text), 'no "as Read only" left on the card');
  for (const f of ['lib/google-ads-read.js', 'agents/paid-ads/SKILL.md', 'jobs/ads_monitor.js']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(s.includes('Standard (writes disabled in code)'), f);
    assert.ok(!/access level \(Read only\)/.test(s), f);
  }
  assert.ok(!/as Read only/.test(fs.readFileSync(path.join(ROOT, 'lib', 'agent-checks.js'), 'utf8')));
  assert.ok(!/—/.test(text), 'no em dash on the card');
});

test('#3819 no service account key is in the repo (the key lives in ~/.config/brain on the Box)', () => {
  const tracked = require('child_process').execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of tracked) {
    if (!/\.json$/i.test(f) || f.startsWith('node_modules/')) continue;
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!(/"private_key"\s*:/.test(s) && /"client_email"\s*:/.test(s)), `${f} looks like a service account key`);
  }
  const sa = require('../lib/google-sa');
  assert.ok(!sa.keyPath({}).startsWith(ROOT), 'the default key path is outside the repo');
});
