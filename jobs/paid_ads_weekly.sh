#!/bin/bash
# ORDER #3804: the Monday paid ads report (Google Ads + Meta), read-only, on the Box.
# Run by com.infinitybrain.paid-ads-weekly.plist (shipped NOT loaded). With
# PAID_ADS_WEEKLY off (the default) jobs/paid_ads_weekly.js reads nothing and exits 0.
set -u
cd "$HOME/repos/marketing-dashboard" || { echo "paid_ads_weekly: no ~/repos/marketing-dashboard"; exit 1; }
echo "=== paid_ads_weekly $(TZ=America/Chicago date '+%m.%d.%Y %H:%M CT') ==="
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/paid_ads_weekly.js'
rc=$?
echo "=== paid_ads_weekly done: exit $rc ==="
exit $rc
