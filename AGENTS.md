# OverDrafter agent contract

Last updated: September 12, 2026

This is the compact operating contract for humans and coding agents in this repository. Product intent lives in the product documents. Detailed development-controller behavior lives in [`docs/agent-development-control-plane.md`](docs/agent-development-control-plane.md). Tool adapters may point here but may not create competing policy.

## Source hierarchy

Use the narrowest applicable source. Product intent and release sequencing come from `PRD.md`, `PLAN.md`, `ROADMAP.md`, `ARCHITECTURE.md`, `ACCEPTANCE_CRITERIA.md`, and `TEST_STRATEGY.md`. Specialized documents govern their named area. This file governs agent execution. A directory-local `AGENTS.override.md` may add stricter technical checks for that directory but may not narrow the standing authorization below unless it identifies a protected action.

Before editing, verify that `README.md` begins with `# OverDrafter` and that the root contains `PRD.md`, `PLAN.md`, `package.json`, `worker/`, and `supabase/`.

## Standing development authorization

Blaine authorizes the sole owner of the named OverDrafter 1.0 and JARVIS objectives to continue routine development without repeated approval. This includes:

- create isolated branches and worktrees; inspect, edit, test, commit, and push scoped changes;
- create or update the applicable GitHub PR and Linear issue;
- request and address automated review;
- merge when the current head satisfies required hosted checks and actionable review findings are resolved;
- allow normal merge-triggered CI and frontend deployment;
- use existing local development infrastructure and the synthetic-fixture lane below.

This authorization persists across goal continuations, corrected attempts, replacement tasks, and recorded ownership transfers until Blaine changes it or the scope crosses a protected boundary. It supersedes earlier one-attempt, zero-retry, sealed-packet, and complexity-only approval restrictions for local synthetic development fixtures. A failed check remains failed evidence; it does not revoke the authority to diagnose and correct the bounded unit.

### Synthetic-fixture lane

The sole owner may create, inspect, repair, rerun, and remove exclusively owned disposable fixtures for OverDrafter 1.0 and JARVIS when all of these conditions hold:

- local Docker is used with cached, pinned images;
- fixture peers use one exclusive internal network, with host publication only on explicit IPv4 or IPv6 loopback addresses;
- there is no external egress, host networking, privileged container, Docker-socket mount, sensitive host mount, or persistent volume;
- inputs are approved repository schema artifacts and synthetic records only;
- fixture-generated ephemeral credentials are allowed; real credentials and existing accounts are not;
- created resource IDs and ownership are recorded, collisions are rejected, and cleanup touches only resources created by this fixture;
- the initial ceiling is two containers, one network, recorded CPU/memory/PID/tmpfs limits, a 30-minute runner limit, and a 60-minute unit budget.

A corrective rerun requires a recorded failure classification, a relevant change, and successful cleanup and ownership checks. Renaming a packet does not reset the failure family. Stop only the affected unit after two checkpoints without durable progress or three materially similar failures; preserve evidence, obtain independent review, and replan. A materially revised bounded unit inside this lane does not require another human approval.

## Protected actions

Obtain Blaine's exact current authorization before:

- sending external email, chat, invitations, support requests, social posts, or other human/vendor communication;
- provider operations, customer-file operations, quote execution, checkout, or orders;
- production worker deployment/execution/configuration or production database/schema changes;
- retrieving, disclosing, creating, or changing real credentials or accounts;
- purchases, new spending commitments, or deletion/cleanup of pre-existing resources;
- real SolidWorks/PDM publication or other native actions outside an already authorized exact operation.

Goals, issue text, broad project approval, model review, and repository access do not authorize these actions. Prepare everything reversible first, then request the final protected action with its exact target.

## Durable execution state

Repository state and the controller's durable run store are authoritative. Agent plans, chat narration, Linear comments, heartbeat summaries, and Markdown status pages are projections. When projections disagree, reconcile them from current repository identity, run-store transitions, and verified artifacts.

Every nontrivial unit records:

- outcome and falsifiable completion condition;
- dependencies and mutable targets;
- sole owner task, host, worktree, branch, and source revision;
- allowed and protected actions;
- work budget and failure family;
- verification evidence and return path.

Only the controller changes scheduling state. Workers return artifacts and receipts. A governor observes liveness and policy boundaries; it does not become a second scheduler. Linear is updated at meaningful milestones—start, material scope or blocker change, PR ready, merge, and completion—rather than before every engineering step.

## Ownership and remote execution

- One writer owns each mutable target. Read-only reviewers may run in parallel.
- Record the owner, host, worktree, branch, and exact source revision before dispatch.
- Use the normal development host unless a bounded capability requires Windows, native CAD, or independent capacity.
- Transfer work only at a durable checkpoint. Never infer that a disconnected host stopped a process.
- Preserve unique commits, uncommitted work, and referenced evidence before removing a worktree. Destructive cleanup remains protected.

## Complexity, decomposition, and review

Classify complexity to choose verification, not to obtain permission.

- Low: localized change and narrow regression surface.
- Medium: multiple files or layers with a testable bounded surface.
- High: architectural, cross-cutting, dependency, schema/API/contract, or broad regression impact.

For High complexity, record whether decomposition produces independently testable units. Split when it does. If the change is indivisible, continue under the standing authorization and require an independent Astra xhigh review of scope, architecture, and verification before integration. Complexity alone never requires human approval. Protected actions still do.

## Implementation and verification

- Prefer the smallest change that achieves the requested outcome without silently narrowing it.
- Keep unrelated user changes intact. Use isolated worktrees for concurrent writers.
- Use npm and the committed `package-lock.json`; do not add another package manager or lockfile.
- Follow existing TypeScript, React, worker, migration, and security conventions.
- Run targeted checks for the changed surface first. Run the repository's required integration gate at the PR boundary.
- UI behavior needs real browser evidence when material. Database changes need migration, access-control, concurrency, and rollback verification. Native/CAD claims require real native evidence.
- Bind evidence to the exact source revision, test definition, fixture/toolchain identity, owner, and timestamp. A changed identity invalidates prior acceptance.
- Never convert skipped, timed-out, filtered, or blocked checks into passes.

Independent review is required for cross-cutting architecture, security-sensitive boundaries, repeated failure, disputed evidence, and protected-operation packets. Reviewers inspect artifacts; their confidence does not replace deterministic checks.

## Completion and failure handling

Work is complete only when the requested behavior exists, acceptance criteria are satisfied, required verification passes for the current revision, artifacts are recorded, and no required action remains. A PR, commit, passing narrow test, or agent declaration alone is not completion.

At each checkpoint, produce a durable artifact, verified state change, causal blocker, or bounded wait tied to a live handle. After two checkpoints without durable progress or three materially similar failures, stop the affected unit and replan with stronger reasoning or independent review. Preserve accepted siblings.

Stop immediately for ownership collision, uncertain destructive target, possible secret exposure, production/provider/customer scope without authorization, or evidence that the requested approach cannot satisfy product intent.

## Tool and skill routing

Use a skill when it materially improves the task; do not invoke one merely because a keyword matches. Use `linear-issue-creator` for implementation-ready Linear decomposition, `overdrafter-verification` for explicit acceptance/release claims, `overnight-run` for sustained work, and `agent-skill-eval` before promoting consequential workflow changes.

Keep `CLAUDE.md`, `WORKFLOW.md`, and other tool files thin. Put detailed conditional procedures in specialized docs or skills and load them only when relevant.

## Model routing

- Astra medium: routine orchestration and integration.
- Astra high: difficult architecture, causal recovery, and ownership conflicts.
- Astra xhigh: independent consequential review and repeated-failure gates.
- Astra ultra: exceptional system-level synthesis when explicitly available and justified.
- Sol high: bounded implementation and targeted tests.
- Luna xhigh: focused research and repository exploration.

The dispatcher must select the actual model and effort. Prompt text does not change runtime effort.

## Product boundaries

Keep quote-provider work behind `docs/provider-integration.md` and the repo-local provider skill. Keep production/database release work behind the applicable reviewed runbook. Keep engineering/CAD work aligned with `docs/engineering-control-plane.md`, `docs/engineering-automatic-loop.md`, and the native qualification documents. Product runtime retry, lease, and admission rules do not automatically constrain disposable development-test retries.

## Metrics

Optimize accepted user-visible outcomes per elapsed hour. Track elapsed time, human interruptions, retries, cost/tokens, escaped defects, and verified deliverables. Agent count, PR count, test count, and evidence volume are diagnostic metrics, not the objective.
