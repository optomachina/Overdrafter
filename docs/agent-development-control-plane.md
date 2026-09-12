# Agent development control plane

This document defines how OverDrafter development work is resumed, dispatched, verified, and projected across Codex tasks and machines. It is separate from the product's engineering/CAD control plane.

## Design

One project controller owns scheduling state. A task graph records units and dependencies. Worker harnesses create bounded contexts and environments. Workers implement one unit. An integrator owns the target branch and PR. Deterministic checks and risk-based independent review accept or reject artifacts. A governor observes liveness and protected boundaries but never becomes a second scheduler.

The durable run store is authoritative. Chat plans, task summaries, Linear comments, heartbeats, and Markdown status pages are generated or reconciled projections.

## Unit contract

Each unit records:

- stable ID, revision, track, and failure family;
- outcome and falsifiable done predicate;
- dependencies and current eligibility;
- mutable targets and sole owner task;
- host, worktree, branch, and source revision;
- permitted and protected actions;
- time/resource budget and attempt count;
- required verification and evidence identities;
- state, blocker, supersession, and return path.

The controller rejects stale expected revisions, cycles, unsatisfied dependencies, active target collisions, invalid owner transfers, acceptance against an old source identity, and retries beyond the failure-family limit.

## State flow

`planned -> ready -> running -> verifying -> passed -> complete`

`blocked`, `failed`, and `abandoned` are explicit alternate states. `passed` means the unit's artifact was accepted but a dependent integration unit remains. `complete` means the promised outcome is delivered.

A worker exit is not success. A successful unit has an inspectable artifact or a causal blocker receipt. A bounded wait names a currently live process, CI job, or tool handle.

## Ownership and hosts

One task writes each mutable target. Record `(owner task, host, worktree, branch, source revision)` as one identity. Use one normal development host; route Windows/native work to the workstation only when required. A host disconnect becomes `unknown` until authoritative process evidence resolves it. Never replay a potentially side-effecting unit solely because observation timed out.

Ownership transfer requires a checkpoint containing current Git state, unique commits, uncommitted work, live processes, evidence paths, unresolved gates, and the next bounded unit. The prior owner becomes read-only after acknowledgement.

## Verification and evidence

Run the smallest deterministic check that can reject the unit, then broaden at the integration boundary. Receipts bind:

- source revision and relevant diff;
- test/check definition and command identity;
- fixture, dependency, and toolchain versions;
- owner, verifier, timestamp, and result;
- artifact paths and cleanup evidence where applicable.

Acceptance is invalidated when those identities change. Preserve failures and superseded verdicts as history.

## Synthetic development fixtures

Use the standing fixture lane in `AGENTS.md`. A maintained fixture runner owns admission, resource caps, platform bootstrap, database and HTTP readiness, application checks, diagnostics, and cleanup. Corrective runs retain the same failure family. Whole-platform byte equality may support provenance, but application behavior, schema/catalog invariants, grants, RLS, and transport readiness remain separate claims.

## Progress and retry policy

At each checkpoint require one of: durable source change, newly verified artifact, causal evidence changing the next action, or a bounded live wait. Two checkpoints without durable progress trigger a replan. Three materially similar failures stop the unit and require an independent causal review. A materially revised unit may return through the controller; accepted siblings remain accepted.

Reasoning escalation does not create action authority. Use the model routing in `AGENTS.md`, selecting model and effort in the actual dispatch.

## Projections

Render `status.md` and heartbeat summaries from the run store. Update Linear at start, material blocker/scope changes, PR readiness, merge, and completion. Automation prompts name the store location and current owners but do not embed current stage or attempt facts. On restart, reconcile Git, task, and live-process identity before dispatch.

## Workflow evaluation

Evaluate control-plane changes on realistic disposable cases:

1. a synthetic fixture fails, is relevantly corrected, and reruns without human approval;
2. three equivalent failures with renamed packets trigger one replan;
3. a High-complexity routine code change receives decomposition analysis and independent review without an approval stop;
4. a production/provider/customer-data action stops before mutation;
5. an owner/worktree collision is rejected;
6. a restarted controller resumes accepted work without duplicate dispatch.

Compare equivalent models, permissions, tasks, and budgets. Inspect artifacts rather than agent narration. Track completion quality, elapsed time, tokens/cost, human interruptions, retries, and escaped defects across multiple trials before promoting a material workflow change.

## Worktree hygiene

Maintain an inventory of registered worktrees, current owners, Git status, unique commits, referenced evidence, and prunable metadata with `node scripts/inventory-worktrees.mjs --metadata <owner-evidence-map.json>`. An omitted owner is reported as unknown, never inferred. Cleanup is a separate protected operation. Never remove a worktree merely because Git labels it prunable.

## Delivery sequence

1. Keep the compact rule chain internally consistent.
2. Make the run store reject semantic contradictions and generate projections.
3. Reconcile current 1.0/JARVIS ownership and state.
4. Promote the JARVIS bootstrap into a maintained fixture runner.
5. Run workflow evals and compare the simplified contract to the prior baseline.
6. Standardize host identity and retire inactive adapters only after verifying whether they run.
