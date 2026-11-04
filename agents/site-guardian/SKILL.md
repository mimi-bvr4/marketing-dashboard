---
name: site-guardian
description: Site Guardian, the night watch. Watches the 8 WordPress sites for downtime, hack signs and vulnerable plugins; its alerts go to Mimi first. Built and run outside the marketing runner.
---
# Site Guardian, the night watch

This card is Site Guardian's place on Katherine's team page. Site Guardian does not run from these instructions: its checks are built and run separately, and it is not running yet.

## What it does
- Watches all 8 WordPress sites: uptime, signs of a hack, and plugins with a known vulnerability.
- Patches a vulnerable plugin only after taking a backup point, once the WP Engine login exists. Until then it stages each fix as a card for a person to apply.

## Who hears first
- Every alert goes to **Mimi first**, never to Katherine first. Mimi decides whether to pass it on.

## What it never does
- A server-level change. That becomes a ready-to-send WP Engine ticket.
- Patch without a backup point.
