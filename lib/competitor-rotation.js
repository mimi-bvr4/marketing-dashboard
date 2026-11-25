// ORDER #3800 (Mimi 11.24.2026: "See the list of competitors that we have
// established already. Needs to be the full list and not just the top."):
// the Scout watches EVERY competitor on Katherine's "IHG Competitors" sheet,
// deduped across tabs (parseSheet already keys one row per website).
//
// The full sheet (136 sites on 11.06.2026) is too many to read every Monday at
// 12 pages each, so it is split on a stated cycle:
//   - every week: the sites added on the Scout's page, and every TOP competitor
//     (#1668: on 3+ tabs or marked Top), up to WEEKLY_CAP;
//   - the rest, plus any top competitor over the cap: one of ROTATION_WEEKS
//     groups per week, so every competitor is read at least once every
//     ROTATION_WEEKS weeks.
// A site's group comes from a hash of its website, so adding or removing a row
// on the sheet never moves any other competitor to a different week.
'use strict';

const crypto = require('crypto');

const ROTATION_WEEKS = 4;
const DAY = 86400000;

// The Monday-based week number of a date, read on the Nashville calendar.
function weekNumber(now = new Date()) {
  const ymd = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const days = Math.floor(Date.parse(ymd + 'T00:00:00Z') / DAY);
  // 01.01.1970 was a Thursday: +3 makes weeks start on Monday.
  return Math.floor((days + 3) / 7);
}

const slotOf = (site, weeks = ROTATION_WEEKS) => parseInt(crypto.createHash('sha1').update(String(site)).digest('hex').slice(0, 8), 16) % weeks;
const slotThisWeek = (now, weeks = ROTATION_WEEKS) => weekNumber(now) % weeks;

// How many weeks until a rotating site is read again (0 = this week).
function nextReadWeeksAway(site, now, weeks = ROTATION_WEEKS) {
  return (slotOf(site, weeks) - slotThisWeek(now, weeks) + weeks) % weeks;
}

module.exports = { ROTATION_WEEKS, weekNumber, slotOf, slotThisWeek, nextReadWeeksAway };
