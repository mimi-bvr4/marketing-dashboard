#!/bin/bash
# ORDER #1658: the marketing agents' 15-minute job, by
# com.infinitybrain.marketing-handoff.plist.
#   1. kh_route.js      Katherine's GREEN Drive orders that name one agent run that agent now.
#   2. agent_requests.js "Run now" requests from the Agents page; then mirrors each
#                       agent's current instructions into 07_Marketing_and_Brand/Agents/.
#   3. agent_asks.js    Katherine's ability asks sorted: instruction change (waits for an
#                       exec), build (HELD order filed), or can't (shown as a trait).
#   4. agent_handoff.js approved Bloggy Bob cards become UNPUBLISHED WordPress drafts.
#   5. cadet_run.js     #1688 the Collateral Cadet: re-reads the Collateral Map and runs
#                       Katherine's "where does this appear?" searches (read-only).
#   6. web_run.js       #1873 the Web Agent: Katherine's uploaded HTML becomes a NEW
#                       WordPress DRAFT page with QA and a Review card. Publish is OFF.
# Drafts only; a person publishes. Each step runs even if an earlier one fails.
set -u
cd "$HOME/repos/marketing-dashboard" || { echo "agents_handoff: no ~/repos/marketing-dashboard"; exit 1; }
echo "=== agents 15-minute job $(TZ=America/Chicago date '+%m.%d.%Y %H:%M CT') ==="
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/kh_route.js'
r1=$?
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/agent_requests.js'
r3=$?
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/agent_asks.js'
r4=$?
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/agent_handoff.js'
r2=$?
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/cadet_run.js'
r5=$?
railway run --service Postgres -- sh -c \
  'MARKETING_DATABASE_URL="$DATABASE_PUBLIC_URL" node jobs/web_run.js'
r6=$?
echo "=== done: route exit $r1, requests exit $r3, asks exit $r4, handoff exit $r2, cadet exit $r5, web exit $r6 ==="
[ "$r1" -eq 0 ] && [ "$r2" -eq 0 ] && [ "$r3" -eq 0 ] && [ "$r4" -eq 0 ] && [ "$r5" -eq 0 ] && [ "$r6" -eq 0 ]
