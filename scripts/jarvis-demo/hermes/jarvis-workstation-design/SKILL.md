---
name: jarvis-workstation-design
description: Design a bracket + plate + pin assembly on the Mac mini from a phone message. CAD-neutral stand-in (build123d), not SolidWorks.
---

# Jarvis workstation design

Use when the user asks, from Telegram or Slack, to design a bracket, plate and
pin assembly (for example "design a bracket on a base plate with an 8 mm pin").

This is a CAD-neutral stand-in built with build123d. It is not SolidWorks and
not native Workstation evidence. Say so in the reply.

## Steps

1. Run `~/overnight/jarvis/bin/jarvis-design "<the user's request text>"`.
2. Reply with the final state (`verified`, `checks_failed` or `failed`), a short
   summary of the checks from the `result.json` path it prints, and attach the
   `assembly.png` path it prints.
3. If the command exits nonzero, report the state or refusal reason as printed.
   Do not retry.

## Limits

Refuse anything other than a bracket + plate + pin assembly (pin 4 to 20 mm).
Do not run the wrapper for other shapes, quotes, or SolidWorks requests; tell
the user this demo cannot do that.
