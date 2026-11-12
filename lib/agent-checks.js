// ORDER #3243 (Mimi 11.11.2026, URGENT): every "Waiting on" line an agent card
// shows is a LIVE CHECK, never static text. Seven switches had been on since
// 11.08, the fleet key minted on 11.07, and the cards still said "Mimi: switch it
// on" because those lines were fixed text in agent.json and nothing re-read them.
//
// Each check is named, read-only and repeatable. The Box re-runs every check at
// the start of the daily agents run and on every 15-minute job
// (jobs/agent_checks.js) and writes one row per check to agent_checks: ok or not,
// the reason, and when. The card then shows only the checks that FAIL right now,
// each with "last checked <time CT>"; a passing check's line disappears from the
// card and from the home brief's Katherine's team list (both read /api/agents).
//
// What each kind reads (all read-only; no secret is ever printed or stored):
//   switch          the env the job actually runs with (the Box job's process env
//                   IS its plist env; the dashboard falls back to its own env)
//   keychain        `security find-generic-password -s <name>`: exit code only,
//                   never -w, so the value is never read (or an env var of that key)
//   search_console  the Brain's Search Console account lists >= 1 of our sites
//   mail_senders    brain@ received >= 1 email from EACH press-alert sender in the
//                   last 14 days (Gmail search, ids only, no message is opened)
//
// A static need with no check here stays as written (a decision only a person
// can make, such as "Mimi's decision: ..."): nothing can be measured for it.
'use strict';

const INBOX = 'brain@infinityhospitality.net';
const PRESS_SENDERS = [
  { name: 'Qwoted', q: 'qwoted' },
  { name: 'HARO', q: '{haro "help a reporter"}' },
  { name: 'Be Inspired PR', q: '{"be inspired pr" beinspiredpr}' },
];
const MAIL_DAYS = 14;

// A need line (from agent.json) or a run reason -> the check that decides it.
const RULES = [
  { test: /^Mimi: switch it on \(([A-Z][A-Z0-9_]*)\)/, make: (m) => ({ id: `switch:${m[1]}`, kind: 'switch', name: m[1], label: `switch ${m[1]} is on` }) },
  { test: /marketing-fleet-key/, make: () => ({ id: 'keychain:marketing-fleet-key', kind: 'keychain', service: 'marketing-fleet-key', env: 'MARKETING_FLEET_KEY', label: "read-only key 'marketing-fleet-key' is on the Box" }) },
  { test: /Search Console (access for the Box|has none of our sites)/, make: () => ({ id: 'search-console:sites', kind: 'search_console', label: 'Search Console lists our sites for the Brain' }) },
  { test: /forward the Qwoted, HARO and Be Inspired PR|press-request emails in brain@|no press-request emails in/, make: () => ({ id: 'mail:press-alerts', kind: 'mail_senders', label: `brain@ gets each press-alert sender's email (last ${MAIL_DAYS} days)` }) },
];

function checkFor(line) {
  for (const r of RULES) { const m = r.test.exec(String(line || '')); if (m) return r.make(m); }
  return null;
}

// Every distinct check the fleet's static needs name, with the agents that wait on it.
function fleetChecks(defs) {
  const out = new Map();
  for (const [slug, d] of defs) {
    for (const n of ((d && d.character) || {}).needs || []) {
      const c = checkFor(n);
      if (!c) continue;
      const have = out.get(c.id) || { ...c, agents: [] };
      if (!have.agents.includes(slug)) have.agents.push(slug);
      out.set(c.id, have);
    }
  }
  return [...out.values()];
}

const ON = /^(1|on|true|yes)$/i;
function keychainHas(service) {
  // Exit code only. No -w: the item's value is never read into this process.
  const r = require('child_process').spawnSync('security', ['find-generic-password', '-s', service], { stdio: 'ignore' });
  return r.status === 0;
}

async function runCheck(c, ctx = {}) {
  const env = ctx.env || process.env;
  try {
    if (c.kind === 'switch') {
      const v = String(env[c.name] || '').trim();
      return ON.test(v) ? { ok: true, reason: `${c.name} is on` } : { ok: false, reason: `${c.name} is not on in the env this job runs with` };
    }
    if (c.kind === 'keychain') {
      if (c.env && String(env[c.env] || '').trim()) return { ok: true, reason: `${c.env} is set` };
      const has = (ctx.keychainHas || keychainHas)(c.service);
      return has ? { ok: true, reason: `Keychain item '${c.service}' exists` } : { ok: false, reason: `no Keychain item '${c.service}' on the Box` };
    }
    if (c.kind === 'search_console') {
      const sites = await ctx.searchConsoleSites();
      return sites > 0 ? { ok: true, reason: `${sites} of our sites listed` } : { ok: false, reason: 'Search Console lists none of our sites for the Brain account' };
    }
    if (c.kind === 'mail_senders') {
      const missing = [];
      for (const s of PRESS_SENDERS) if (!(await ctx.mailCount(`newer_than:${MAIL_DAYS}d ${s.q}`))) missing.push(s.name);
      return missing.length ? { ok: false, reason: `no email in ${INBOX} in the last ${MAIL_DAYS} days from ${missing.join(', ')}` }
        : { ok: true, reason: `every sender reached ${INBOX} in the last ${MAIL_DAYS} days` };
    }
    return { ok: false, reason: `unknown check kind ${c.kind}` };
  } catch (e) {
    return { ok: false, reason: `the check could not run: ${String((e && e.message) || e).slice(0, 200)}` };
  }
}

// The live readers the Box job hands to runCheck (read-only scopes only).
function liveContext(env = process.env) {
  const sa = require('./google-sa');
  const sc = require('./search-console');
  const ma = require('./mail-alerts');
  const seo = (() => { try { return require('./agent-runner').loadAgent('seo'); } catch (e) { return null; } })();
  const seoSites = ((seo && seo.sources) || []).find((s) => s.type === 'search_console');
  return {
    env,
    async searchConsoleSites() {
      const key = sa.loadKey(env);
      if (!key) throw new Error(`no Brain service-account key on this machine (${sa.keyPath(env)})`);
      const token = await sa.accessToken({ key, scopes: [sc.SCOPE] });
      const entries = await sc.createClient({ token }).sites();
      if (!seoSites) return (entries || []).length;
      const props = sc.matchProperties(seoSites.sites, entries);
      return seoSites.sites.filter((d) => props[d]).length;
    },
    async mailCount(q) {
      const key = sa.loadKey(env);
      if (!key) throw new Error(`no Brain service-account key on this machine (${sa.keyPath(env)})`);
      const token = await sa.accessToken({ key, scopes: [ma.SCOPE], subject: INBOX });
      return (await ma.createClient({ token }).find(q, 1)).length;
    },
  };
}

// "A failure only a person can fix texts Mimi ONCE, then shows on the card. It
// never texts again every run." One alert per failing streak: due on the SECOND
// failure in a row (one blip never texts), never again until the check has
// passed and failed twice more.
function nextState(prev, result, at) {
  const fails = result.ok ? 0 : ((prev && !prev.ok ? Number(prev.fail_count) || 0 : 0) + 1);
  const alerted = result.ok ? null : (prev && !prev.ok ? prev.alerted_at || null : null);
  const alertDue = !result.ok && fails >= 2 && !alerted;
  return { ok: !!result.ok, reason: result.reason, checked_at: at, fail_count: fails, alerted_at: alertDue ? at : alerted, alert_due: alertDue };
}

function ctTime(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '?';
  const day = d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit' }).replace('/', '.');
  const t = d.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} ${t} CT`;
}

// The card's view of one need line, given the latest check rows (Map id -> row).
//   undefined  no check decides it: show the line as written
//   null       its check passes: the line disappears
//   string     its check fails: the line, why, and when it was last checked
function liveNeed(line, rows, env) {
  const c = checkFor(line);
  if (!c) return undefined;
  const row = rows && rows.get(c.id);
  if (row) return row.ok ? null : `${line} (failing: ${row.reason}; last checked ${ctTime(row.checked_at)})`;
  // Never checked yet: a switch can still be read from this process's own env.
  if (c.kind === 'switch' && env && ON.test(String(env[c.name] || '').trim())) return null;
  return undefined;
}

// One line per check: a static need and a run reason that name the same failing
// check (Search Console, say) show once, the static line first.
function applyChecks(needs, rows, env = process.env) {
  const out = [];
  const shown = new Set();
  for (const n of needs || []) {
    const v = liveNeed(n, rows, env);
    if (v === null) continue;
    const c = v === undefined ? null : checkFor(n);
    if (c) { if (shown.has(c.id)) continue; shown.add(c.id); }
    out.push(v === undefined ? n : v);
  }
  return out;
}

module.exports = { RULES, PRESS_SENDERS, MAIL_DAYS, checkFor, fleetChecks, runCheck, liveContext, keychainHas, nextState, ctTime, liveNeed, applyChecks };
