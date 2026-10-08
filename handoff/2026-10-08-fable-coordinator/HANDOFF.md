# Overdrafter 1.0 coordinator handoff (2026-10-08, ~16:50Z)

Issued by the cloud Fable coordinator session `session_01GqaoSqia9BNetUBaGnMQSM` ("Overdrafter Fable ultracode — Jev coordination"). The org's monthly spend limit was hit at about 14:1xZ: every subagent lane failed with "hit your org's monthly spend limit; weekly limit resets Oct 10, 10pm UTC". The owner (Blaine) asked the coordinator to finish, save, commit and prepare a handoff prompt for another agent. This directory is the saved run store; `run/state.json` is the central state file.

## Handoff prompt (paste this into the next agent)

```
You are the sole coordinator for Overdrafter 1.0 / JARVIS (repo optomachina/Overdrafter). Read handoff/2026-10-08-fable-coordinator/HANDOFF.md on branch claude/serene-cori-4bfhx4 first, then run/ENV.md and run/state.json in that directory. Continue the queue under the owner's standing development authorization recorded in run/ENV.md (branches, edits, tests, commits, pushes, PRs, Linear issues, automated reviews, merges when hosted checks pass and actionable findings are resolved). Still protected: production database/worker changes, credentials, human/vendor outreach, purchases, destructive cleanup, native SolidWorks actions. Never merge #564 into main; never merge or close the review-only PRs #606-#613; never write the release-parent identifiers OVD-520, OVD-527, OVD-319, OVD-419, OVD-199, OVD-359, OVD-332, OVD-385 in branches, commits or PR text; never rebase, amend or force-push pushed commits; squash-merge with a curated message and the trailer in run/ENV.md; end GitHub comments with the Claude Code footer. Gates: hosted CI green at the head, Sonar read via the public API, a CodeRabbit review whose summary shows change_assessment_commit equal to the head (free plan: one included review per hour; drafts are skipped; main-based PRs auto-review when marked ready; integration-based PRs need an explicit `@coderabbitai review` comment), and two consecutive clean independent review rounds before any merge. Work the queue in this order: (1) #617 OVD-630 (main): if the CodeRabbit review at 998b768 is clean, squash-merge into main and set OVD-630 Done (see "Merge-ready" below); (2) #619 OVD-651 carve 2 (main, head 71ba0d5): two clean review rounds, then CodeRabbit, then merge; (3) #620 OVD-649 carve 3 (main, head 8e7d260): decide the Sonar S2871 BUG and the 3.3% duplication gate condition (see "Decisions needed"), then verify (two clean rounds, npm run verify), CodeRabbit, merge; (4) review-only slices #608-#613 one CodeRabbit review per hour, findings triaged into fix PRs on the integration branch (OVD-643); (5) carve 4 OVD-650 (run/specs/unit-OVD650.json), carve 5 after carves 1+2, carves 6-8 after the integration branch is on main (carve 8 Option B). Keep at most two concurrent worker lanes and one writer per branch. Report briefly and keep going without waiting for "continue".
```

## Current state (verified 16:45Z)

| Ref | Head | Note |
|---|---|---|
| main | `d08ca5f` | #618 (OVD-648) merged 14:01Z; push CI run 37789023300 green |
| integration `codex/recovered-release-free-safety-20261003` | `bbd78c0` | #616 (OVD-645) merged 13:00Z; #615 (OVD-636) merged earlier as `0eb00a4` |
| this branch `claude/serene-cori-4bfhx4` | merge of main + this handoff | run store copied under `handoff/2026-10-08-fable-coordinator/run/` |

Merged today by the coordinator: #605 (OVD-641) `c0fe27e`, #614 (carve 1, OVD-642) `b449113`, #615 (OVD-636) `0eb00a4`, #616 (OVD-645) `bbd78c0`, #618 (OVD-648) `d08ca5f`. Linear Done: OVD-641, OVD-642, OVD-636, OVD-645, OVD-648.

### Open PRs owned by the coordinator

| PR | Issue | Base | Head | Status |
|---|---|---|---|---|
| #617 | OVD-630 | main | `998b768` | **Merge-ready pending CodeRabbit.** Spec-only (`e2e/client-shell.spec.ts`). Two consecutive clean independent rounds (confirmation lane wf_a875466e-af1). CI 12/12 (run 37766903543). Sonar 0 issues, gate OK. Marked ready 16:43:45Z; CodeRabbit "Review in progress" at 16:46Z. Body validated; A6 met at 998b768 (full `npm run verify` pass in the cloud, log md5 b7b63ea4…); M3 sidebar wait removed after the mutant survived 10/10, 30/30, 25/25. |
| #619 | OVD-651 (carve 2) | main | `71ba0d5` | Fix round landed (two test files only, +38/-11) under the amended criterion 1 (documented test-only deviation; non-test files byte-identical to checkpoint `bae69fbf`). CI 13/13. Sonar 11 code smells dispositioned in the body. **Needs two clean independent review rounds** (round-2 reviewers died on the spend limit), then CodeRabbit (mark ready), then merge. Five surviving mutants are carried as follow-ups in the body. |
| #620 | OVD-649 (carve 3) | main | `8e7d260` | Implementer finished (7 files byte-identical, +1030/-3; merge of main `d08ca5f` on top). **No reviewer round ran.** `npm run verify` not recorded. 13 checks green but **Sonar quality gate FAILED**: 1 BUG `typescript:S2871` at `server/engineering/native-stop-workflow.ts:31` (sort without compare fn, reliability D) and new duplication 3.3% > 3%; 70 code smells (59 × plsql:S1192 in the staged replay SQL). |
| #564 | release integration | main | `bbd78c0` | Owner-merge only after the production apply (packet v3). Body/readiness comment 6029907690 needs a refresh for heads `0eb00a4` and `bbd78c0`, carve 1 merged, and the review-only coverage table. |
| #565 | preservation checkpoint | main | `bae69bf` | Never modified; being carved (plan `run/specs/carve-565-plan.md`). |
| #606-#613 | review-only slices (OVD-643) | frozen refs | — | Never merge or close. Reviewed so far: #606 (2 actionable → fixed by #616; threads answered and resolved), #607 (1 docs nit → ARCHITECTURE.md evidence clock rides the next integration PR). #608-#613 still need their CodeRabbit review, one per hour. |

### Decisions needed (coordinator-level, not protected)

1. **#620 Sonar S2871 BUG.** Either the smallest documented code deviation from byte identity (explicit compare function at `native-stop-workflow.ts:31`, carved test unchanged and passing) or an owner disposition in the Sonar UI. The gate requires reliability A, so one of the two is required before merge. Recommendation: the one-line code deviation, recorded in the OVD-649 criterion the same way OVD-651's criterion 1 was amended.
2. **#620 duplication 3.3%.** Inherent to the verbatim staged SQL; needs an owner gate decision (accept for this carve, or restructure in the SQL-qualification carve). Ask Blaine in one line; do not restructure the SQL in this carve.
3. **#619 review rounds.** Two clean independent rounds are still owed. If lanes are available again, launch the verify lane with `prior_file` = `run/findings/prior-619-c839150.json` and the context in `run/state.json.workflows["wf_2591a4ad-2ef"]`; the fix is already in.

### Owner-protected items (never do these; report instead)

Production apply per `run/production-apply-packet-v3.md` (migration 119 deploy-together note; R1 replay not run); #564 merge after readback; Cloud Run smoke; OVD-541; password rotation; Sonar UI dispositions; the scratch containers `ovdinv-a`/`ovdinv-b` left running for the owner's decision.

## How to run lanes (when the spend limit lifts)

- Workflow scripts: `run/verify-workflow.js` and `run/implement-workflow.js` (inline args only; see the args files `run/args-*.json` and `run/specs/unit-OVD6*.json` for shapes). Lane results from today are in `lane-journals/*.results.jsonl`.
- Lessons recorded in `run/ENV.md` and `run/state.json.env`: gate agents ignore "do not mark ready / do not request CodeRabbit" rules, so the coordinator schedules CodeRabbit itself; carved tests can be timing-dependent under load (loop them 10× under a CPU-hog loop); use a 0700 TMPDIR for `npm run verify` (the ovd419 diagnostic manifest tests reject 0755); the PR body PATCH mangles a single-quoted Sonar URL with `p=1..3` (re-read after writing).
- Container: `/home/user/Overdrafter/node_modules` symlinks for the main lockfile family, `/home/user/wt/base564` for the integration-branch family; `run/ensure-docker.sh` before anything that needs the local Supabase stack. Hosted jobs are the result of record.
- Scheduling: the two routines used today (`trig_01HAgTGBhr1Xxqn6tqLzZGkU` CodeRabbit slot, `trig_01JanjPStQSGjaQvKFE1icyf` safety check-in) are **disabled**; recreate equivalents in the new session (one-shot, re-armed each firing: 61 min after each review start; 2 h check-ins while a lane is active).

## Evidence pointers

- `run/state.json`: workflows, merges, pr_state (incl. `"564".review_only`), queue.dispatch_order, decisions, production_ledger, checkins, coderabbit_log, main_push_ci.
- `run/findings/`: CodeRabbit coverage audit for #564, Sonar bug/vuln verification, Jev advisories, `prior-619-c839150.json`.
- `run/specs/`: carve plan and unit manifests (OVD-645, 648, 649, 650, 651), local assignment manifests for OVD-630/636.
- `run/handoff/`: ownership receipt and the OVD-630 repeated-failure guidance.
- `run/production-apply-packet-v3.md`, `run/owner-prompts-2026-10-08.md`, `run/x1/` (workstation X1 acceptance), `run/slices/` (review-only PR creation script and slice lists).
- `run/body-564-after-live.md`, `run/body-564-comment-live3.md`: the last written #564 body and readiness comment.
