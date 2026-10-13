#!/bin/bash
# ORDER #1717: read Katherine's Master Marketing Dashboard and IG follower sheet
# into the marketing database, every night at 05:30 CT (before the 06:00
# agents). Read-only on her files; writes only katherine_reads.
#
# Run by com.infinitybrain.katherine-files.plist (shipped NOT loaded; loading it
# is Mimi's apply paste).
set -u
cd "$HOME/repos/marketing-dashboard" || { echo "katherine_nightly: no ~/repos/marketing-dashboard"; exit 1; }
echo "=== katherine_nightly $(TZ=America/Chicago date '+%m.%d.%Y %H:%M CT') ==="
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/katherine_files.js'
rc=$?
echo "=== katherine_nightly done: exit $rc ==="
exit $rc
