#!/bin/bash
# ORDER #1240 step 4: the photo archive's nightly run, on the Box.
#   1. photo_crawl.js --changes   new, moved and removed files from Drive's changes feed
#   2. photo_tag.js --apply       AI tags for up to PHOTO_TAG_CAP photos with no AI tags yet
# Step 2 runs even if step 1 fails, so photos already indexed still get tagged.
#
# Run by com.infinitybrain.photo-archive-nightly.plist (shipped NOT loaded).
# --changes needs #1239 ruling item 2 (the robot account on the Marketing shared
# drive). Until then step 1 stops with the 403 it measured and step 2 still runs.
# Tagging only reaches photos that HAVE a stored thumbnail (#1239 ruling item 1).
set -u
CAP="${PHOTO_TAG_CAP:-1000}"
cd "$HOME/repos/marketing-dashboard" || { echo "photo_nightly: no ~/repos/marketing-dashboard"; exit 1; }
echo "=== photo_nightly $(TZ=America/Chicago date '+%m.%d.%Y %H:%M CT') cap $CAP ==="
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/photo_crawl.js --changes'
crawl=$?
railway run --service Postgres -- sh -c \
  "MARKETING_DATABASE_URL=\"\$DATABASE_PUBLIC_URL\" node jobs/photo_tag.js --apply --cap $CAP"
tag=$?
echo "=== photo_nightly done: crawl exit $crawl, tag exit $tag ==="
[ "$crawl" -eq 0 ] && [ "$tag" -eq 0 ]
