// ORDER #3085 step 2: the tags a model must never guess, read from facts.
//
// day / night / dusk come from the camera clock (EXIF DateTimeOriginal, which
// Drive hands back as imageMediaMetadata.time) and the sun's position over
// Nashville. On #1789's graded 40, day/night was the largest error class (Haiku
// wrong on 11 of 40). Here it is arithmetic, so it is never wrong where EXIF is
// right, and where EXIF is missing there is NO tag, never a guess.
//
// 🔴 THE RULES THIS FILE CARRIES:
//   1. The EXIF time is a wall clock with no zone. It is read as Nashville time
//      (America/Chicago, with its daylight-saving shift), because every venue in
//      the archive is a Nashville-area room. A camera whose clock was never set
//      is wrong by the same amount it was always wrong; nothing here guesses.
//   2. dusk = within DUSK_MIN (40) minutes either side of sunset. Otherwise day
//      runs from civil dawn to civil dusk (sun above -6 degrees), and night is
//      the rest. No other day part is invented.
//   3. A zeroed or unreadable EXIF time gives null, and null means no tag.
//   4. Pure: no Drive, no database, no model. The tests run it with fixed dates.
'use strict';

const LAT = 36.16;          // Nashville, degrees north
const LON = -86.78;         // degrees east (west is negative)
const TZ = 'America/Chicago';
const DUSK_MIN = 40;
const CIVIL = -6;           // civil twilight: the sun 6 degrees below the horizon
const HORIZON = -0.833;     // sunrise / sunset: refraction plus the sun's radius
const DAY_PARTS = ['day', 'dusk', 'night'];

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// "2023:06:10 18:22:01" -> { y, mo, d, h, mi, s } or null. Zeroed dates are null.
function parseExifTime(t) {
  const m = String(t || '').match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m || m[1] === '0000') return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] || '0'].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return { y, mo, d, h, mi, s };
}

// The wall-clock time of day, "HH:MM:SS", stored beside taken_date.
function takenTime(t) {
  const p = parseExifTime(t);
  if (!p) return null;
  const two = (n) => String(n).padStart(2, '0');
  return `${two(p.h)}:${two(p.mi)}:${two(p.s)}`;
}

// The UTC offset of Nashville at instant `ms`, in minutes (CDT -300, CST -360).
function chicagoOffsetMin(ms) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

// A Nashville wall clock -> the UTC instant in ms.
function chicagoToUtcMs({ y, mo, d, h, mi, s = 0 }) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = wall + 6 * 3600000;                       // a CST first guess
  for (let i = 0; i < 2; i += 1) ms = wall - chicagoOffsetMin(ms) * 60000;
  return ms;
}

// The sun's elevation in degrees at UTC instant `ms` (NOAA's solar calculator).
function sunElevation(ms, lat = LAT, lon = LON) {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) + Math.sin(rad(3 * M)) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));
  const yv = Math.tan(rad(eps / 2)) ** 2;
  const eqt = 4 * deg(yv * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M))
    + 4 * e * yv * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
    - 0.5 * yv * yv * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  const utcMin = ((ms % 86400000) + 86400000) % 86400000 / 60000;
  const tst = (((utcMin + eqt + 4 * lon) % 1440) + 1440) % 1440;
  const ha = tst / 4 - 180;
  const cosZ = Math.sin(rad(lat)) * Math.sin(decl) + Math.cos(rad(lat)) * Math.cos(decl) * Math.cos(rad(ha));
  return 90 - deg(Math.acos(Math.max(-1, Math.min(1, cosZ))));
}

// Sunset on a Nashville calendar day, as a UTC ms instant. The sun only falls
// between 14:00 and 23:59 local in Nashville, so a bisection there is exact.
function sunsetUtcMs({ y, mo, d }) {
  let lo = chicagoToUtcMs({ y, mo, d, h: 14, mi: 0 });
  let hi = chicagoToUtcMs({ y, mo, d, h: 23, mi: 59 });
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (sunElevation(mid) > HORIZON) lo = mid; else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

// The EXIF time -> 'day' | 'dusk' | 'night', or null when there is no clock.
function dayPart(exifTime) {
  const p = parseExifTime(exifTime);
  if (!p) return null;
  const at = chicagoToUtcMs(p);
  if (Math.abs(at - sunsetUtcMs(p)) <= DUSK_MIN * 60000) return 'dusk';
  return sunElevation(at) > CIVIL ? 'day' : 'night';
}

// Everything step 2 stores for one photo, from what Drive already hands back.
function factsFor({ time, width, height } = {}) {
  const orient = !width || !height ? null : width === height ? 'square' : width > height ? 'landscape' : 'portrait';
  return { taken_time: takenTime(time), day_part: dayPart(time), orientation: orient };
}

module.exports = {
  LAT, LON, DUSK_MIN, CIVIL, HORIZON, DAY_PARTS,
  parseExifTime, takenTime, chicagoOffsetMin, chicagoToUtcMs, sunElevation, sunsetUtcMs, dayPart, factsFor,
};
