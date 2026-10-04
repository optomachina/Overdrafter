# Coordinator handoff — 2026-10-04 22:20 UTC

From: cloud coordinator session `session_01J6k1c9EuXZRLKzUqCdkpNn`, which is releasing ownership.
To: the next cloud ultracode coordinator.

Treat everything below as claims to re-verify at each PR's current head. Nothing here says OVD-520 or any release gate passed: no connected native run exists, and no gate has same-run, independently verified evidence.

## 1. Ownership-release status (as of 22:16Z)

- **Workflows:** none running. The last three launched were wf_19f33f2a-a41, wf_0f30e737-ac0 and wf_7bd0bf82-5dd. A worker restart at about 22:14Z ended them, and earlier runs died at 20:35Z on the org spend limit. None were restarted, and no subagent processes remain.
- **Writers:** none active. The last remote pushes were #570 (20:39Z), #581 (20:33Z) and #590 (20:16Z).
- **Auto-resume:** none pending. Routine `trig_01VpKve3Rt2rzZULAbbcCV7Q` was a one-shot that already fired and is disabled (`run_once_fired`). It was not deleted, because deleting a Routine bound to a session can delete that session.
- **PR-activity subscriptions:** none.
- **Locks:** `/tmp/ovd-{supabase,e2e,verify}.lock` have no holders; flock releases on exit.
- **Local services:** dockerd and the local Supabase stack are down since the restart. Not restarted on purpose.
- **This container is ephemeral.** It holds 72 worktrees, about 12 GB under `.claude/worktrees`. All dirty and unpushed state is copied into `wip/` in this folder (section 4), so this folder is the durable copy.

## 2. PRs: exact heads and state

All are owner `optomachina`, repo `Overdrafter`. Nothing has been merged; merging to main auto-deploys production and is protected.

- **Verified** means two consecutive clean rounds of the three adversarial reviewers, then a green CI, Sonar and bot gate.
- **Impl-only** means only the implementer's own evidence exists.

### OVD-520 staged-proof chain

| PR | Branch @ head | Base | Issue | State | Open items |
|---|---|---|---|---|---|
| #575 | `claude/ovd520-race-proof-role-cleanup` @527f051d | main | OVD-599 | Impl-only | Verify with `stacked_above` [#586, #590 branches]. Fixes the role leak behind main's replay drift. |
| #586 | `claude/ovd520-staged-sql-proof-ci` @45410498 | #575 | issue pending | Impl-only | Path-scoped CI for the staged SQL proofs (CI policy is an open question). Replay output preserved in `wip/patches/wf_a896b035-85f-1.untracked.tgz`. |
| #590 | `claude/ovd520-step-review-peer-revocation` @552e6e2f | #586 | issue pending | Impl-only; the agent died after opening the PR | Re-check the body and evidence first. |
| — | A3 `claude/ovd520-failed-attempt-terminal-proof`, then A1 `claude/ovd520-same-run-identity-proof` | #590 → A3 | — | Not started | Specs are in `specs/args-ovd520.json`. |
| #576 | `claude/ovd520-operation-failure-no-auto-retry` @4390110a | main | OVD-600 | Round-1 blocker (Sonar disposition) fixed at 4390110; round-2 acceptance lens clean, other lenses not run | Needs a full clean round 2 plus round 3, then the gate. |
| #582 | `claude/ovd520-failure-states-browser-fixture` @306fa7ed | main | issue pending | Round-1 blocker (Sonar duplication 8.3%) fixed; round-2 acceptance and boundary lenses clean, reproduce not run | Needs round-2 reproduce plus round 3, then the gate. The PR body wrongly calls the missing issue an "owner decision". |

### 1.0 gates

| PR | Branch @ head | Base | Issue | State | Open blocking items |
|---|---|---|---|---|---|
| #566 | `chore/OVD-597-ci-speed-sonar-config` @1b44a327 | #564 | OVD-597 | **Verified**; ready | None. |
| #577 | `claude/composer-submit-reentrancy` @8a4a37ed | main | OVD-603 (Human Review) | **Verified**; ready | CodeRabbit was rate-limited, so re-request it. Non-blocking: the tests don't pin guard-before-await (that mutation survives the unit tests but duplicates in a browser) or the dedupe-key fields. |
| #579 | `claude/public-meta-founding-beta-copy` @6ddac5b7 | main | issue pending | **Verified**; ready | Re-request CodeRabbit. |
| #581 | `claude/named-portfolio-6061-matrix` @d7d8c70f | main | OVD-612 (new) | The round-2 blocker was only the missing issue; OVD-612 now exists and the head moved | Re-verify at d7d8c70. |
| #578 | `claude/founding-beta-subscription-bypass-pgtap` @ab659ddd | #564 | issue pending | Round 2: one blocker | The body says Sonar annotations can't be read, but they can, and 6 issues have no disposition. The full-suite pgTAP failure comes from a base-only file. |
| #584 | `claude/client-rpc-least-privilege-pgtap` @ffde359a | #564 | issue pending | Round-1 blockers fixed at ffde359; round 2 not run | 27 Sonar issues had no disposition; the GAP-B1 premise was false. Re-verify. |
| #585 | `claude/quote-comparison-fixture-e2e` @722fca92 | #564 | issue pending | Round 1: 2 blockers | Check (h) misses order buttons, so it is vacuous. Check (e) skips the "Pending" selected-offer summary. A partial, unvalidated fix is in `wip/patches/wf_0b6046a7-ea0-11.patch`. |
| #583 | `claude/access-scope-enrollment-e2e` @ba7a3fd9 | #564 | issue pending | Impl-only | Found a real account-switch data leak, fixed in #587. Case 4 is gated by `E2E_ACCOUNT_SWITCH_LEAK_CHECK`. Case 3's owner positive control is flaky (5 s budget). |
| #587 | `claude/account-switch-nav-cache-reset` @771c9b8c | #583 | issue pending | Impl-only (failure-first proven; hosted CI green on attempt 3; Sonar 0 new) | Verify after #583. |
| #588 | `claude/intake-step-e2e` @769602b6 | #583 | issue pending | Impl-only (failure-first proven; hosted CI green) | Verify after #583. Aborts STEP preview GETs in intake contexts as a CPU workaround. |
| #589 | `claude/customer-error-sanitization` @28ea3377 | #564 | issue pending | Impl-only (13 failing tests now pass; CI green after a re-run) | 1 Sonar issue without a disposition. The body says "owner-decision re-scope", but the run made that re-scope, not Blaine. |
| #567 | `refactor/OVD-595-production-bundle-cleanup` @1d71236b | #564 | OVD-595 | Round 1: one blocker | The body is stale against the head: it omits the CI/proof-lane changes and gives the wrong rollback path. |
| #570 | `refactor/OVD-594-web-strict-null-checks` @69585df6 | #564 | OVD-594 | Round 1 at 6335638 had 13 blockers; a fixer pushed 69585df at 20:39, which is unverified | Needs #567 first (QuoteChart hunk); a vacuous generic-message test; false body claims; callRpc null widening. |
| #572 | `fix/OVD-593-worker-browser-hardening` @a659e9b9 | #564 | OVD-593 | Round 1: 15 blockers (deduped below) | The body doesn't match the head and ticks AC1, which is protected. OVD-419 appears in the body and in commit c01722e; the history can't be rewritten, so disclose it. The "review record" claims a fix that never happened. CodeRabbit is missing. The child issues now exist (OVD-610, OVD-611). A partial, unvalidated fixer draft (8 files) is in `wip/patches/wf_3d51ac3f-711-10.patch`. |
| #569 | `fix/OVD-596-mobile-nav-escape` @189d486c | #564 | OVD-596 | Evidence unit not completed | Repeat evidence only; commit only if a defect shows. |
| #580 | `claude/ovd598-legacy-xometry-admission-locks` @aae19bdc | #574 | OVD-598 | Impl-only | Adds migration 137. Verify after the #574 stack. |
| — | `claude/server-empty-file-upload-rejection` (local only) @33abd621 | #580 | OVD-601 | **Unpushed commit**; no PR | Restore it from `wip/bundles/server-empty-file-upload-rejection.bundle`. |
| — | `claude/api-role-privilege-inventory` (no commits) | #574 | OVD-602 | Not started | — |

### Pre-existing stack and other PRs (not reviewed this run)

| PR | Branch @ head | Base | Issue |
|---|---|---|---|
| #564 | `codex/recovered-release-free-safety-20261003` @084b48c5 | main | Integration base for most PRs (draft) |
| #568 | `feature/OVD-457-provider-neutral-envelope` @c35d054b | #564 | OVD-457 |
| #571 | `fix/OVD-536-audit-writer-grants` @f5c8c823 | #564 | OVD-536 |
| #573 | `feature/OVD-458-provider-dispatch-permits` @9e901502 | #571 | OVD-458 |
| #574 | `feature/OVD-459-provider-dispatch-preflight` @ac5026fe | #573 | OVD-459 |

Others:
- **#565** (`handoff/jarvis-reviewed-e5e3db0` @bae69fbf) is frozen; what to do with it is an open question.
- **#563** (`spike/chatgpt-app-foundation`) and **#530** (`codex/ovd549-ledger`) were not touched.

Per-PR finding details are in `findings/open-findings-summary.json`, `findings/prior2-*.json` (latest reviewer outputs with evidence) and `findings/prior-*.json`.

## 3. Dependency and merge order (every merge is an owner-only protected action)

1. **#564 → main.** Needs the production DB release window and accepts the Vercel production auto-deploy.
2. **PRs on #564:**
   - #566, #569, #572, #578, #584, #585 and #589 are independent of each other.
   - #567 must land before #570.
   - #583 comes before #587 and #588.
3. **Provider chain:** #564 → #568 → #571 → #573 → #574 → #580 → OVD-601 (bundle). OVD-602 is based on #574.
   - Each new migration (137, 138, …) needs the free-quote CI profile hashes re-pinned.
4. **Main-based PRs:** #575 → #586 → #590 → A3 → A1. #576, #582, #577, #579 and #581 are independent.
   - Whether to stack on #564 or target main is still an open question.

## 4. Uncommitted and unpushed work (everything is copied under `wip/`)

| Item | Location here (ephemeral) | Durable copy | Nature |
|---|---|---|---|
| OVD-601 commit 33abd621 | branch `claude/server-empty-file-upload-rejection` in `/home/user/Overdrafter` | `wip/bundles/*.bundle` (`git fetch <bundle> claude/server-empty-file-upload-rejection`) | Real work, not pushed |
| #572 fixer draft (8 files) | `.claude/worktrees/wf_3d51ac3f-711-10` | `wip/patches/wf_3d51ac3f-711-10.patch` | Partial and unvalidated (the agent was killed) |
| #585 fixer draft (3 files) | `.claude/worktrees/wf_0b6046a7-ea0-11` | `wip/patches/wf_0b6046a7-ea0-11.patch` | Partial and unvalidated |
| C1 replay evidence (`output/`) | `.claude/worktrees/wf_a896b035-85f-1` | `wip/patches/wf_a896b035-85f-1.untracked.tgz` | Evidence |
| OVD-596 base repeat data (`ovd596.json`) | `/home/user/wt/ovd596-base` | `wip/patches/ovd596-base.untracked.tgz` | Evidence |
| Superseded first attempts (nav fix, error sanitization) | `wf_5fcc93c7-82c-1`, `wf_64923e05-147-1` | `salvage/` and `wip/patches/` | Superseded by #587 and #589 |
| Reviewer scratch (security probes, merge simulation) | `/home/user/wt/{fbsub-sec-*,r581-merge}`, `scratchpad/sec57[48]-574` | `wip/patches/` (the 3 MB r581-merge patch is omitted; it is a merge simulation) | Scratch |
| Stale indexes (a reverse diff after the branch moved) | `wf_0b6046a7-ea0-7`, `wf_2e22b21a-10d-5`, `wf_5fcc93c7-82c-2`, `wf_e4dcf8a5-5b9-{2,3}`, `wf_f81db40d-655-{1,3}` | `wip/patches/` | Not work; ignore |

Full worktree inventory: `wip/wt-inventory.txt`.

## 5. Queue for the successor (in order)

1. **OVD-520 (priority 1):**
   - Verify #575 → #586 → #590 as one lane, with `stacked_above`.
   - Finish #576 and #582.
   - Implement A3, then A1. Their specs are in `specs/args-ovd520.json`, and C1 is done.
2. **Carried-over fixes (priority 2).** Each prior2 file can be passed as `pending_fix_file`:
   - #572: `prior2-U572` plus the WIP patch.
   - #585: `prior2-QUOTE-DECISION-FIXTURE-E2E` plus the WIP patch.
   - #567: body only.
   - #578: body, plus Sonar dispositions.
3. **Re-verify at moved heads:** #570 @69585df, #581 @d7d8c70, #584 @ffde359.
4. **Verify implementer-only PRs:**
   - #583, #587 and #588, in that order;
   - #589;
   - #580, after the #574 stack closeout units (#568, #571, #573, #574).
5. **Implement:**
   - push the OVD-601 bundle and open its PR on the #580 branch;
   - OVD-602;
   - OVD-596 evidence on #569.
6. **Queued units (priority 3, never started):** listed in `specs/args-queued.json`.
   - UI-LEGACY-SHELL-A11Y and UI-ACCOUNT-MENU-CONTRAST (base main).
   - A11Y-KEYBOARD-NO-AXE and UI-STATUS-BADGE-CONTRAST (base #564).
   - SAMPLE-PLATE-RETAINED-LABEL-E2E and OSHCUT-ADAPTER-CONTRACT (OVD-402).
7. **Cleanup** (`findings/post-verify-cleanup.md`):
   - Fix PR bodies that call the missing Linear issue or the re-scope an "owner decision".
   - Re-request CodeRabbit on #577 and #579.
8. **Deferred or dropped units, open questions and protected actions:** see `stable/handoff-stable.{md,json}`. It has 54 open questions (the top 5 are marked), 23 protected actions, 21 contradicted handoff claims, and gate status for U1–U18 and R1–R30, none passed.
9. **Lane B (visual system, homepage, iOS)** is blocked on Blaine's pick among the three proposals at https://claude.ai/artifact/GQrofbwcXsWDB4KkyuMrtB (source in `laneb/index.html`).

**Linear:**
- OVD-599, 600, 601 and 602 are In Progress; OVD-603 is in Human Review. They have rolling comments.
- Fixers created OVD-610 and 611 (children of OVD-593) and OVD-612 (child of OVD-199) at 19:54–20:25Z, so the free-plan issue limit may no longer block issue creation. Re-check before creating the pending child issues.

## 6. Cloud setup and storage requirements

Details are in `env/ENV.md`.
- **Container:** 4 CPUs, 15 GB RAM, no IPv6. The disk is a per-session allowance, and this run hit ENOSPC repeatedly.
  - A fresh `npm ci` costs about 650 MB per worktree.
  - Symlink a shared `node_modules` when the lockfiles match main's or #564's.
  - Put TMPDIR and the npm cache on `/dev/shm`.
  - Budget at least 25 GB.
- **Docker:** run `nohup dockerd &` again after every worker restart.
- **Supabase CLI 2.78.1:**
  - Install it via `env/supabase-wrapper.sh`, which sets `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io` because public.ecr.aws returns 403.
  - Build `env/realtime-ipv4.Dockerfile` and tag it `supabase/realtime:v2.78.10`; this patches socket_opts to inet.
  - Start with `supabase start -x studio,vector,logflare,imgproxy,edge-runtime`.
- **One shared local stack** at API 127.0.0.1:54321 and DB 127.0.0.1:54322. Every DB command runs under `flock /tmp/ovd-supabase.lock`; Playwright runs under `/tmp/ovd-e2e.lock`; `npm run verify` runs under `/tmp/ovd-verify.lock`.
  - This full stack (about 8 containers) exceeds the control-plane fixture-lane ceiling of 2 containers. It was used with synthetic data only; disclose that.
- **Playwright 1.58.2:** chromium_headless_shell-1208 is a symlinked copy of the 1194 layout under `/opt/pw-browsers`. Never run `playwright install`.
  - Branches based on #564 set `chromiumSandbox: true`, so run Playwright as the non-root `ubuntu` user (see the ENV.md recipe).
- **Blocked by egress:**
  - deno.land: Edge Function tests run only in hosted CI.
  - sonarcloud.io: read Sonar through GitHub check-run annotations; false-positive marking needs Blaine.
- **Disposable SQL replay** (`scripts/ovd510-disposable-replay.mjs --reviewed-authority-baseline --durable-migration --ovd563`):
  - needs commit 000d82a3 fetched (`git fetch --unshallow` if needed);
  - needs `/usr/local/bin/docker` and public.ecr.aws-named tags of the Docker Hub images.
- **Guards:** the permission guard refused `git worktree remove` and some mutation runs (#583 case 4, #581 Weerg). Plan for scratch-copy mutations instead.

## 7. Windows / SolidWorks remote access

There is **none from a cloud container.** This session had no reachable Workstation or Mac sessions (ListAgents was empty).
- **Workstation:** x64 Windows PowerShell 5.1, SolidWorks 2022 SP5 (30.5.0.0049), on Blaine's tailnet `workstation.tailc7a174.ts.net`.
  - The only route is the OVD-579 private Tailscale Serve `/sample-plate/` → 127.0.0.1:8092. It is read-only, and new builds are denied.
  - Cloud containers are not on the tailnet.
- **Possible methods, all needing Blaine's approval first:**
  - a Claude Code Remote Control session that Blaine starts on the Workstation or Mac (it would then appear in ListAgents);
  - Blaine running the `scripts/native/*/README.md` commands himself.
  - GitHub-hosted `windows-2022` runners cover only the inert PowerShell 5.1 suites. They do not cover SolidWorks or the pinned compiler, and pwsh 7 here never counts as Windows qualification.
- **Blockers:**
  - Workstation and Mac sessions need Blaine's approval.
  - Do not touch the dirty OVD-578 and OVD-579 worktrees on the Workstation.
  - `scripts/native/prepared-dimension/run.ps1:245` refuses to start while any SLDWORKS process exists, but OVD-578 keeps PID 7460 open and must never kill it. That needs an owner decision.
  - /engineering is loopback- and dev-flag-only, so a phone can't reach it; the route is an open question.
  - The backend target (hosted versus a Workstation-private Supabase) is undecided.
  - X1 (Workstation exact-source qualification), X2 (backend activation packet) and X3 (the connected 7 mm run with recording) are all protected.
  - Owner-only artifacts on no remote:
    - the Mac branch `feature/OVD-520-phone-loop`;
    - Quickparts commit 72b45234;
    - `jarvis-source-complete-e5e3db0.bundle`;
    - the handoff zip, SHA-256 af316c1d….
  - Rotate the credential pasted into a Codex prompt on 2026-09-27.

## 8. Ultracode workflow entrypoint and settings

**Scripts:** `workflows/verify-workflow.js` and `workflows/implement-workflow.js`. Launch them with the Workflow tool, `{scriptPath, args}`.
- **First edit `const S = ...` in both scripts** to the folder that holds `ENV.md`, for example a copy of `env/`.
- Rewrite the `spec_file`, `prior_file` and `pending_fix_file` paths to your location.

**Implement args:**
```
{lanes:[[{key, issue|null, issue_url, pr_prefix, title, branch, base, depends_on, existing_pr|null, no_parent_mention, spec_file}]]}
```
- Lanes run in parallel; units within a lane run in order.
- Each agent gets worktree isolation and effort max, and opens one draft PR per unit.
- Existing-PR mode adds commits only and never force-pushes.

**Verify args:**
```
{lanes:[[{key, pr_number, branch, base, issue, head_sha, spec_file, stacked_above:[], no_parent_mention, prior_file?, pending_fix_file?}]], clean_needed:2, max_fix_rounds:3}
```
- Three lenses run per round (acceptance, boundary, reproduce); reproduce uses a worktree; all run at effort max.
- On blocking findings, one fixer (the single writer) runs and merges forward into `stacked_above` branches.
- The loop runs until 2 consecutive clean rounds.
- A round with failed reviewers is retried, up to 3 times.
- `pending_fix_file` runs a carried-over fix first.
- "Owner-blocked" items (the Linear limit, a missing bot review on a draft, protected actions, unreachable Sonar text) are classified non-blocking.
- The final gate checks CI, Sonar annotations and bot threads. It marks the PR ready, comments once and moves Linear to Human Review only when green.

**Operating notes:**
- Concurrency is CPUs − 2 agents per workflow, so 2 on this host.
- This run hit the org spend limit twice while 6–11 workflows ran at once. Keep 4 or fewer concurrent workflows and checkpoint often.
- Never write parent IDs (OVD-520, 527, 319, 419, 199, 359, 332, 385) in branches, commits or PR text. A bare mention auto-closes the parent.
- Follow AGENTS.md and `docs/agent-development-control-plane.md`.
