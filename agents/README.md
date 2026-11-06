# Marketing agents (ORDER #1015, #1658)

Each folder is one agent: `SKILL.md` (what it does, plain markdown) and `agent.json` (name, job, cadence, sources, drafts per run, `post_fields` for agents that return a post).

- **Katherine edits the instructions on the dashboard's Agents page** (`/agents`). Each save is a new version in the marketing database; the runner uses the latest. The `SKILL.md` here is the default and the starting text. The Box mirrors the current words to `07_Marketing_and_Brand/Agents/<slug>.SKILL.md` every 15 minutes.
- **The fence is not in these files** and cannot be edited: `lib/agent-runner.js` appends it after any instructions (drafts only; never publish, post, send, spend or sign in; no invented facts; the output contract). Every card is linted against `AI_TELLS_BAN_LIST`.
- **Adding an agent** = add a folder here, add its schedule to `dueAgents()` in `jobs/agent_run.js` (or leave it on request only), and a keyword rule in `jobs/kh_route.js` if Katherine's Drive orders should reach it.
- **A card only** (#2903) = `"card_only": "<the line the board shows>"` in `agent.json`. The team member sits on the team page with its character, but this runner never runs it (the Web Agent works on `/web`; Site Guardian is built and run elsewhere, and its alerts go to Mimi first).
- **Paused until a source exists** (#2903) = `"paused_until": "<a pending source's label>"`. While that source is still `pending` the agent is off both schedules and is one line on the Producer's board, never a weekly "could not run" card. The pause ends by itself when the source is connected. Paid Ads uses it for the ads export Sheet.
- **Ships OFF** (#3000) = `"switch": "AGENT_<NAME>"` in `agent.json`. Until that env switch is on, the member sits on the team page and the calendar but is never run, scheduled or asked, and the board says "off until Mimi switches it on". Turning it on is Mimi's popup. `"voice_pending"` means its 10 lines are not written yet, so it has no voice button.
- **Outreach** (#3000) = `lib/outreach.js`: every outreach email is a draft with an opt-out line and the mailing address (`OUTREACH_MAILING_ADDRESS`) added by code; `OUTREACH_AUTO_SEND` is off and has no send path. Only an agent with a named salesperson (`OWNERS`) hands approved cards to HubSpot.
- **Adding a source** = a new entry in `agent.json`, using a type from `lib/agent-sources.js` (file, newest file, site crawl, public WordPress posts, the dashboard's GA4 and funnel-count routes, AI assistant answers (`ai_answers`), a request, or `pending` for something not connected yet).

Jobs (on the Box, from `~/repos/marketing-dashboard`):
- `jobs/agents_daily.sh` 06:00 CT: agents due today (+ the Monday digest card). Paused agents are skipped.
- `jobs/agents_handoff.sh` every 15 minutes: Katherine's Drive orders that name one agent, "Run now" requests, the mirror, and approved Bob posts saved to WordPress as UNPUBLISHED drafts.
