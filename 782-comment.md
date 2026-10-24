QA: PASS on 53ed8c5e
OVD-813 ACs, re-run in a fresh worktree:
- The fixtureHeal tests pass 28/28, including the 13 named Proof tests.
- First outlier: the quote is held (manual_review_pending, offers withheld) and routing scores are skipped. The supplier is paused with a page on the first outlier.
- An extra QA probe confirms the rest:
  - The pause survives a 7-day fake-timer jump. A release is refused unless it comes through reverify or heal with evidence.
  - A paused supplier admits only internal test quotes, and the kill switch still blocks those (`kill_switch_engaged_blocks_even_internal_quote`).
  - 304/304L matches 304 Stainless, and 304 vs 316 is still flagged.
  - The history key changes with material, finish, process, tolerance and thickness.
- The diff has no SQL or migration.
- Deferred by sign-off, not FAILs: S4 SQL publish/select guards, the durable pause (S2/OVD-771), cross-quantity comparison, and no adapter emitting a thickness echo yet.
Review gate: Opus re-review APPROVED on the head (issuecomment-6209763361).
CI run 38860624562 green (https://github.com/optomachina/Overdrafter/actions/runs/38860624562); SonarCloud gate passed.
Proof re-run: `npx vitest run worker/src/fixtureHeal --maxWorkers=2` plus a scratch QA probe on pause.ts, sanity.ts and gate.ts at 53ed8c5e; run 38860624562.
