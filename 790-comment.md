QA: PASS on d73642da
OVD-810 ACs C-1..C-7 + C-0 and the Proof re-run in a fresh worktree: 85/85 pass across 8 files (server/design-graph, server/jarvis, src/features/jarvis), with real build123d, so nothing skipped. The paused-then-cancelled plate event log passes.
Extra QA probe on a paused run:
- Same-key pause replays the original response. A new-key pause is rejected as `duplicate` and the run stays paused.
- A stranger's cancel gets 403 with no change. The owner's cancel goes paused -> cancelled and the claim is released.
- A repeated cancel key returns the identical response, before and after terminal.
- New pause or cancel after terminal: `control_rejected{terminal}`, with no applied event and no new artifacts.
- Concurrent cancels with two keys produce one `control_applied`. Reusing a key for another kind gets 409 `idempotency_conflict` with no effect.
No supabase/migrations file in the diff. Review gate: Opus APPROVED on the head (issuecomment-6210525006).
CI run 38868043857 all green, test and browser-test included (https://github.com/optomachina/Overdrafter/actions/runs/38868043857); SonarCloud gate passed.
Proof re-run: `npx vitest run server/design-graph server/jarvis src/features/jarvis --maxWorkers=2` plus a scratch control probe at d73642da; run 38868043857.
