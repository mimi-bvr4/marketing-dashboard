// ORDER #3116 (Mimi, 11.07.2026): the Period dropdown lists every month of the
// year through the current month, generated from today's date in Nashville,
// never a hard-coded list (the old list stopped at Apr 2026, so May through Oct
// were missing). Shared by the numbers page (window.PeriodOptions) and the
// tests (require). Values are the ones resolvePeriod() already reads:
// 'mtd', 'YYYY-MM' and 'ytd'. Nothing here reads or writes data.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PeriodOptions = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Year and month (1 to 12) of `now` on the Nashville calendar.
  function ctYearMonth(now) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric' }).formatToParts(now);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return { year: get('year'), month: get('month') };
  }

  // The current month (to date) first, then every earlier month of the year,
  // newest first, then the year to date, which stays the default.
  function periodOptions(now) {
    const { year, month } = ctYearMonth(now || new Date());
    const out = [{ value: 'mtd', label: `${MON[month - 1]} ${year} MTD` }];
    for (let m = month - 1; m >= 1; m--) out.push({ value: `${year}-${String(m).padStart(2, '0')}`, label: `${MON[m - 1]} ${year}` });
    out.push({ value: 'ytd', label: `${year} YTD`, selected: true });
    return out;
  }

  return { periodOptions, ctYearMonth, MON };
}));
