# Architecture refactor decisions — 2026-10-24

- Owner: Blaine.
- Related plan: [architecture review and refactoring plan](architecture-refactor-2026-10-23.md), OVD-1073.
- Scope: design decisions only; no repository settings, credentials, sensitive-path policy, hosted functions or production database changes.
- Evidence: the supplied research memos *S0.3: a trusted merge gate for OverDrafter* (2026-10-24 04:32 UTC) and *Q1 research memo — a conservative whole-glob split produces no measured approval savings* (2026-10-24 04:30 UTC), both pinned to `426df5ea630fecff1f89a55be1b876320c0b8f7e`. Their read-only observations are summarized below; they were not refreshed through hosted calls for this document. Observed settings and measurements are distinct from proposed, untested designs.

## S0.3 — trusted required gate: deferred

**Context (observed in the memo).** The research inspected all 22 workflow files and read repository/ruleset/protection/Actions/environment settings. OverDrafter is public and personal-account-owned; rulesets were empty. Classic main protection required `ci` and `provider-go-live`, both from GitHub Actions (App id 15368), with strict mode and admin enforcement enabled. Pinning GitHub Actions identifies an App, not a particular workflow: a PR-authored workflow can impersonate the required job name. A read-only default token does not make workflow definitions immutable.

**Options considered.**
- Repository-ruleset required workflows: the memo's official-documentation research found that the rule needs **GitHub Enterprise Cloud organization ownership**; ordinary personal-repository rulesets or moving to a Free/Team organization do not supply it.
- A default-branch aggregator or workflow_run that trusts PR job conclusions: it would authenticate the reporter while accepting fabricated execution evidence.
- A main-defined `pull_request_target` harness with isolated, secretless candidate execution and a dedicated GitHub App check-run reporter: workable in principle for this repository. An ordinary PAT or GitHub-Actions-bound job does not provide the required separate reporter identity.
- Keep today's required checks while the prerequisite is addressed.

**Decision.** **Deferred by Blaine. Keep the current `ci` and `provider-go-live` requirements.** Do not create an App/key/environment, change branch protection or add helper globs under this decision. The research credential available to agents reported repo admin; such an agent could edit branch protection despite admin enforcement. Credential separation is a prerequisite to claiming a gate resistant to agents with repository write access. The observation is about that credential, not an audit of every agent credential.

**Consequences and retained design.** The existing PR-defined-check limitation remains. If reopened, use a trusted main workflow triggered by pull_request_target, fresh secretless runners for candidate code, and a dedicated App with Checks read/write whose private key is held only in an environment restricted to **Branch main**, with no tag/PR rules. Pin the required `trusted-gate` check to that App identity. The credentialed reporter must never execute candidate code or accept candidate-supplied success artifacts. Bind evidence to trusted base/workflow B, PR head H and verified merge M; reject stale or missing/cancelled work and report on the exact required revisions.

Trusted execution must reproduce the full required graph (`.github/workflows/ci.yml:660-672,705-715`): lint/typecheck, portable/database/Edge/integration checks, three unit shards, three browser lanes, both builds, worker verification, network proof and three SQL qualifications, plus independently validated provider-go-live. Preserve the same-head OVD-591 prerequisite (`scripts/run-supabase-policy-tests.mjs:58-60`). Execute the extraction producer as well as its output decision (`.github/workflows/ci.yml:475-517,747-758`; `scripts/extraction-gate-decision.mjs:44-63`). Use a trusted reference corpus and preserve configured report/enforce semantics. Secretless PR evaluation measures the deterministic parser path; model-backed coverage needs separately controlled evaluation, not real keys in arbitrary PR code.

The memo identified a harness trap: invoking the base copy of `preflight.sh` unchanged tests its own checkout and delegates to package scripts. A candidate-aware harness is needed. Test-count floors signal regressions; they do not prove assertion quality. Helper/config protection and substantive review remain necessary, and exceptions must bind Blaine's approval identity to the head rather than trust a writer-settable label.

**How to revisit.** Reopen with Blaine after removing agent repo-admin/environment/App-management authority, confirming then-current entitlement/event-policy availability, and preparing the complete harness and exact protected setup packet. Before enforcement, test lane/producer/decision tampering, wrong-App/same-name forgery, reporter-key isolation, stale B/H/M and cancelled/missing work. No forgery test or rollout was performed in the memo. Retain the two current checks during qualification; any later rollback removes only the new App-bound requirement before its workflow/key, preserving current protection. Q9 and Q10 remain attached to this deferral.

## Q1 / S7.1 — two-tier sensitive paths: dropped

**Context and method (observed in the memo).** The measurement used the pinned checkout's `loadSensitivePaths`/`classifyPaths` over all `git ls-files -z` paths, the original plan's 37 non-withdrawn Files cells and every changed filename (including previous rename names) in the last 100 merged PRs. PRs were selected by actual merge time, with a pagination cutoff older than the 100th merge; the cohort ran 2026-10-16 through 2026-10-24. All **935 changed-file records** were fetched; file counts and unchanged head SHAs were cross-checked for **100/100** PRs. The hypothetical configurations existed only in memory. No card/comment audit measured founder interventions.

**Options considered.** Keep the 162-glob list, or conservatively assign **159 globs to Tier A** (owner approval plus Opus) and **3 to Tier B** (Opus without path-triggered approval), with any A match winning. The B candidates were narrow drift-reporting, catalog-diagnostic and read-only worktree-inventory globs. Broad test/Markdown exemptions were rejected because those files can implement gates.

**Decision.** **Dropped by Blaine. No change to the sensitive-path list or approval policy.** The candidate changes the approval outcome of **0 of 37 roadmap steps and 0 of the last 100 merged PRs**. Preserve S7.1 only as a historical proposal.

**Consequences.** Of 3,038 tracked files, the list's owner-approval union would fall only from 1,367 (45.00%) to 1,362 (44.83%); five files would become review-only while Opus coverage stayed 1,367. Both configurations matched 29/37 roadmap steps and 64/100 PRs. The full path policy required 35/37 steps and at least 71/100 PRs in both cases; a Markdown-only interpretation of the docs allowance makes the latter 72. These are retrospective path requirements, not observed approval cards or proof that the remaining PRs could auto-merge.

The load comes from genuinely sensitive schema/migration/provider-dispatch work and from ordinary app/worker code outside auto-merge categories. Three PRs touching proposed B files also touched A, so none moved. There is no demoted PR cohort demonstrating safety or savings; the list's percentage alone does not justify gate loosening.

**How to revisit.** Only a materially different proposal with measured intervention data and a new pinned replay showing useful savings without demoting gate implementation warrants reconsideration. Separating diagnostic leaves from enforcement would be a new proposal. Any future tier demotion remains gate loosening with its existing authorization requirements; this decision grants none.

## Q3 — pg_cron stuck-work sweeper: acceptable in principle

**Context (observed/inferred).** Today terminal-task replay is invoked inside the worker reaper (`worker/src/queue.ts:226-229`); no-worker termination/replay is therefore not guaranteed. The race and outage consequences are inferred from code, not newly exercised here. The plan requires bounded queue-wait, lease and absolute deadlines plus historical terminal-lane and completed-task-follow-up replay.

**Options considered.** Keep worker-only cleanup; add an external scheduler; or let pg_cron invoke bounded SQL sweeps/drains every five minutes and become the sole stale-transition owner after a verified handoff.

**Decision.** **Acceptable in principle, per Blaine. Enabling pg_cron in production and applying the sweeper migration remain separate protected approvals.** This is permission to design and qualify the change, not to execute either production action.

**Consequences.** S1.3 must land before S1.4; cron runs terminal-lane replay and durable follow-up even when no task newly expires. Per-claim lease initialization and lease-aware reapers precede renewal, every old reaper retires before renewal, and S1.7 precedes the database sweeper. Qualify lock contention, deadlines, bounded/idempotent batches, interrupted settlement and pre-existing cancelled/released cases with no worker before removing worker replay ownership. Provider work is never requeued by the sweeper.

**How to revisit.** Prepare separate extension-enable and migration approval packets after the local/staging evidence and rollback/unscheduling procedure are ready. Reconsider the scheduler choice if qualification cannot prove no-worker settlement, acceptable database load and a single cleanup owner. No production extension, migration or schedule was changed by this decision.
