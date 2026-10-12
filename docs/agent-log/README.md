# Agent decision log

`jev-decisions.jsonl` records every Jev (TypeSafe, `jev-1.13.0`) decision the
lead engineer uses to size review, one JSON object per line: PR, head SHA,
deterministic tier from the sensitive path list in `AGENTS.md`, Jev's tier,
confidence and incident probability, the final tier, and latency.

Rules the log encodes, and the review each tier gets:

* Jev can only raise risk. The final tier is the higher of the deterministic
  tier and Jev's tier.
* A failed or low confidence Jev call raises the tier to at least `normal`.
* An unknown deterministic tier counts as `risky`.
* `low` stops after an independent QA or Sonnet review, `normal` gets an
  independent Sonnet review, `risky` gets an independent Opus review.
  Anything on Blaine's hard list (migrations, RLS, SECURITY DEFINER, CI
  workflows, secrets, auth, deploy) also needs his explicit yes to merge.
* Provider dispatch, retry, kill switch, export control and migration window
  PRs also get a Codex cross review. When the two reviews disagree, or Codex
  raises a finding the Opus review did not, a skeptic agent per finding tries
  to refute it with a running test before the merge decision. Learned on
  Oct 12: an Opus APPROVE on #699 missed a retry path that could create two
  provider quotes for one permit; Codex found it and skeptics reproduced it.

Screen a batch:

```bash
NODE_USE_ENV_PROXY=1 node scripts/jev-pr-screen.mjs <input.json>
```

Replay a rule change over the log (for example a stricter confidence floor) with
`replay()` from `scripts/jev-pr-screen.mjs`, and compare `before` and `after`
against what the independent reviews actually found before adopting it.
