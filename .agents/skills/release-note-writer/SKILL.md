---
name: release-note-writer
description: Produce concise release notes and changelog entries from merged work.
---

# Goal

Turn completed changes into clear user-facing or operator-facing release notes.

## Required output
- short title
- what changed
- why it matters
- rollout/ops notes (if any)
- known limitations or follow-up

## Rules
- Prefer plain language over implementation detail.
- Keep entries concise and accurate.
- Separate user-visible changes from internal maintenance.

## Workflow
1. Read merged PR summary and verification notes.
2. Group changes by user impact.
3. Draft concise release note bullets.
4. Include operator notes and caveats when relevant.
