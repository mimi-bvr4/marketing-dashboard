// ORDER #1241: the photo archive's launch settings, in one place.
'use strict';

// What a Venues photo with no event link is, until Katherine confirms #1008's
// default. 'unknown' shows "Check with marketing" and offers no download.
// 🔴 KATHERINE'S STEP: when she confirms that the Venues folder is her curated
// sales set, change this one line to 'cleared'. The page reads it on every
// request and the crawl stores it, so nothing else has to change.
const VENUES_DEFAULT = 'unknown';

module.exports = { VENUES_DEFAULT };
