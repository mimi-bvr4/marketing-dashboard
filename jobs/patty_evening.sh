#!/bin/bash
# ORDER #3798: PR Patty's one daily run, on the 3 HARO emails. Fired every 15
# minutes from 16:00 to 18:15 CT by com.infinitybrain.pr-patty-evening.plist;
# jobs/patty_evening.js decides: run once on the third HARO email, or at
# 6:15 PM CT with fewer, and never twice in a day.
#
# FEATURE FLAG: PATTY_EVENING_RUN default OFF. Off, every fire logs one line
# and exits. Uses the Anthropic API key, never the Box's Claude plan.
set -u
cd "$HOME/repos/marketing-dashboard" || { echo "patty_evening: no ~/repos/marketing-dashboard"; exit 1; }
echo "=== patty_evening $(TZ=America/Chicago date '+%m.%d.%Y %H:%M CT') ==="
if [ "${PATTY_EVENING_RUN:-}" != "on" ]; then
  node jobs/patty_evening.js
  exit $?
fi
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/patty_evening.js'
rc=$?
echo "=== patty_evening done: exit $rc ==="
exit $rc
