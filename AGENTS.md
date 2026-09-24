# OverDrafter agent contract

This file governs agent execution. Product intent lives in the maintained product documents, and detailed controller mechanics live in [docs/agent-development-control-plane.md](docs/agent-development-control-plane.md). Tool adapters may point here but may not create competing policy.

## Read what the task needs

Use the narrowest applicable source:

- product scope and sequencing: `PRD.md`, `PLAN.md`, and `ROADMAP.md`;
- service boundaries: `ARCHITECTURE.md`;
- acceptance and verification: `ACCEPTANCE_CRITERIA.md` and `TEST_STRATEGY.md`;
- specialized behavior: the closest maintained domain document;
- directory-specific checks: the closest `AGENTS.override.md`.

Verify repository identity when selection is ambiguous or before a consequential mutation. Do not read the full documentation stack for routine localized work.

## Standing development authorization

Blaine authorizes the recorded sole owner of OverDrafter 1.0 and JARVIS work to continue reversible, scoped development without repeated approval. This includes inspection, isolated branches or worktrees, editing, local tests and fixtures, correction of relevant failures, commits, pushes, GitHub PR and Linear maintenance, automated review response, and merge after current-head hosted gates and actionable review findings pass.

The authorization survives goal continuation, corrected attempts, replacement tasks, and recorded ownership transfers within the named objectives. It supersedes earlier one-attempt, zero-retry, sealed-packet, and complexity-only approval stops for reversible development. A failed check remains evidence but does not revoke authority to diagnose and correct the bounded unit.

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

Prepare reversible work first and ask only at the protected boundary. Goals, issue text, model review, repository access, and broad project approval do not expand into these actions.

## Ownership and durable state

Repository state and the controller's durable run store are authoritative. Plans, chat narration, Linear comments, heartbeat summaries, and Markdown status pages are projections.

- One writer owns each mutable target; read-only reviewers may run in parallel.
- Record the owner task, host, worktree, branch, source revision, completion condition, allowed actions, verification, budget, and failure family for nontrivial units.
- Before controlled dispatch, use the maintained guarded launcher and assignment protocol in `docs/agent-development-control-plane.md`; a dependency must earn evidence-bound relevance before its prerequisite is launched. Reuse valid terminal results and equivalent review results.
- Only the controller changes scheduling state. A governor observes liveness and protected boundaries; it does not schedule work.
- Transfer ownership only at a durable checkpoint. Preserve unique commits, uncommitted work, live-process identity, and evidence.
- Never infer that a disconnected host stopped a process. Destructive cleanup remains protected.

## Issue and PR ownership

- Give each implementation issue one bounded, independently testable change and normally one main PR. Before implementation, confirm that the proposed change can satisfy that issue's source acceptance criteria; a merged PR does not complete an issue with remaining post-merge criteria.
- Put a separate, independently mergeable change or distinct acceptance criteria in a child issue before opening its PR. A direct review or CI repair of the same change stays on its PR. If that PR has already merged, a narrowly scoped follow-up PR may use the same issue only when it repairs that issue's original acceptance criteria; record the reason in the PR and issue.
- Use release-outcome parent issues to coordinate qualification and live gates, not as the issue ID for source-change PRs. Name the bounded child issue on each new source PR, while preserving historical links.
- At the final PR head, inspect the Sonar issue list and actual bot-review coverage and threads. A green quality gate, rate-limit notice, or stale review is not evidence that no actionable finding remains; record the gap and its disposition.

## Complexity and verification

Use complexity to choose decomposition and evidence, not permission. Split independently testable High-complexity work; when an indivisible High-complexity change remains within standing authorization, continue and require independent Astra xhigh review before integration.

- Prefer the smallest change that achieves the requested outcome without silently narrowing it.
- Run targeted checks first and the repository integration gate at the PR boundary.
- Material UI behavior needs real browser evidence. Database changes need migration, access-control, concurrency, and rollback verification. Native/CAD claims need real native evidence.
- Bind acceptance to the exact source revision, check definition, fixture/toolchain identity, owner, and timestamp.
- Never convert skipped, timed-out, filtered, blocked, or stale checks into passes.

Independent review is required for cross-cutting architecture, security-sensitive boundaries, disputed evidence, repeated failure, and protected-operation packets. Review confidence never replaces deterministic checks.

## Completion and failure

Work is complete only when the requested behavior exists, acceptance criteria and required current-revision verification pass, artifacts are recorded, and no required action remains. A draft, commit, PR, narrow test, or agent declaration alone is not completion.

At each checkpoint produce a durable artifact, verified state change, causal blocker, or bounded wait tied to a live handle. After two checkpoints without durable progress or three materially similar failures, stop only the affected unit and replan with stronger reasoning or independent review. Preserve accepted siblings.

Stop immediately for ownership collision, uncertain destructive target, possible secret exposure, unauthorized production/provider/customer scope, or evidence that the requested approach cannot satisfy product intent.

## Routing

Use a skill only when it materially improves the task:

- `linear-issue-creator`: implementation-ready Linear decomposition;
- `overdrafter-verification`: explicit acceptance or release claims;
- `overnight-run`: sustained unattended work;
- `agent-skill-eval`: consequential workflow changes.

Keep tool adapters thin and load conditional procedures only when relevant. Routine orchestration uses Astra medium; difficult architecture or causal recovery uses high; independent high-impact review uses xhigh. The dispatcher selects actual model and effort.

Keep provider work behind `docs/provider-integration.md`, database releases behind the applicable runbook, and CAD work behind the engineering control-plane and native qualification documents. Product runtime retry rules do not automatically constrain disposable development-test retries.
