#!/bin/bash
# ORDER #1240 step 4: the photo archive's nightly run, on the Box.
#   1. photo_crawl.js --changes   new, moved and removed files from Drive's changes feed
#   1b. photo_crawl.js --thumbs  ORDER #1672: thumbnail backfill, newest first, timed
#   2. photo_tag.js --apply       AI tags for up to PHOTO_TAG_CAP photos with no AI tags yet
#                                 (PHOTO_TAG_CAP=0: skipped, ORDER #1788)
# Step 2 runs even if step 1 fails, so photos already indexed still get tagged.
#
# Run by com.infinitybrain.photo-archive-nightly.plist (shipped NOT loaded).
# --changes needs #1239 ruling item 2 (the robot account on the Marketing shared
# drive). Until then step 1 stops with the 403 it measured and step 2 still runs.
# Tagging only reaches photos that HAVE a stored thumbnail (#1239 ruling item 1).
#
# ORDER #1797: photo work is an END-OF-WEEK BONUS. Outside Fri 18:00 to Mon 23:59
# CT, or while the Box is out of usage, nothing runs and the exit is 0 (a closed
# window is not a failure). Inside it, the thumbnails and the tagger re-ask
# before each batch, so a run that crosses into Tuesday stops cleanly.
set -u
CAP="${PHOTO_TAG_CAP:-1000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HOME/repos/marketing-dashboard" || { echo "photo_nightly: no ~/repos/marketing-dashboard"; exit 1; }
echo "=== photo_nightly $(TZ=America/Chicago date '+%m.%d.%Y %H:%M CT') cap $CAP ==="
node "$HERE/photo_window.js"
win=$?
if [ "$win" -eq 3 ]; then echo "=== photo_nightly done: window closed, nothing ran ==="; exit 0; fi
if [ "$win" -ne 0 ]; then echo "=== photo_nightly STOPPED: the window check itself failed (exit $win), nothing ran ==="; exit 1; fi
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/photo_crawl.js --changes'
crawl=$?
# ORDER #1672: backfill thumbnails, newest first, for PHOTO_THUMBS_MIN minutes
# (default 60). Runs before tagging so tonight's new thumbnails get tagged.
THUMB_MIN="${PHOTO_THUMBS_MIN:-60}"
railway run --service Postgres -- sh -c \
  "MARKETING_DATABASE_URL=\"\$DATABASE_PUBLIC_URL\" node jobs/photo_crawl.js --thumbs --budget-min $THUMB_MIN"
thumbs=$?
# ORDER #1788: PHOTO_TAG_CAP=0 turns tagging off, so the thumbnails can run
# nightly while the tag model is still being chosen (#1789).
if [ "$CAP" = "0" ]; then
  echo "TAGGING OFF: PHOTO_TAG_CAP=0 (the tag model is #1789's choice)"
  tag=0
else
  railway run --service Postgres -- sh -c \
    "MARKETING_DATABASE_URL=\"\$DATABASE_PUBLIC_URL\" node jobs/photo_tag.js --apply --cap $CAP"
  tag=$?
fi
echo "=== photo_nightly done: crawl exit $crawl, thumbs exit $thumbs, tag exit $tag ==="
[ "$crawl" -eq 0 ] && [ "$thumbs" -eq 0 ] && [ "$tag" -eq 0 ]
