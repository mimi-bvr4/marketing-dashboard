'use strict';
// ORDER #3808 (Mimi popup 11.24.2026, "Same action-first rule"): #3797 applied
// to Listings + Citations and to Night Watch (Site Guardian).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const runner = require('../lib/agent-runner');
const { kindOf, approveWill } = require('../lib/approve-will');
const { actionLine, agrees } = require('../lib/card-action');
const guardian = require('../lib/guardian-card');

const FIX = {
  agent: 'citations', status: 'draft', title: 'Fix the phone number on The Knot for Saddle Woods Farm',
  body: '### Now says\n"(615) 555-0100"\n\n### Change to\n"(615) 555-0199"\n\n### Where\nThe Knot listing (draft list). Katherine owns the login.',
};

// ---------------------------------------------------------------- Listings + Citations

test('the Citations agent asks for fix cards, and the contract names the shapes', () => {
  const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'citations', 'agent.json'), 'utf8'));
  assert.strictEqual(def.fix_cards, true);
  for (const h of ['Now says', 'Change to', 'Where']) assert.ok(runner.FIX_CONTRACT.includes(`### ${h}`), h);
  assert.match(runner.FIX_CONTRACT, /Fix the <what/);
  assert.match(runner.FIX_CONTRACT, /Listings check, <MM\.DD\.YYYY>: <N> to fix/);
  assert.match(runner.FIX_CONTRACT, /Quick wins" section is allowed only when every line in it starts with the thing to do/);
  assert.match(runner.FIX_CONTRACT, /If nothing needs a change, write only the summary card/);
});

test('fixGaps: a full fix card passes; the summary and refresh packs are exempt', () => {
  assert.deepStrictEqual(runner.fixGaps(FIX), []);
  assert.deepStrictEqual(runner.fixGaps({ title: 'Listings check, 11.25.2026: 2 to fix', body: 'x' }), []);
  assert.deepStrictEqual(runner.fixGaps({ title: 'Refresh pack: The Bell Tower on Zola', body: 'x' }), []);
});

test('KNOWN-BAD: an info-shaped Citations card is caught by the code check', () => {
  const g = runner.fixGaps({ title: 'Mismatch list', body: '| where | says | should |' });
  assert.ok(g[0].startsWith('the title'), g.join('; '));
  assert.ok(g.includes('Now says') && g.includes('Change to') && g.includes('Where'));
  // Right title, old text missing: still caught.
  assert.deepStrictEqual(runner.fixGaps({ title: FIX.title, body: '### Change to\n"x"\n\n### Where\ny' }), ['Now says']);
});

test('a fix card is an ACTION: it leads with the change, old and new words, and Approve agrees', () => {
  assert.strictEqual(kindOf(FIX), 'fix');
  const a = actionLine(FIX);
  assert.strictEqual(a.info_only, false);
  assert.strictEqual(a.line, 'Fix the phone number on The Knot for Saddle Woods Farm: change "(615) 555-0100" to "(615) 555-0199". A person makes the change; the Box edits no listing.');
  const w = approveWill(FIX);
  assert.strictEqual(w.got_it, false);
  assert.match(w.line, /once you have made this change yourself/);
  assert.match(w.line, /never edits a listing/);
  assert.ok(agrees(FIX));
});

test('the Citations summary card stays information only (Got it); a refresh pack is a draft to use', () => {
  const sum = { agent: 'citations', status: 'draft', title: 'Listings check, 11.25.2026: 0 to fix', body: 'All correct.' };
  assert.strictEqual(kindOf(sum), 'report');
  assert.strictEqual(actionLine(sum).info_only, true);
  assert.ok(agrees(sum));
  const pack = { agent: 'citations', status: 'draft', title: 'Refresh pack: The Bell Tower on Zola', body: 'x' };
  assert.strictEqual(kindOf(pack), 'plain');
  assert.ok(agrees(pack));
});

test('KNOWN-BAD: a "Fix the ..." title from another report agent is not turned into a fix', () => {
  assert.strictEqual(kindOf({ agent: 'seo', status: 'draft', title: 'Fix the title on the TBB home page for The Bridge Building', body: 'x' }), 'report');
});

test('the repo SKILL agrees with the contract', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'agents', 'citations', 'SKILL.md'), 'utf8');
  assert.match(skill, /ORDER #3808/);
  assert.match(skill, /only a listing or page that needs a change becomes a card/);
  assert.doesNotMatch(skill, /\*\*Mismatch list\*\* card/);
});

// ---------------------------------------------------------------- Night Watch

test('every FLAGGED, DOWN and WARN line the watch writes gets a "Do this:" step', () => {
  // The exact shapes brain-core box_jobs/site_guardian/watch.py writes.
  const lines = [
    'DOWN: thebelltower.com (/ 503, /feed/ no answer), 3 checks in a row',
    'FLAGGED: cherokeedock.com home page redirects off-site to evil.example',
    'FLAGGED: cherokeedock.com injected link or text on the home page (casino)',
    'FLAGGED: thebelltower.com new external script host on the home page: cdn.bad.example',
    'FLAGGED: saddlewoodsfarm.com DNS MX changed: was a, now b',
    'FLAGGED: dailydishcatering.com new admin: 8 administrators (baseline 7), new on gmail.com',
    'FLAGGED: dailydishcatering.com admin removed: 6 administrators (baseline 7), fewer on gmail.com',
    'FLAGGED: dailydishcatering.com administrator on gmail.com, owner not named yet (#2193 NEEDS YOU 3)',
    'FLAGGED: thebelltower.com administrator on an unexpected email domain: yahoo.com',
    'FLAGGED: thebelltower.com sudden jump in posts page count: 90, baseline 40',
    "FLAGGED: thebelltower.com core file differs from WordPress.org's checksum: wp-includes/js/jquery/jquery.min.js",
    'WARN: thebelltower.com certificate expires in 9 days (12.04.2026 06:00 CT)',
    'WARN: thebelltower.com certificate could not be read',
    'WARN: thebelltower.com domain registration expires in 20 days (12.15.2026 06:00 CT)',
    'FLAGGED: thebelltower.com something new the watch learns to say',
  ];
  for (const l of lines) {
    const s = guardian.nextStep(l);
    assert.ok(s && s.length > 20, `no step for: ${l}`);
    assert.ok(guardian.withStep(l).includes('. Do this: '), l);
  }
  assert.match(guardian.nextStep(lines[0]), /open thebelltower\.com in a browser/);
  assert.match(guardian.nextStep(lines[6]), /accept the new admin baseline/);
  assert.match(guardian.nextStep(lines[13]), /before 12\.15\.2026 06:00 CT/);
  assert.match(guardian.nextStep(lines[14]), /Mimi first/);
});

test('NOTE and DRIFT lines are information: no step', () => {
  assert.strictEqual(guardian.nextStep('NOTE: thebelltower.com admin check skipped: no brain@ WordPress login in the Keychain'), null);
  assert.strictEqual(guardian.nextStep('DRIFT (rebuild in progress): thebridgebuilding.com DNS A changed: was a, now b'), null);
});

test('the card shows action lines first, each with its step, and counts them', () => {
  const now = new Date('2026-11-25T18:00:00Z');
  const v = guardian.view({ generated_at: '2026-11-25T17:58:00Z', state: { summary: { sites: 9, up: 9, flagged: 1 }, lines: [
    'NOTE: thebelltower.com admin check failed: users read answered 401',
    'FLAGGED: cherokeedock.com injected link or text on the home page (casino)',
  ] } }, now);
  assert.strictEqual(v.actions, 1);
  assert.match(v.lines[0], /^FLAGGED: cherokeedock\.com .*\. Do this: treat it as a possible hack/);
  assert.strictEqual(v.lines[1], 'NOTE: thebelltower.com admin check failed: users read answered 401');
});

test('accepted baselines (#3790): a quiet watch shows no action and makes no card', () => {
  const v = guardian.view({ generated_at: '2026-11-25T17:58:00Z', state: { summary: { sites: 9, up: 9, flagged: 0 }, lines: [] } },
    new Date('2026-11-25T18:00:00Z'));
  assert.strictEqual(v.actions, 0);
  assert.deepStrictEqual(v.lines, []);
  // Site Guardian is card only: the runner never runs it, so it writes no Review card.
  const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'site-guardian', 'agent.json'), 'utf8'));
  assert.ok(typeof def.card_only === 'string' && def.card_only.trim());
});
