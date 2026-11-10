'use strict';
// ORDER #3045 (Mimi 11.06.2026, "and my AI slop man"): the AI Slop Stopper on
// the team page. His card, behind his own switch (AI_TELL_DETECTIVE, the same
// switch as his Check text box), his 10 lines in Harry, and his clips. No
// express here, so it runs in a worktree without node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AV = require('../lib/agent-voices');
const P = require('../lib/producer');
const V = require('../public/agents-view');
const { listAgents, loadAgent } = require('../lib/agent-runner');

const SLUG = 'ai-tell-detective';
const EM = '—';
const ROOT = path.join(__dirname, '..');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

test('his card: named, with the job from the order, a character and traits', () => {
  assert.ok(listAgents().includes(SLUG));
  const d = loadAgent(SLUG);
  assert.strictEqual(d.name, 'AI Slop Stopper');
  assert.strictEqual(d.job, 'Checks any text for AI tells; every Monday hunts new AI-slop patterns (proposals need approval)');
  assert.match(d.skill, new RegExp(`^---\\nname: ${SLUG}\\ndescription: .+\\n---`));
  assert.ok(d.character.role && d.character.does.length >= 2);
  for (const t of d.character.traits) assert.ok(t.cant && t.instead);
  const words = JSON.stringify([d.name, d.job, d.cadence, d.card_only, d.ask_note, d.character]) + d.skill;
  assert.ok(!words.includes(EM), 'no em dash in what Katherine sees');
  assert.doesNotMatch(words, /#\d{3,}|ORDER/i, 'no order numbers in what Katherine sees');
});

test('switch-respecting: Paused until AI_TELL_DETECTIVE is on, never run by the runner or calendar', () => {
  const d = loadAgent(SLUG);
  assert.strictEqual(d.switch, 'AI_TELL_DETECTIVE');
  assert.match(P.switchOff(d, {}), /off until Mimi switches it on \(AI_TELL_DETECTIVE\)/);
  assert.strictEqual(P.switchOff(d, { AI_TELL_DETECTIVE: 'on' }), null);
  assert.ok(P.cardOnly(d), 'a card only: the marketing runner never runs him');
  assert.ok(!P.calendar().some((e) => e.agent === SLUG), 'not on the Producer calendar');
  assert.strictEqual(d.ask_page, '/review', 'his button opens the Review page, where the Check text box is');
  const [line] = P.board({ ymd: '2026-11-09', defs: [d], env: {} });
  assert.strictEqual(line.state, 'off');
  const [on] = P.board({ ymd: '2026-11-09', defs: [d], env: { AI_TELL_DETECTIVE: 'on' } });
  assert.strictEqual(on.state, 'own');
});

test('the page and the route carry his own note, and the Web Agent keeps its old one', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'agents.html'), 'utf8');
  const route = fs.readFileSync(path.join(ROOT, 'routes', 'agents.js'), 'utf8');
  assert.match(html, /esc\(a\.ask_note \|\| 'Asked on his own page; the Box answers there within 15 minutes\.'\)/);
  assert.match(route, /ask_note: d\.ask_note \|\| null/);
  assert.ok(!loadAgent('web').ask_note, 'web has no ask_note, so its line is unchanged');
});

test('his 10 lines in Harry, verbatim from the ADDED section', () => {
  const c = AV.loadScript().find((x) => x.slug === SLUG);
  assert.ok(c, 'the ADDED 11.06.2026 section is read as his character');
  assert.strictEqual(c.voice, 'Harry');
  assert.strictEqual(c.heading, 'AI Slop Stopper, the janitor');
  assert.strictEqual(c.lines.length, 10);
  assert.strictEqual(c.lines[0], 'Slop on aisle three. I\'m on it.');
  assert.strictEqual(c.lines[9], 'Mop\'s wrung out. You\'re good to go.');
});

test('an ADDED heading naming no card stays a note; PROPOSED is still not read', () => {
  const s = AV.parseScript([
    '## ADDED 11.05.2026: NB\'s new agents (ORDER #3000)', '1. not a line',
    '## PROPOSED 11.07.2026 (ORDER #1): Someone New (Harry)', '1. not read',
    '## Scout (Chris)', '1. a', '## ADDED 11.06.2026 (x): AI Slop Stopper, the janitor (Harry)', '1. b',
  ].join('\n'));
  assert.deepStrictEqual(s.map((c) => [c.slug, c.lines]), [['scout', ['a']], [SLUG, ['b']]]);
});

test('switch ON: his card plays his own 10 clips; OFF: no button', () => {
  const on = AV.apiBody({ AGENT_VOICES: 'on' });
  assert.strictEqual(on.voices[SLUG].length, 10);
  on.voices[SLUG].forEach((x, i) => assert.strictEqual(x.src, `/agent-voices/${SLUG}_${String(i + 1).padStart(2, '0')}.mp3`));
  assert.match(V.speakerHtml(on, SLUG, 'AI Slop Stopper', esc), new RegExp(`data-speak="${SLUG}"`));
  assert.strictEqual(V.speakerHtml(AV.apiBody({}), SLUG, 'AI Slop Stopper', esc), '');
});
