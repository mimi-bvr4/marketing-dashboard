#!/bin/bash
# ORDER #1015 Part 5: the marketing agents' schedule, on the Box. Runs every day
# at 06:00 CT; jobs/agent_run.js --due decides which agents fall today
# (Google Business daily; Site Health and Paid Ads on Mondays; Monthly Report
# on the 3rd; Citations on the 15th; Listings the first Monday of each quarter).
# Bloggy Bob runs on request only.
#
# Run by com.infinitybrain.marketing-agents.plist (shipped NOT loaded; loading it
# is Mimi's apply paste). Uses the Anthropic API key, never the Box's Claude plan,
# so a lane usage limit does not stop the agents.
set -u
cd "$HOME/repos/marketing-dashboard" || { echo "agents_daily: no ~/repos/marketing-dashboard"; exit 1; }
echo "=== agents_daily $(TZ=America/Chicago date '+%m.%d.%Y %H:%M CT') ==="
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/agent_run.js --due'
rc=$?
echo "=== agents_daily done: exit $rc ==="
exit $rc
