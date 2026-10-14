// ORDER #1797 (Mimi, 10.14.2026): photo-archive work is an END-OF-WEEK BONUS.
// "I want this to be an end of the week luxury spend, not take up all of my
// power at the beginning of the week."
//
// THE WINDOW: Friday 18:00 CT through Monday 23:59 CT, the tail of the Box's
// usage week (the weekly usage resets Tuesday 11:00 CT). Outside it no photo
// job runs: not the changes feed, not the thumbnails, not the tagger. Local
// work (thumbnails, embeddings) follows the window too, so the Box stays free
// during the week.
//
// THE USAGE GUARD: the Box's usage state is the driver's own file,
// box_driver_state/usage_limit_until.txt, written by brain-core
// box_jobs/box_driver/usage_limit.py (ORDER #1323) when a lane meets a usage
// limit. Its first line is `USAGE LIMIT UNTIL <YYYY-MM-DD HH:MM> CT | ...`, and
// the heartbeat prints `USAGE LIMIT SKIP` while it holds. This reads that same
// line the same way usage_limit.gate() does: a reset time still ahead holds, a
// passed or unreadable one does not. The file is only ever READ here; clearing
// it is the driver's job. The driver keeps no separate "reserve" signal, so
// none is invented.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const TZ = 'America/Chicago';
const USAGE_FILE_DEFAULT = path.join(os.homedir(), 'Full_IH_Project', '05_AI_and_Brain',
  'box_driver_state', 'usage_limit_until.txt');
const UNTIL_RE = /^USAGE LIMIT UNTIL (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) CT\b/;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The Nashville wall clock for `date`: { dow 0-6 (Sun 0), hour, minute, stamp }.
function nashville(date) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date)) parts[p.type] = p.value;
  return { dow: DAYS.indexOf(parts.weekday), hour: Number(parts.hour), minute: Number(parts.minute),
    stamp: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` };
}

// True from Friday 18:00 CT through Monday 23:59 CT.
function inBonusWindow(date = new Date()) {
  const { dow, hour } = nashville(date);
  return dow === 6 || dow === 0 || dow === 1 || (dow === 5 && hour >= 18);
}

// The reset stamp while the usage limit holds, else null.
function usageHeldUntil(date = new Date(), file = USAGE_FILE_DEFAULT) {
  let line;
  try { line = fs.readFileSync(file, 'utf8').split('\n')[0].trim(); } catch (e) { return null; }
  const m = UNTIL_RE.exec(line);
  if (!m) return null;
  return m[1] > nashville(date).stamp ? m[1] : null;
}

// Why a photo job must stop now, or null when it may run. Asked before each batch.
function photoGate({ now = () => new Date(), usageFile = USAGE_FILE_DEFAULT } = {}) {
  return () => {
    const d = now();
    if (!inBonusWindow(d)) {
      const c = nashville(d);
      return `outside the photo bonus window (Fri 18:00 to Mon 23:59 CT; now ${DAYS[c.dow]} ${c.stamp} CT)`;
    }
    const until = usageHeldUntil(d, usageFile);
    if (until) return `the Box is out of usage until ${until} CT (usage_limit_until.txt, heartbeat USAGE LIMIT SKIP)`;
    return null;
  };
}

module.exports = { inBonusWindow, usageHeldUntil, photoGate, nashville, USAGE_FILE_DEFAULT };
