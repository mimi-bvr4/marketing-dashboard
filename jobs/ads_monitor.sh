#!/bin/bash
# ORDER #3794: the Google Ads monitor (read-only), on the Box.
# ORDER #3821: runs twice a day, 6:15 AM CT (daily full pull) and 1:15 PM CT
# (midday health check); jobs/ads_monitor.js picks which from the CT hour.
# Run by com.infinitybrain.ads-monitor.plist (shipped NOT loaded). With
# ADS_API_LIVE off (the default) jobs/ads_monitor.js reads nothing and exits 0.
set -u
cd "$HOME/repos/marketing-dashboard" || { echo "ads_monitor: no ~/repos/marketing-dashboard"; exit 1; }
echo "=== ads_monitor $(TZ=America/Chicago date '+%m.%d.%Y %H:%M CT') ==="
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/ads_monitor.js'
rc=$?
echo "=== ads_monitor done: exit $rc ==="
exit $rc
