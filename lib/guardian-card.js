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
    lines: (st.lines || []).slice(0, 12),
  };
}

// #3243: a Waiting line clears only through a live check. The WP Engine login
// wait clears when the watch's state is live (the login was proven in #3244).
function needs(list, v) {
  return v && v.live ? (list || []).filter((n) => !WAITING_ON_WPE.test(n)) : (list || []);
}

module.exports = { LIVE_MINUTES, view, needs, ct };
