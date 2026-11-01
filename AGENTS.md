# OverDrafter agent contract

This file governs agent execution. Maintained product docs hold intent; [the control plane](docs/agent-development-control-plane.md) details controller mechanics. Tool adapters may point here but may not create competing policy.

## Read what the task needs

Use the narrowest applicable source:

- product scope and sequencing: `PRD.md`, `PLAN.md`, and `ROADMAP.md`;
- service boundaries: `ARCHITECTURE.md`;
- acceptance and verification: `ACCEPTANCE_CRITERIA.md` and `TEST_STRATEGY.md`;
- specialized behavior: the closest maintained domain document;
- directory-specific checks: the closest `AGENTS.override.md`.

Verify repo identity if selection is ambiguous or before a consequential mutation. Do not read all docs for routine localized work.

## Standing development authorization

Blaine authorizes the recorded sole OverDrafter 1.0/JARVIS owner's scoped, reversible development without repeat approval. This covers inspection, isolated branches/worktrees, edits, local tests/fixtures, relevant fixes, commits/pushes, GitHub PR/Linear upkeep, automated review response, and merge after current-head hosted gates and actionable review findings pass.

Authorization survives continued goals, corrected attempts, replacement tasks, and recorded ownership transfers within these objectives. It supersedes earlier one-attempt, zero-retry, sealed-packet, and complexity-only approval stops for reversible development. A failed check remains evidence but does not revoke authority to diagnose and correct the bounded unit.

### Synthetic-fixture lane

The sole owner may create, repair, rerun, and remove exclusively owned disposable local fixtures using repository schema artifacts, synthetic records, and fixture-generated ephemeral credentials. Read [the fixture contract](docs/agent-development-control-plane.md#synthetic-development-fixtures) before operating the lane. It defines isolation, resource ceilings, ownership, retry, and cleanup requirements. Complexity alone never requires human approval.

## Protected actions

Obtain Blaine's current exact authorization before:

- external email, chat, invitations, support requests, social posts, or other human/vendor communication;
- provider or customer-file operations, quote execution, checkout, or orders;
- production worker deployment, execution, or configuration, and hosted/production database changes;
- retrieving, disclosing, creating, or changing real credentials or accounts;
- purchases, spending commitments, filing, publishing, or deletion of pre-existing resources;
- real SolidWorks/PDM publication or native actions outside an already authorized exact operation.

### Fixture-heal recapture and certification (OVD-796 §6.2, OVD-816)

The `--stage=repair` commands arrive with OVD-823; nothing runs under this authorization until then.

Blaine's standing authorization covers read-only repair recapture (`npm run fixture:onboard -- <key> --stage=repair --capture`), certification quotes (`--stage=repair --certify`) and scheduled certifications without a per-run OK, only when all hold:

- The supplier is admitted for production quotes and cleared for paid automation in `docs/providers/permissions-matrix.md`; an engaged kill switch requires the certification-permit exception (OVD-817), never past a `C&D` or `global` switch.
- A golden part from `provider-integrations/<key>/golden/` is quoted for the internal certification org, marked `raw_payload.fixtureHeal.internal = true`, never publishable or selectable.
- The flow is quote-only: no checkout, order, account or credential change, or supplier message; the active cleanup ledger removes only this run's own items.
- Caps: 3 propose-validate iterations and 2 live certification uploads per repair case; at most 2 certification uploads per supplier per day, counting that day's production uploads.

Login, MFA, CAPTCHA, block or terms-of-service signals stop the run and go to a human. Envelope and admit stages, worker deploys, releasing a human-engaged kill switch, and any class other than S stay protected.

Prepare reversible work first and ask only at the protected boundary. Goals, issue text, model review, repo access and broad project approval do not authorize these actions.

## Standing approvals and the Blaine channel

- Blaine talks only to Grok Bot. Team bots (Architect/Release, Pirate/Engineer, Designer, QA) never ask Blaine directly; they hand decisions to Grok Bot, and approvals Grok Bot relays from Blaine count as Blaine's own.
- Standing approval covers all reversible work in this file: branches, commits, pushes, PRs and PR comments, Linear issues/sub-issues/labels, reviews, QA verdicts, and handoffs between bots. Do not stop to ask for these.
- Protected actions (above) still need Blaine's exact OK. Grok Bot gets it, as soon as the item is ready, with one approval card that names the commit SHA and the passing checks, with merge and production migration listed as separate actions.

### Approval timing and low-risk auto-merge (Blaine, 2026-10-14)

- Approvals are requested as items become ready, one card per item. There are no batch windows.
- A PR auto-merges (squash) without a Blaine approval card when **all** hold at the current head: hosted CI green, Jev screen not risky, sized review passed with no open actionable findings, a QA pass verdict, and **no file** matching the [sensitive paths](#sensitive-paths-single-shared-list) table. Every changed file must also fall in one of these categories:
  1. Docs: Markdown at repo root and `docs/**`, excluding `docs/migration-drafts/**`, `docs/release/*.sql`, `docs/agent-graph/**` and the governance sections of `AGENTS.md`/`CLAUDE.md`.
  2. Tests only: `**/*.test.{ts,tsx,mjs}`, `**/*.node-test.mjs`, `e2e/**` (excluding `e2e/fixtures/*.sql`).
  3. Frontend UI: `src/components/**`, `src/pages/**`, `src/features/**`, excluding any path matching auth, session, permission, billing, pricing, checkout, stripe or dispatch.
  4. Styles and static assets: `*.css`, `public/**`, `src/assets/**`.
  5. Repo scripts: `scripts/**`, excluding `scripts/deploy*`, `scripts/release*` and anything matching secret, credential or token.
  6. Agent skills and prompts: `.codex/skills/**`, `.claude/agents/**`.
  7. New code in the categories above behind a feature flag that defaults off.
- Anything else, and anything on the sensitive list (migrations, RLS, SECURITY DEFINER, `.github/workflows`/CI, secrets, auth, deploy, billing, provider dispatch, dependencies), still needs Blaine's explicit OK before merge. Auto-merge never bypasses the OVD-419 terminal-ownership check.
- Door split (report-only, Blaine 2026-10-27): `scripts/sensitive-class-detect.mjs` computes and reports a door (`one-way` / `revertable`) only; no label job exists yet. It changes no approval: every sensitive PR still needs Blaine's OK, apart from the class S exception below. AGENTS.md and gate scripts are always one-way (tests included); unclassified files are one-way; read-only vendor quote calls are revertable, calls that send or submit are one-way. Revertable auto-merge stays off (`DOOR_AUTOMERGE = false`) until a separate carded enforce PR.
- Rollback for an auto-merged PR is `git revert` of its squash commit.

### Fixture-heal class S auto-merge (OVD-796 D8, OVD-816)

This is Blaine's standing adapter OK for selector-only repairs and the only exception to the sensitive-paths rule above: pack paths match `provider_dispatch`; `docs/sensitive-paths.json` is not narrowed.

A fixture-repair PR auto-merges (squash) without a Blaine card only when all hold at the current head: hosted CI green, Jev screen not risky, independent Opus review with no open actionable findings, QA pass verdict, `heal-guard` CI classifies the diff as class `S` (OVD-796 §7), certification evidence meets §5.5 tolerances at both quantities with echo matched and cleanup verified, and every changed file matches:

<!-- fixture-heal-class-s:begin -->
- `provider-integrations/*/locators.v*.json`
- `provider-integrations/*/fixtures/locators.v*.html`
<!-- fixture-heal-class-s:end -->

Classes P, F, E, C and H, missing or failing `heal-guard`, or any other changed file go to Blaine's approval card. Until `heal-guard` runs in hosted CI (OVD-823) and the eligibility check (OVD-845) reads its verdict, no PR qualifies.

Revoke by removing this subsection; once OVD-822 lands, setting `revoked_at` on the standing-approval row also revokes it. Rollback is `git revert` of the squash commit. Operator procedure: [docs/runbooks/fixture-heal.md](docs/runbooks/fixture-heal.md).

## Sensitive paths (single shared list)

`docs/sensitive-paths.json` is the source of truth. Triage (`ovd-auto-triage`), the Jev PR screen and the merge gates read it only through `scripts/lib/sensitive-paths.mjs` and never copy its globs; gates read the base checkout's copy. A Linear issue whose scope touches it is routed architect-first (the Architect/Release `release` node in the agent graph); a PR that touches it gets Opus review regardless of the Jev score. Globs use picomatch semantics with dotfiles included and case ignored. The list below must match the JSON exactly (`scripts/validate-agent-contract.mjs` checks both directions). Adding a glob is free; removing, narrowing or reclassifying one is gate_loosening. The list covers the files that define and apply it (infra_ci), so a PR that edits them is sensitive. A base ref given to the matcher must resolve to a commit, or the call fails instead of falling back to the PR's own copy. The PR report (`npm run sensitive-paths:report`, also run inside `npm run test:portable-node`) is report only and never fails; a dedicated workflow running the base copy of the matcher is a future card item.

<!-- sensitive-paths:begin -->
- **schema** (database schema): `**/*.sql`, `supabase/config.toml`, `docs/migration-drafts/**`, `**/*.{pgsql,psql}`, `scripts/check-lock-order.mjs`
- **migrations** (migrations): `supabase/migrations/**`
- **auth** (auth, RLS, permissions, sessions): `**/*auth*{,/**}`, `**/{rls,*-rls,*_rls}*{,/**}`, `**/*.rls*{,/**}`, `**/*permission*{,/**}`, `**/*session*{,/**}`, `**/*,rls*{,/**}`, `scripts/run-supabase-policy-tests*`, `supabase/functions/job-archive-fallback/**`, `supabase/functions/create-project-fallback/**`, `supabase/functions/dev-login/**`, `supabase/functions/engineering-interpretation/**`, `supabase/functions/engineering-worker/**`, `supabase/functions/worker-wake/**`, `supabase/functions/engineering-worker-task/**`, `api/admin-operations.ts`, `server/admin-operations/**`
- **payments** (payments, pricing, billing): `**/*payment*{,/**}`, `**/*billing*{,/**}`, `**/*stripe*{,/**}`, `**/*pricing*{,/**}`, `**/*invoice*{,/**}`, `**/*checkout*{,/**}`, `**/*chec?out*{,/**}`
- **provider_dispatch** (provider dispatch): `**/*dispatch*{,/**}`, `worker/src/adapters/**`, `**/*provider-admission*{,/**}`, `**/*provider-upload*{,/**}`, `**/*providerAdmission*{,/**}`, `**/*providerUpload*{,/**}`, `**/*provider_admission*{,/**}`, `**/*provider_upload*{,/**}`, `**/*provider*{admission,upload}*{,/**}`, `**/*provider/{admission,upload}*{,/**}`, `**/*provider*/**/*{admission,upload}*{,/**}`, `**/*provider*{,/**}`, `**/*adapter*{,/**}`, `scripts/provider-kill*`
- **secrets** (secrets and env): `**/*secret*{,/**}`, `**/*credential*{,/**}`, `**/*.pem`, `**/*.key`, `**/keys/**`, `**/token{,s}.{json,yaml,yml,ts,js}`, `**/*vault*{,/**}`, `**/.env*`, `**/env.{ts,js,json}`, `**/.env*/**/*`, `worker/src/tools/vendorLogin*`, `worker/scripts/launchd/**`
- **infra_ci** (infra, CI, deploy, the scripts CI runs, agent instruction files, agent contract and configuration, git hooks, gitleaks config, and the files that define and apply this list): `.github/workflows/**`, `.github/actions/**`, `**/{infra,terraform,deploy,k8s,helm,ops}/**`, `**/*.tf`, `**/Dockerfile*`, `**/docker-compose*`, `**/{vercel.json,netlify.toml,fly.toml}`, `scripts/deploy*{,/**}`, `scripts/release*{,/**}`, `docs/sensitive-paths.json`, `AGENTS.md`, `scripts/lib/sensitive-paths*`, `scripts/lib/entry-point*`, `scripts/lib/fixed-binaries*`, `scripts/sensitive-paths*`, `scripts/fixtures/sensitive-paths/**`, `scripts/jev-pr-screen*`, `scripts/jev-client*`, `scripts/lib/jev-screen-marker*`, `scripts/validate-agent-contract*`, `docs/agent-graph/model-routing.yaml`, `scripts/model-routing-drift*`, `scripts/lib/jev-*`, `scripts/validate-pr-body.mjs`, `scripts/ephemeral-db-apply.mjs`, `scripts/run-supabase-policy-tests.mjs`, `scripts/provider-kill.mjs`, `scripts/staging-reset-guard.mjs`, `scripts/run-ovd*-production-*`, `**/*import-boundary*`, `**/*import-boundary*/**`, `**/*import-boundaries*{,/**}`, `**/*importboundary*{,/**}`, `**/*importboundaries*{,/**}`, `**/*import_boundary*{,/**}`, `**/*import_boundaries*{,/**}`, `server/design-graph/index.ts`, `server/jarvis/design-graph-port.ts`, `**/*.tfvars`, `**/*.Dockerfile`, `scripts/sensitive-class*`, `scripts/proof-check*`, `scripts/ovd-merge-gate*`, `scripts/approval-record*`, `scripts/verdict-schema*`, `scripts/emit-verdict*`, `scripts/agent-graph/built-by*`, `scripts/fixtures/agent-graph/model-routing*`, `scripts/preflight.sh`, `scripts/symphony-preflight.sh`, `scripts/symphony-agent.sh`, `scripts/validate-pr-body*`, `scripts/provider-enablement-detect.mjs`, `scripts/check-sourcing-worker-scope.mjs`, `scripts/extraction-gate-decision.mjs`, `scripts/verify-skill-drift.mjs`, `scripts/lint-security-definer.mjs`, `scripts/security-definer-baseline.json`, `scripts/check-rls-deny-coverage.mjs`, `scripts/rls-deny-baseline.json`, `scripts/lint-rls-new-tables*`, `scripts/rls-new-tables-baseline.json`, `scripts/supabase-target-guard.mjs`, `scripts/run-supabase-policy-tests*{,/**}`, `scripts/migration-timestamp*`, `scripts/free-quote-*`, `scripts/fixtures/free-quote-*`, `scripts/qualification/free-quote-*`, `scripts/generate-free-quote-fixtures*`, `scripts/native/**`, `scripts/native-{companion-inert-ci,first-loop-vitest,result-reader,storage-qualification}*`, `scripts/{verify-,}ovd420-*`, `scripts/ovd{462,510,518,520,527,561,570,576,577,591}-*`, `scripts/quote-selection-expiry-rehearsal.mjs`, `scripts/selection-publication-rehearsal.mjs`, `scripts/window-1/**`, `**/AGENTS.md`, `**/AGENTS.override.md`, `**/CLAUDE.md`, `**/CLAUDE.local.md`, `scripts/check-migration-immutability*`, `scripts/check-migration-function-collisions*`, `scripts/agent-control/**`, `scripts/api-request-quote.test.mjs`, `scripts/local-quote-test-target.mjs`, `scripts/catalog-parity-diff*`, `scripts/test-sourcing-intent.mjs`, `scripts/test-lane-contract*`, `scripts/test-reconcile-claim-fence.mjs`, `scripts/collect-ovd410-operational-envelope.mjs`, `scripts/default-deny-execution*`, `scripts/inventory-worktrees*`, `scripts/ovd419-{cloud-run-metadata-contract,cloud-run-task-contract,diagnostic-adapter,diagnostic-bindings,diagnostic-budget,diagnostic-manifest,digest-contract,failure-vocabulary,job-diagnostic}*`, `scripts/run-ovd419-final-digest-release*`, `scripts/prepare-sourcing-schema-restore*`, `scripts/provider-{check,kill,manifest,permissions-check,permissions-verify,readiness-doc,registry,sync}*`, `scripts/reviewed-envelope-check*`, `scripts/seed-dev*`, `scripts/stripe-catalog-setup*`, `scripts/verify-{migration-lineage,mobile-auth-build,public-assets,xometry-stable-egress}*`, `scripts/xometry-stable-egress-contract*`, `scripts/window2-packet*`, `**/WORKFLOW.md`, `scripts/symphony*{,/**}`, `scripts/vite-*`, `**/GEMINI.md`, `**/.codex/config*`, `**/.codex/hooks*{,/**}`, `**/.claude/settings*`, `**/.claude/hooks/**`, `**/.claude/rules/**`, `**/.claude/launch.json`, `**/.mcp.json`, `**/{.husky,.githooks,.git-hooks}/**`, `scripts/{hooks,git-hooks,githooks}/**`, `**/{lefthook,.lefthook}*`, `**/.pre-commit-config.yaml`, `scripts/qa-handoff/**`, `scripts/check-secret-paths*`, `scripts/verify-result-judge*{,/**}`, `scripts/qualify-ovd417-*`, `scripts/verify-ovd417-*`, `scripts/prepare-ovd373-schema-restore*`, `scripts/compare-ovd372-app-schema*`, `scripts/vendor-pr-serialization*`, `.github/workflows/vendor-pr-serialization.yml`, `**/.gitleaks.toml`, `**/.gitleaksignore`, `scripts/test-support/source-only-network-marker*`, `scripts/test-support/source-only-network.cjs`, `docs/agent-graph/**`, `scripts/validate-agent-graph*`
- **deps** (new dependencies): `**/package.json`, `**/{package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml,bun.lockb,deno.lock}`, `**/requirements*.txt`, `**/{pyproject.toml,uv.lock,poetry.lock}`, `**/{Cargo.toml,Cargo.lock,go.mod,go.sum}`, `**/{bun.lock,Pipfile,Pipfile.lock,Gemfile,Gemfile.lock}`, `supabase/functions/deno.json`
<!-- sensitive-paths:end -->

## Ownership and durable state

Repository state and the controller's durable run store are authoritative. Plans, chat, Linear comments, heartbeats, and Markdown status pages are projections.

- One writer owns each mutable target; read-only reviewers may run in parallel.
- Record the owner task, host, worktree, branch, source revision, completion condition, allowed actions, verification, budget, and failure family for nontrivial units.
- Use the guarded launcher/assignment protocol in `docs/agent-development-control-plane.md` before controlled dispatch; launch prerequisites only with evidence-bound dependency relevance. Reuse valid terminal results and equivalent review results.
- Only the controller changes scheduling state. A governor observes liveness and protected boundaries.
- Transfer ownership only at a durable checkpoint. Preserve unique commits, uncommitted work, live-process identity, and evidence.
- Never infer that a disconnected host stopped a process. Destructive cleanup remains protected.

## Issue and PR ownership

- Give each implementation issue one bounded, independently testable change and normally one main PR. Before implementation, confirm the change can meet source acceptance criteria; merging cannot complete issues with post-merge criteria remaining.
- Put a separate, independently mergeable change or distinct acceptance criteria in a child issue before opening its PR. A direct review or CI repair of the same change stays on its PR. After merge, a narrow follow-up PR may reuse the issue only to repair its original acceptance criteria; record why in both.
- Release-outcome parents coordinate qualification/live gates; never use their IDs for source-change PRs. Name the bounded child issue on new source PRs; preserve historical links.
- Aim for PRs of about 200 changed lines or fewer, excluding generated files, fixtures and lockfiles. Split larger work into stacked or sequential PRs, each independently reviewable and revertible. Feature-flag risky or user-visible behavior (default off) for early merge, activation or rollback without a revert. A PR over the guideline states why it cannot be split.
- At final PR head, inspect Sonar issues, actual bot-review coverage and threads. Green quality gates, rate-limit notices, or stale reviews aren't evidence of no actionable findings; record the gap and disposition.

## Complexity and verification

Use complexity to choose decomposition and evidence, not permission. Split independently testable High-complexity work; if indivisible and within standing authorization, continue with independent Astra xhigh review required before integration.

- Prefer the smallest change achieving the requested outcome without silent narrowing.
- Plan verification from the observable failures in [TEST_STRATEGY.md](TEST_STRATEGY.md#verification-planning); use its layered coverage and test-retirement criteria. Run targeted checks first; run the repo integration gate at the PR boundary.
- Material UI behavior needs real browser evidence. Database changes need migration, access-control, concurrency, and rollback verification. Native/CAD claims need real native evidence.
- Bind acceptance to the exact source revision, check definition, fixture/toolchain identity, owner, and timestamp.
- Never convert skipped, timed-out, filtered, blocked, or stale checks into passes.

Independent review is required for cross-cutting architecture, security-sensitive boundaries, disputed evidence, repeated failure, and protected-operation packets. Review confidence never replaces deterministic checks.

## Preflight, repair budget, and review sizing

Run `npm run preflight` (`scripts/preflight.sh`: lint, typecheck, unit tests) before opening or updating a PR. CI calls the same script for those stages, so a local pass predicts the hosted result. Paste its stage lines into the PR.

- Triage: before any LLM, ovd-auto-triage asks jev (pinned jev-1.13.0, via scripts/jev-client.mjs) for route/tier; jev may only raise tiers; errors/low confidence require the conservative tier.
- Pools: heavy builds rotate across Codex, Claude Code and Cursor cloud agents by availability and budget; the dispatcher logs which pool it chose and why.
- One writer per PR owns every repair. Budget: 2 repair rounds across local and CI combined, each with all current failure logs at once, never check by check.
- Separate infra failures (install, network, runner loss, timeouts before a stage starts) from code failures (a `preflight: <stage> FAIL` line or a failing hosted check). Rerun infra failures without using repair rounds; never "fix" them in code.
- After the budget, failing PRs become drafts with diagnostics comments: failing checks, log excerpts, each round's changes, and suspected cause. Do not weaken tests or checks to pass.
- Review is sized by risk. Reviewer routing is owned by [model-routing.v2.yaml](scripts/fixtures/agent-graph/model-routing.v2.yaml) and enforced by [built-by.mjs](scripts/agent-graph/built-by.mjs); see [agent-pr-tags.md](docs/agent-pr-tags.md). The draft graph's reviewer section is non-authoritative until it models builder-family routing. A PR that touches provider/customer data also gets Opus review, whatever the Jev score. Sizing never replaces deterministic checks. `docs/agent-graph/model-routing.yaml` is the source of truth for the Linear model labels (`model:opus` for Opus, `model:sonnet` for Sonnet, `model:codex`, `model:grok-overflow`) and the provider and model each one routes to.
- Track cost per accepted PR and founder interventions as in [docs/agent-graph-metrics.md](docs/agent-graph-metrics.md).

## Merge gate

[The graph](docs/agent-graph/graph.v1.yaml) owns the merge gate, verdict types and landing rules. Reviewer routing keeps the above authoritative owners and draft-graph limitation. This file owns approvals, auto-merge allowlist and sensitive paths. Gate loosening needs root agent countersign and Blaine's OK.

## Completion and failure

Completion requires requested behavior, passing acceptance criteria and required current-revision verification, recorded artifacts, and no required action remaining. A draft, commit, PR, narrow test, or agent declaration alone is not completion.

At each checkpoint produce a durable artifact, verified state change, causal blocker, or bounded wait tied to a live handle. After 2 checkpoints without durable progress or 3 materially similar failures, stop only that unit; replan with stronger reasoning or independent review. Preserve accepted siblings.

Stop immediately for ownership collision, uncertain destructive target, possible secret exposure, unauthorized production/provider/customer scope, or evidence that the requested approach cannot satisfy product intent.

## Routing

Use a skill only when it materially improves the task:

- `linear-issue-creator`: implementation-ready Linear decomposition;
- `overdrafter-verification`: explicit acceptance or release claims;
- `verify-overdrafter` (`.agents/skills/verify-overdrafter/`): drive the real app to prove auth, quote and provider journeys;
- `overnight-run`: sustained unattended work;
- `agent-skill-eval`: consequential workflow changes.

Keep tool adapters thin and load conditional procedures only when relevant. Astra medium: routine orchestration; high: difficult architecture/causal recovery; xhigh: independent high-impact review. The dispatcher selects actual model and effort.

Keep provider work behind `docs/provider-integration.md`, database releases behind the applicable runbook, and CAD work behind the engineering control-plane and native qualification documents. Product runtime retry rules do not automatically limit disposable development-test retries.

## Agent graph

[The draft graph](docs/agent-graph/graph.v1.yaml) defines agent routing, except reviewer routing, whose authoritative sources are above. This file keeps the rules; the spec holds the structure.
