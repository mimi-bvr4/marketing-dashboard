'use strict';
// ORDER #3246: what the Site Guardian card says, from the Box watch's state.
//
// The watch (brain-core box_jobs/site_guardian/watch.py, launchd every 5
// minutes) writes one state file on the Box; jobs/guardian_publish.js copies it
// into guardian_state after every run. The card shows "Monitoring live" ONLY
// while that state is fresher than 15 minutes, otherwise "Stale since <time>".
// Nothing here or on the page may say live on its own.
const LIVE_MINUTES = 15;
const WAITING_ON_WPE = /WP Engine login/;

function ct(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month}.${p.day}.${p.year} ${p.hour}:${p.minute} CT`;
}

// ORDER #3808 (Mimi popup 11.24.2026, "Same action-first rule"): every DOWN,
// FLAGGED and WARN line from the watch carries its "Do this:" next step, read
// from the line's own words (brain-core box_jobs/site_guardian/watch.py writes
// them). Night Watch alerts go to Mimi first, so each step says what she (or the
// person she hands it to) does. NOTE and DRIFT (TBB rebuild) lines are
// information and get no step. A FLAGGED line no rule matches still gets one.
const STEPS = [
  [/^DOWN: (\S+)/, (d) => `open ${d} in a browser; if it is down for you too, open a WP Engine support ticket for it.`],
  [/redirects off-site to (\S+)/, (d, h) => `treat it as a possible hack: check where ${d}'s home page sends visitors (${h}) and open a WP Engine ticket to find and remove the redirect.`],
  [/injected link or text/, (d) => `treat it as a possible hack: view ${d}'s home page source, and open a WP Engine ticket for a malware scan and cleanup.`],
  [/new external script host on the home page: (.+)$/, (d, h) => `ask who added ${h} to ${d} (a new plugin or tracking tag); if nobody did, remove it and open a WP Engine ticket.`],
  [/DNS (\S+) changed/, (d, rr) => `confirm with whoever manages ${d}'s domain that the ${rr} record change was planned; if not, put it back at the registrar.`],
  [/new admin: /, (d) => `in ${d}'s WordPress Users, find the new administrator; if nobody added them on purpose, remove them and reset the admin passwords.`],
  [/admin removed: /, (d) => `confirm the removal on ${d} was planned (a cleanup); if it was, accept the new admin baseline (as ORDER #3790 did) so this line stops.`],
  [/administrator on (\S+), owner not named/, (d, dom) => `name the owner of the ${dom} administrator on ${d}, or remove that administrator.`],
  [/administrator on an unexpected email domain: (\S+)/, (d, dom) => `in ${d}'s WordPress Users, find the administrator on ${dom}; name its owner or remove it.`],
  [/sudden jump in (\S+) page count/, (d, k) => `look at the newest ${k} in ${d}'s WordPress; spam ${k} mean a hack, so open a WP Engine ticket for a malware scan.`],
  [/core file differs from WordPress\.org's checksum/, (d) => `open a WP Engine ticket to restore ${d}'s WordPress core files and scan for malware.`],
  [/certificate expires in/, (d) => `open a WP Engine ticket to renew ${d}'s SSL certificate.`],
  [/certificate could not be read/, (d) => `open https://${d} and check the padlock; if the browser warns, open a WP Engine ticket for the certificate.`],
  [/domain registration expires in .* \((.+)\)$/, (d, when) => `renew ${d} at its domain registrar before ${when}.`],
];
const NEEDS_STEP = /^(DOWN|FLAGGED|WARN): /;

// The "Do this:" step for one watch line, or null for an information line.
function nextStep(line) {
  const s = String(line || '');
  if (!NEEDS_STEP.test(s)) return null;
  const dom = (s.match(/^[A-Z]+: (\S+)/) || [])[1] || 'the site';
  for (const [re, fn] of STEPS) {
    const m = s.match(re);
    if (m) return fn(dom, m[1]);
  }
  return `look into it on ${dom} and decide whether to hand it on; Night Watch alerts go to Mimi first.`;
}

// The line as shown: the watch's words, then "Do this: <step>." when it needs one.
function withStep(line) {
  const step = nextStep(line);
  return step ? `${String(line).replace(/[.\s]+$/, '')}. Do this: ${step}` : String(line);
}

// row: { generated_at, state } from guardian_state, or nothing.
function view(row, now = new Date()) {
  const at = row && row.generated_at ? new Date(row.generated_at) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return { live: false, label: 'Stale: no state from the watch yet', at: null, summary: null, lines: [] };
  }
  const st = row.state || {};
  const live = now.getTime() - at.getTime() <= LIVE_MINUTES * 60000;
  return {
    live,
    label: live ? 'Monitoring live' : `Stale since ${ct(at)}`,
    at: at.toISOString(),
    checked: ct(at),
    summary: st.summary || null,
    // #3808: actions first, then information; each action line carries its step.
    lines: [...(st.lines || []).filter((l) => nextStep(l)), ...(st.lines || []).filter((l) => !nextStep(l))].slice(0, 12).map(withStep),
    actions: (st.lines || []).filter((l) => nextStep(l)).length,
  };
}

// #3243: a Waiting line clears only through a live check. The WP Engine login
// wait clears when the watch's state is live (the login was proven in #3244).
function needs(list, v) {
  return v && v.live ? (list || []).filter((n) => !WAITING_ON_WPE.test(n)) : (list || []);
}

module.exports = { LIVE_MINUTES, view, needs, ct, nextStep, withStep };
