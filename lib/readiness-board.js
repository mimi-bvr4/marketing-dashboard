'use strict';
// ORDER #3949 (Parts 2 and 3 of #3948; RULINGS_LEDGER "MARKETING CARD HOLD UNTIL
// RELAUNCH" and "MARKETING RELAUNCH: AS SOON AS POSSIBLE, ALL 21 AGENTS", Mimi
// 11.28.2026): the marketing readiness board. A living page, rebuilt from live
// reads every time it is opened (GET /api/readiness, Exec only). No dated snapshot.
//
// One row per agent (all 21), three checks each, each green, red or n/a, with one
// plain sentence saying what is missing and who has to act:
//   Connected  every account, token, sheet or mailbox it reads is reachable now.
//              The SAME Waiting-on lines the Team page shows (routes/agents.js
//              characterOf + gapsOf, through lib/agent-checks.js applyChecks), so a
//              line is measured, never typed here.
//   Acts       its Approve does the thing it says: its own switch is on and the
//              Executioner path for its card type (jobs/agent_handoff.js handoff())
//              is switched on. An agent that only drafts for a person says so as
//              its finished state (n/a).
//   Proven     one full run end to end, evidence linked: an approved card whose
//              hand-off came back ok (the result stamp's link), or for a draft-only
//              agent, an approved card.
// Team rows sit above the agents. The top line counts N of 21 ready and lists every
// red check, shortest fix first.
//
// Part 3: when every agent is ready and no team row is red, relaunch.ready is true
// and relaunch.record carries the ONE [PREFERENCE] record text for Mimi.
//
// READ ONLY. Nothing here approves, sends, posts, publishes, deletes or switches.
// It never reads a card's body or payload beyond its hand-off result.

const H = require('./handoff-map');
const hold = require('./card-hold');
const gbpPost = require('./gbp-post');
const wpPublish = require('./wp-publish');
const PV = require('./pinterest-venues');

const ON = (v) => /^(1|on|true|yes)$/i.test(String(v || '').trim());
// Every store method gather() may call. All reads.
const READS = ['runs', 'listAsks', 'checkRows', 'list', 'recentSettings', 'homeworkList'];

// Rough minutes for "shortest fix first". A switch is a popup; a person's setup
// takes longer; a build is the Box's and slowest.
const MIN = { switch: 2, Mimi: 15, Katherine: 30, Box: 120, someone: 60 };
const META_SINCE = '11.25.2026';

const green = (line, extra = {}) => ({ state: 'green', line, ...extra });
const na = (line, extra = {}) => ({ state: 'na', line, ...extra });
const red = (line, owner, minutes, extra = {}) => ({ state: 'red', line, owner, minutes: minutes != null ? minutes : MIN[owner] || MIN.someone, ...extra });

// Who has to act on a Waiting-on line, from the way the line is written.
function ownerOf(line) {
  const s = String(line || '');
  if (/^Katherine\b|Katherine to /i.test(s)) return 'Katherine';
  if (/^Mimi\b|Mimi's decision|Mimi:/i.test(s)) return 'Mimi';
  if (/^The Box\b|Box:/i.test(s)) return 'Box';
  if (/^K&M\b/.test(s)) return 'K&M';
  return 'someone';
}

// What its Approve does, from agent.json.
function actKind(def) {
  if (!def) return 'report';
  if (def.card_only) return 'card_only';
  if (def.post_fields) return 'post';
  if (def.pin_fields) return 'pin';
  if (def.gbp_post_fields) return 'gbp_post';
  if (def.sales_fields) return 'sales';
  return 'report';
}

function connectedOf(def, needs) {
  const n = (needs || []).filter(Boolean);
  if (!n.length) return green('everything it reads answered its last live check');
  const owner = ownerOf(n[0]);
  const more = n.length > 1 ? ` (and ${n.length - 1} more)` : '';
  return red(`${String(n[0]).slice(0, 300)}${more}`, owner, MIN[owner] || MIN.someone, { count: n.length });
}

function actsOf(def, env = process.env) {
  const kind = actKind(def);
  if (def && def.switch && !ON(env[def.switch])) {
    return red(`it ships off and its switch ${def.switch} is not on, so it never runs`, 'Mimi', MIN.switch, { kind });
  }
  if (kind === 'card_only') return na(`works outside Review: ${def.card_only}`, { kind });
  if (kind === 'post') return green('Approve saves an unpublished WordPress draft and a person publishes; that is its finished state (publishing live on Approve is the blog publish switch, a team row)', { kind });
  if (kind === 'pin') {
    return require('./pinterest').sandboxOn(env)
      ? red('Approve pins only in the Pinterest sandbox (PINTEREST_SANDBOX is on), visible to nobody', 'Mimi', MIN.switch, { kind })
      : green('Approve pins live to the venue\'s board', { kind });
  }
  if (kind === 'gbp_post') {
    return gbpPost.postOn(env) ? green('Approve posts to the venue\'s Google Business Profile, word for word', { kind })
      : red(`${gbpPost.FLAG} is off, so Approve leaves the post unposted`, 'Mimi', MIN.switch, { kind });
  }
  if (kind === 'sales') {
    if (ON(env.CONVENTION_TO_HUBSPOT_PROD)) return green('Approve becomes one HubSpot task for the salesperson Mary picks', { kind });
    if (ON(env.CONVENTION_TO_HUBSPOT)) return red('Approve makes the HubSpot task in the sandbox only; a real task needs CONVENTION_TO_HUBSPOT_PROD', 'Mimi', MIN.switch, { kind });
    return red('CONVENTION_TO_HUBSPOT is off, so Approve makes no HubSpot task', 'Mimi', MIN.switch, { kind });
  }
  return na('drafts or reports for a person; Approve records the decision and a person acts on it. That is its finished state', { kind });
}

const mdY = (d) => { const s = new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); return `${s.slice(5, 7)}.${s.slice(8, 10)}.${s.slice(0, 4)}`; };

function resultLink(h) {
  if (!h) return null;
  return h.link || h.live_link || h.post_url || h.pin_url || h.edit_link || null;
}

function provenOf(def, cards) {
  const kind = actKind(def);
  if (kind === 'card_only') return na('proven on its own page, not through Review cards', { kind });
  const approved = (cards || []).filter((c) => c && c.status === 'ready');
  if (kind === 'report') {
    const c = approved[0];
    return c ? green(`card #${c.id} approved${c.decided_at ? ` ${mdY(c.decided_at)}` : ''}`, { card: c.id })
      : red('no card of its has been approved yet; one test card approved end to end proves it', 'Box', MIN.Box);
  }
  const done = approved.find((c) => c.handoff && c.handoff.ok === true);
  if (done) {
    const link = resultLink(done.handoff);
    const task = done.handoff.task_id ? `, HubSpot task ${done.handoff.task_id}` : '';
    return green(`card #${done.id} approved and carried out${done.decided_at ? ` ${mdY(done.decided_at)}` : ''}${task}`, { card: done.id, link });
  }
  return red('no approved card has been carried out end to end yet (filed, approved on a test item, done, visible)', 'Box', MIN.Box);
}

function agentRow({ slug, def, name, needs, cards }, env) {
  const connected = connectedOf(def, needs);
  const acts = actsOf(def, env);
  const proven = provenOf(def, cards);
  const ready = ![connected, acts, proven].some((c) => c.state === 'red');
  return { slug, name: name || (def && def.name) || slug, connected, acts, proven, ready };
}

// The team rows, above the agents. codeMarks says whether a landed change is in
// this deployment's code; katherineProof counts what Katherine has done herself.
function teamRows({ env = process.env, pinterestRows = null, codeMarks = {}, katherineProof = {} } = {}) {
  const rows = [];
  rows.push({ id: 'review-layout', label: 'Review layout (#3923)', ...(codeMarks.review_layout ? green('landed: Review opens as one row per card with Approve and No action (archive) side by side') : red('the #3923 Review layout is not in this deployment', 'Box', MIN.Box)) });
  rows.push({ id: 'report-brake', label: 'Report cards do not fill the brake (#3924)', ...(codeMarks.report_brake ? green('landed: a report card no longer counts toward the 15-draft hold') : red('the #3924 change is not in this deployment', 'Box', MIN.Box)) });
  const edges = H.rows({ env, nameOf: (s) => s });
  const off = edges.filter((e) => !e.on);
  rows.push({ id: 'handoffs', label: 'Handoffs between agents', ...(off.length
    ? red(`${edges.length - off.length} of ${edges.length} on; off: ${off.map((e) => `${e.from_name} to ${e.to_name} (${e.state})`).join('; ')}`, 'Mimi', MIN.switch)
    : green(`${edges.length} of ${edges.length} on`)) });
  rows.push({ id: 'gbp-post', label: 'Google Business posting switch', ...(gbpPost.postOn(env) ? green(`${gbpPost.FLAG} is on`) : red(`${gbpPost.FLAG} is off`, 'Mimi', MIN.switch)) });
  rows.push({ id: 'blog-publish', label: 'Blog publish switch', ...(wpPublish.on(env) ? green(`${wpPublish.FLAG} is on: an approved post that passes the gates goes live`) : red(`${wpPublish.FLAG} is off: an approved post stays a WordPress draft`, 'Mimi', MIN.switch)) });
  rows.push({ id: 'ads-api', label: 'Google Ads read (ADS_API_LIVE)', ...(ON(env.ADS_API_LIVE) ? green('ADS_API_LIVE is on for the dashboard') : red('ADS_API_LIVE is not on in the dashboard\'s env', 'Mimi', MIN.switch)) });
  const metaSet = String(env.META_ADS_READ_TOKEN || '').trim() && String(env.META_AD_ACCOUNT_IDS || env.META_AD_ACCOUNT_ID || '').trim();
  rows.push({ id: 'meta', label: 'Meta connected across every IHG business portfolio', ...(metaSet
    ? green('the Meta read token and ad account ids are set; confirm every portfolio is in the list')
    : red(`with Katherine since ${META_SINCE}: the Meta system user and token across every IHG business portfolio`, 'Katherine', MIN.Katherine)) });
  const p = PV.connectedLine(pinterestRows || []);
  rows.push({ id: 'pinterest', label: 'Pinterest accounts', ...(p.connected >= p.total ? green(p.line) : red(`${p.line}; connect the rest on Settings, Pinterest accounts (${p.page})`, 'Mimi', MIN.Mimi)) });
  const icOn = ON(env.INSTRUCTION_CHANGES_LIVE);
  const hw = Number(katherineProof.homework) || 0;
  const ins = Number(katherineProof.instructions) || 0;
  rows.push({ id: 'katherine', label: 'Katherine adds homework and changes an instruction, and sees it take effect', ...(!icOn
    ? red('INSTRUCTION_CHANGES_LIVE is off, so her instruction change waits instead of taking effect', 'Mimi', MIN.switch)
    : (hw && ins) ? green(`seen: ${hw} homework item${hw === 1 ? '' : 's'} she added and done, ${ins} instruction change${ins === 1 ? '' : 's'} she saved`)
      : red(`not seen yet: ${hw ? '' : 'no homework she added has been done'}${!hw && !ins ? '; ' : ''}${ins ? '' : 'no instruction change saved by her'}`, 'Katherine', MIN.Katherine)) });
  const st = hold.status(env);
  rows.push({ id: 'card-hold', label: 'The card hold', ...(st.hold
    ? na(`on hold: ${st.flag} is off. It comes off on Mimi's relaunch yes, not before`)
    : green(`relaunched: ${st.flag} is on`)) });
  return rows;
}

function board({ agents = [], env = process.env, pinterestRows = null, codeMarks = {}, katherineProof = {} } = {}) {
  const rows = agents.map((a) => agentRow(a, env));
  const team = teamRows({ env, pinterestRows, codeMarks, katherineProof });
  const blockers = [];
  for (const t of team) if (t.state === 'red') blockers.push({ where: t.label, check: 'team', line: t.line, owner: t.owner, minutes: t.minutes });
  for (const a of rows) for (const k of ['connected', 'acts', 'proven']) {
    if (a[k].state === 'red') blockers.push({ where: a.name, slug: a.slug, check: k, line: a[k].line, owner: a[k].owner, minutes: a[k].minutes });
  }
  blockers.sort((x, y) => x.minutes - y.minutes || String(x.owner).localeCompare(String(y.owner)) || String(x.where).localeCompare(String(y.where)));
  const readyCount = rows.filter((a) => a.ready).length;
  const allReady = readyCount === rows.length && rows.length > 0 && !team.some((t) => t.state === 'red');
  return {
    top_line: `${readyCount} of ${rows.length} agents ready. ${blockers.length ? `${blockers.length} thing${blockers.length === 1 ? '' : 's'} still block relaunch, shortest fix first.` : 'Nothing blocks relaunch.'}`,
    ready_count: readyCount, total: rows.length, team, agents: rows, blockers,
    hold: hold.status(env),
    relaunch: { ready: allReady, record: allReady ? relaunchRecord({ stamp: null }) : null },
  };
}

// Part 3: the ONE record for Mimi when the board is all green or n/a.
function relaunchRecord({ stamp }) {
  const at = stamp || '(stamp when filed)';
  return [
    `## [PREFERENCE] ${at}, marketing relaunch: yes or no`,
    '**DO:** answer yes or no. Yes turns MARKETING_RELAUNCH=on on the Box and on Railway: the hold comes off, Review starts empty, and Katherine\'s reviewer scorecard starts fresh that day (the same shape as her 11.05.2026 handover, HANDOVER_AT).',
    '**WHY IT\'S STUCK:** the readiness board is all green or not applicable for all 21 agents and every team row; turning the team back on is your call (RULINGS_LEDGER, "MARKETING CARD HOLD UNTIL RELAUNCH").',
    '**HOW LONG:** one word.',
    '**WHAT IT UNBLOCKS:** the full team files cards again, aimed at engagement season, and Katherine starts reviewing on a clean page.',
    `**AGE:** ${at}.`,
    '',
  ].join('\n');
}

// Part 3: the one-page note for Katherine. A DRAFT: nothing sends it.
function katherineNote() {
  return [
    '# The team is back',
    '',
    'The marketing team was on hold while it was being finished. It is back on now, and every agent can do what its card says.',
    '',
    'What changed:',
    '- Review started empty today. Every card you see is new.',
    '- Approve now carries the card out: a post goes to WordPress, a pin goes to Pinterest, a Google Business post goes to that venue\'s profile, and a sales card goes to Mary to pick the salesperson.',
    '- Your reviewer scorecard started fresh today.',
    '',
    'The three things you do each day:',
    '1. Open Review and decide each card: Approve, Redo with a note, or No action (archive).',
    '2. Look at the Team page for any Waiting on line with your name, and do that one step.',
    '3. Add homework or change an instruction when you want an agent to do something different, and check the next run follows it.',
    '',
  ].join('\n');
}

// The live reads, for the route. Each read that fails leaves its part empty and
// the board says so through the checks (never a crash, never a guess).
async function gather({ store, env = process.env, now = new Date(), pinterestAccounts = null, characterOf = null, gapsOf = null }) {
  const { listAgents, loadAgent } = require('./agent-runner');
  const safe = async (fn, dflt) => { try { const v = await fn(); return v == null ? dflt : v; } catch (e) { return dflt; } };
  const runs = new Map((await safe(() => store.runs(), [])).map((x) => [x.agent, x]));
  const asks = await safe(() => store.listAsks(), []);
  const checkList = await safe(() => store.checkRows(), null);
  const checks = checkList ? new Map(checkList.map((x) => [x.id, x])) : null;
  const agents = [];
  for (const slug of listAgents()) {
    const def = loadAgent(slug);
    let needs = [];
    if (characterOf) {
      const c = characterOf(def, asks.filter((a) => a.agent === slug), runs.get(slug), now, checks, env);
      needs = [...new Set([...(c.needs || []), ...(gapsOf ? gapsOf(def, runs.get(slug), now, checks, env) : [])])];
    }
    const cards = await safe(() => store.list({ status: 'ready', agent: slug, limit: 25 }), []);
    agents.push({ slug, def, needs, cards });
  }
  const pinterestRows = pinterestAccounts ? await safe(() => pinterestAccounts.list(), []) : [];
  const settings = await safe(() => store.recentSettings(300), []);
  const hw = await safe(() => store.homeworkList(), []);
  const isK = (s) => /katherine/i.test(String(s || ''));
  const katherineProof = {
    instructions: settings.filter((s) => isK(s.edited_by)).length,
    homework: hw.filter((h) => isK(h.added_by) && h.done_at).length,
  };
  return { agents, env, pinterestRows, codeMarks: codeMarks(), katherineProof };
}

// Whether a landed change is in THIS deployment's code (read from its own files).
function codeMarks() {
  const fs = require('fs');
  const path = require('path');
  const has = (rel, s) => { try { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').includes(s); } catch (e) { return false; } };
  return { review_layout: has('public/review.html', '#3923'), report_brake: has('lib/report-fold.js', 'ORDER #3924') };
}

module.exports = { READS, MIN, META_SINCE, ownerOf, actKind, connectedOf, actsOf, provenOf, agentRow, teamRows, board, relaunchRecord, katherineNote, gather, codeMarks };
