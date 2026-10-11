'use strict';
// ORDER #1658: Katherine's GREEN Drive orders go to the one agent they name.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { route, matchAgent, parseOrder } = require('../jobs/kh_route');

function order(n, title, status = 'OPEN. GREEN: marketing lane, drafts and reports only.', extra = '') {
  return `# ORDER #${n} (KH intake): ${title}\n\nFILED BY: Katherine Howe (via Drive intake), 10.11.2026 10:00 CT\nTIER: MARKETING\nSTATUS: ${status}\n\n## THE REQUEST, AS FILED\n- **TITLE:** ${title}\n- **WHY:** more couples${extra}\n- **OUTPUT:** a draft in the Review queue\n`;
}

function inbox(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
  return d;
}

const fixedNow = () => new Date('2026-10-11T16:00:00Z');

test('matchAgent: one clear agent, none, or ambiguous', () => {
  assert.deepStrictEqual(matchAgent('Blog post about winter weddings at TBT'), ['bloggy-bob']);
  assert.deepStrictEqual(matchAgent('Audit our Knot listing for Saint Elle'), ['listings']);
  assert.deepStrictEqual(matchAgent('Reply to the new SWF reviews'), ['gbp']);
  assert.deepStrictEqual(matchAgent('Make a new logo'), []);
  assert.strictEqual(matchAgent('Blog and Knot listing refresh').length, 2);
});

test('parseOrder reads the intake format', () => {
  const p = parseOrder(order(1700, 'Blog post on fall weddings'));
  assert.strictEqual(p.green, true);
  assert.strictEqual(p.fields.TITLE, 'Blog post on fall weddings');
});

test('route: runs the GREEN single-agent order, writes a claimed DONE reply; leaves HELD, ambiguous, no-agent and answered orders', async () => {
  const d = inbox({
    'ORDER_2026-10-11_1700_KH_fall_blog.md': order(1700, 'Blog post on fall weddings at SWF'),
    'ORDER_2026-10-11_1701_KH_logo.md': order(1701, 'Make a new logo'),
    'ORDER_2026-10-11_1702_KH_both.md': order(1702, 'Blog and Knot listing refresh'),
    'ORDER_2026-10-11_1703_KH_held.md': order(1703, 'Blog post that changes the site menu', 'HELD for Mimi: changes a live site. Approve with one tick.'),
    'ORDER_2026-10-11_1704_KH_done.md': order(1704, 'Blog post already answered'),
    'REPLY_2026-10-11_1704_marketing_bloggy-bob.md': 'STATUS: DONE',
    'ORDER_2026-10-11_1705_not_kh.md': order(1705, 'Blog post but not from the intake'),
  });
  const ran = [];
  const runOne = async (agent, ask) => { ran.push({ agent, ask }); return { ok: true, cards: [{ id: 42 }], unavailable: [] }; };
  const logs = [];
  const res = await route({ inbox: d, runOne, now: fixedNow, log: (l) => logs.push(l) });
  assert.deepStrictEqual(ran.map((r) => r.agent), ['bloggy-bob']);
  assert.match(ran[0].ask, /Katherine Howe's order #1700/);
  assert.match(ran[0].ask, /TITLE: Blog post on fall weddings at SWF/);
  const reply = fs.readFileSync(path.join(d, 'REPLY_2026-10-11_1700_marketing_bloggy-bob.md'), 'utf8');
  assert.match(reply, /^# REPLY #1700/);
  assert.match(reply, /CLAIMED: 10\.11\.2026 11:00 CT/);
  assert.match(reply, /STATUS: DONE\. bloggy-bob ran .* card\(s\) #42 are DRAFTS/);
  assert.deepStrictEqual(res.filter((r) => r.left).map((r) => [r.n, r.left]),
    [['1701', 'no agent'], ['1702', 'ambiguous'], ['1703', 'held']]);
  assert.ok(!fs.readdirSync(d).some((f) => /^REPLY_.*_(1701|1702|1703)_/.test(f)), 'left orders get no reply');
  // a second pass finds the order answered and runs nothing
  await route({ inbox: d, runOne, now: fixedNow, log: () => {} });
  assert.strictEqual(ran.length, 1);
});

test('route: an agent that fails still finishes its reply as FAILED (never silent)', async () => {
  const d = inbox({ 'ORDER_2026-10-11_1710_KH_x.md': order(1710, 'Fix broken links on cherokeedock') });
  await route({ inbox: d, runOne: async () => { throw new Error('model answered 529'); }, now: fixedNow, log: () => {} });
  const reply = fs.readFileSync(path.join(d, 'REPLY_2026-10-11_1710_marketing_site-health.md'), 'utf8');
  assert.match(reply, /STATUS: FAILED\. site-health did not finish: model answered 529/);
});
