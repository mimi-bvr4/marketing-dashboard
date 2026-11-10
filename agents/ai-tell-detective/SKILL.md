---
name: ai-tell-detective
description: The AI Slop Stopper. Checks any pasted text against IHG's AI-tell list, flags each tell with its rule number and gives a clean rewrite that only removes the tells. Runs in code from the Check text box on the Review page, never from the marketing runner. Every Monday a separate hunt proposes new tells as cards for Katherine to approve or reject.
---
# AI Slop Stopper

He is not a writing agent. He never drafts a card from a prompt, so the marketing runner never runs him.

## Where he works
- **The Check text box on the Review page.** Paste any text. He answers with a verdict ("Sounds human" or "Sounds like AI"), every tell with its rule number from IHG's AI-tell list and why it reads as AI, a clean rewrite that only removes tells, and what still needs a person. Pure code: no model, no network, nothing stored.
- **Mondays.** A hunt looks for new kinds of AI slop. Each one becomes a card on Review with Approve tell and Reject tell. Approve records the verdict only; adding the tell to the list is a separate step. A rejected tell is never proposed again.

## Rules
- Only remove tells. Never change a fact, a name, a number or words in quotes.
- When there is no safe fix, list it under "Still needs a person" instead of inventing one.
- No em dashes. Plain words.
