// ORDER #1658 (#1015 shared piece 4): the Monday digest. One card summarizing
// every agent's week, so Katherine has one place to look. Built from the
// tables, not by a model: every number on it is counted.
'use strict';

const { listAgents, loadAgent } = require('./agent-runner');

function digestBody({ cards, runs }, names) {
  const by = new Map();
  for (const slug of names.keys()) by.set(slug, { draft: 0, ready: 0, rejected: 0, runs: 0, failed: 0, missing: new Set(), seen: [] });
  for (const c of cards) { const a = by.get(c.agent); if (a) a[c.status] = (a[c.status] || 0) + c.n; }
  for (const r of runs) {
    const a = by.get(r.agent); if (!a) continue;
    a.runs++; if (r.status === 'failed') a.failed++;
    for (const u of (r.unavailable || [])) a.missing.add(u.label);
    a.seen.push(Number(r.seen_skipped) || 0);
  }
  // #1758: how many items each run skipped as already drafted, per run.
  const seen = [...by].filter(([, a]) => a.seen.some((n) => n)).map(([s, a]) => {
    const t = a.seen.reduce((x, y) => x + y, 0);
    return `- ${names.get(s)}: ${t} item${t === 1 ? '' : 's'} (${a.seen.length === 1 ? 'one run' : `runs: ${a.seen.join(', ')}`})`;
  });
  const rows = [...by].map(([slug, a]) => `| ${names.get(slug)} | ${a.runs} | ${a.failed} | ${a.draft} | ${a.ready} | ${a.rejected} |`);
  const waiting = [...by.values()].reduce((n, a) => n + a.draft, 0);
  const quiet = [...by].filter(([, a]) => !a.runs).map(([s]) => names.get(s));
  const failed = [...by].filter(([, a]) => a.failed).map(([s]) => names.get(s));
  const missing = [...by].filter(([, a]) => a.missing.size).map(([s, a]) => `- ${names.get(s)}: ${[...a.missing].join('; ')}`);
  return [
    `**${waiting} draft${waiting === 1 ? '' : 's'} waiting for review** across the team this week.`,
    failed.length ? `Runs that failed: ${failed.join(', ')}. Each failed run left a card saying why.` : 'No run failed this week.',
    quiet.length ? `Did not run this week: ${quiet.join(', ')} (on request only, paused, or not due).` : '',
    '| Team member | Runs | Failed | Waiting | Ready | Rejected |\n|---|---|---|---|---|---|\n' + rows.join('\n'),
    missing.length ? '### Still missing a source\n' + missing.join('\n') : '',
    seen.length ? '### Skipped as already drafted\n' + seen.join('\n') : 'No run skipped an item as already drafted this week.',
  ].filter(Boolean).join('\n\n');
}

async function writeDigest({ store, now = () => new Date() }) {
  const given = new Map((store.profiles ? await store.profiles() : []).filter((p) => p.display_name).map((p) => [p.agent, p.display_name]));
  const names = new Map(listAgents().map((s) => [s, given.get(s) || loadAgent(s).name]));
  const stats = await store.weekStats();
  const day = now().toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric' }).replace(/\//g, '.');
  return store.insert({ agent: 'digest', agent_name: 'Monday digest', job: 'weekly summary', target: null,
    title: `Katherine's team: the week to ${day}`, body: digestBody(stats, names) + '\n\n_Counted from the Review tables by the Box. Nothing was published, sent or changed._',
    sources: [{ label: 'agent_cards and agent_runs, last 7 days', ok: true }], checks: { ai_tells_summary: 'counted, not written' } });
}

module.exports = { writeDigest, digestBody };
