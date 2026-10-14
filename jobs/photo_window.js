#!/usr/bin/env node
// ORDER #1797: may a photo job run right now?
//
//   node jobs/photo_window.js     exit 0 + `PHOTO WINDOW OPEN: ...`
//                                 exit 3 + `PHOTO WINDOW CLOSED: <why>`
//
// photo_nightly.sh asks this before anything else, and the apply paste asks it
// before starting a first run. PHOTO_WINDOW_NOW (an ISO time) and
// PHOTO_USAGE_FILE are for the tests only.
'use strict';

const W = require('../lib/photo-window');

const now = process.env.PHOTO_WINDOW_NOW ? new Date(process.env.PHOTO_WINDOW_NOW) : new Date();
const why = W.photoGate({ now: () => now, usageFile: process.env.PHOTO_USAGE_FILE || W.USAGE_FILE_DEFAULT })();
if (why) {
  console.log(`PHOTO WINDOW CLOSED: ${why}. No photo work runs; the next window picks up where the last one stopped.`);
  process.exitCode = 3;
} else {
  console.log(`PHOTO WINDOW OPEN: ${W.nashville(now).stamp} CT is inside Fri 18:00 to Mon 23:59 CT and the Box is not out of usage.`);
}
