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

Use the standing fixture lane in `AGENTS.md`. The lane is limited to local Docker with cached pinned images, repository schema artifacts, synthetic records, and fixture-generated ephemeral credentials. Each fixture uses an exclusive internal network and may publish only on explicit IPv4 or IPv6 loopback addresses. No external egress, host networking, privileged container, Docker-socket mount, sensitive host mount, or persistent volume is allowed.

The initial ceiling is two containers, one network, recorded CPU/memory/PID/tmpfs limits, a 30-minute runner limit, and a 60-minute unit budget. Record created resource IDs and reject ownership collisions. Cleanup may touch only resources created by that fixture.

A maintained fixture runner owns admission, resource caps, platform bootstrap, database and HTTP readiness, application checks, diagnostics, and cleanup. A corrective rerun requires a failure classification, a relevant change, and successful ownership and cleanup checks. Corrective runs retain the same failure family; renaming a packet does not reset the attempt count. Whole-platform byte equality may support provenance, but application behavior, schema/catalog invariants, grants, RLS, and transport readiness remain separate claims.

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

## Maintained launch boundary

The repository owns `scripts/agent-control/run_store.py`, imported without a data-format change from the maintained Mac Mini overnight-run helper. Its existing schema-2 snapshots, revisions and CLI remain compatible; focused validation helpers preserve the original error ordering and transition behavior. `launch.py` extends that store using decision and event records; it does not create a second scheduler. Historical stores and paused automations are not migrated or started automatically.

`WORKFLOW.md` starts `scripts/symphony-agent.sh`, which invokes the controller's maintained absolute launcher path. The sole scheduler supplies:

- `OVD_AGENT_RUN_STORE`: one canonical store shared by this project's dispatches;
- `OVD_AGENT_ASSIGNMENT_DIR`: controller-authored `<issue-id>.json` manifests;
- `OVD_AGENT_LAUNCHER`: absolute path to the maintained `scripts/agent-control/launch.py`.

Missing metadata fails before Codex starts. The Symphony adapter selects Astra medium for routine issue work and pins default instruction filenames and a 32 KiB discovery ceiling for this process only. The guard resolves the actual global and checkout `AGENTS.override.md`/`AGENTS.md` chain, skips empty files, checks its fingerprints and rejects truncation. Extra invoked skills must remain in the manifest. This follows [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md). The adapter binds the issue ID and final workspace to the manifest, after branch preparation. Do not point a project at multiple stores: the ownership lock is shared by callers of the same canonical store, not a distributed lock across unrelated copies. An inaccessible host/store is unknown, never grounds for replacement dispatch.

The launcher controls process starts routed through it. It does **not** intercept desktop task creation/messages, app-owned goal continuations, or individual tool calls inside an admitted app-server. Repository code cannot change the desktop application's instruction injection. Direct desktop controllers must reconcile through the same assignment/result protocol before scheduling; this is an instruction-level obligation, not claimed programmatic interception. Existing tasks and paused background automations are not redirected by this change.

## Assignment protocol

Use the existing store's `init`, `add`, and `transition` commands to register bounded units. Then use:

```sh
python3 scripts/agent-control/launch.py policy --run "$store" --file policy.json
python3 scripts/agent-control/launch.py plan --run "$store" --assignment parent.json
python3 scripts/agent-control/launch.py launch --run "$store" --assignment assignment.json -- codex app-server
python3 scripts/agent-control/launch.py reconcile --run "$store" --assignment reconciled.json
python3 scripts/agent-control/launch.py finish --run "$store" --unit UNIT --result result.json
python3 scripts/agent-control/launch.py metrics --run "$store"
```

The `plan` command records proposed scope, not admitted dependency edges. It is required before a prerequisite referenced by another unit may start. A ready unit is atomically claimed as running before the launcher invokes a child. A second launch cannot replay that claim, even after a crash or failed observation. Resolve the live process and record a causal outcome before a new attempt. After admission, the launcher replaces itself with the child so the supervising scheduler retains the correct process ID and signal target. Child exit code zero is not verification.

Policy JSON records `revision`, `user_decision_revision`, nonempty `instructions` and `user_decisions` artifact lists. Every artifact has an absolute `path` and SHA-256 `sha256`. Preserve the actual user decision text and its source/task identity; never invent authorization from agent narration. A new decision or policy content needs a new revision. Required instruction files include the applicable global, repository, directory overrides and invoked adapters; their current bytes are checked. Record the manifest actually supplied by the launching harness in `loaded_instructions`. A caller's manifest proves checked files, not otherwise unobservable desktop context. If the loaded context is stale or unknown, reconcile it once and carry the current explicit user decision forward without resetting ownership or completed work.

An assignment contains:

- `unit_id`, `expected_revision`, stable `assignment_key`, `kind` (`implementation`, `review`, or `release`), and `issue_id` for Symphony;
- exact `owner_thread`, `host`, absolute `worktree`, input `source_revision` (Git HEAD), `policy_revision`, and `user_decision_revision`;
- `loaded_instructions`, `inputs` (artifact references, with meaningful roles), and nonempty `requirements` (artifact references with unique `id`);
- `dependencies`, exactly matching the unit's `depends_on` IDs; `review_scope` for review assignments; and `check_identity` for the required check definition;
- `actions`, limited to `source`, `test`, `review`, `tracker`, and `routine-build`.

`reconcile` updates only the active binding's policy revision, user-decision revision and instruction manifest, with an expected unit revision. It preserves owner, source inputs, acceptance scope, actions, live state and result history; it never starts another child. This permits a current direct user decision to cross a handoff without abandoning work. Scope/source changes require their own qualified unit.

The controller must list required schemas/contracts as inputs before implementation dispatch; the launcher cannot infer omitted requirements from prose. The manifest is controller-authored trusted scheduling data, not an authorization token supplied by a worker. Filesystem validation runs with that local controller's existing OS permissions and returns errors only to it; this CLI is not exposed as a remote path-inspection service. Worktree paths must be existing absolute directories and are resolved canonically to reject symlink ownership aliases. Fixed Git argument lists use the validated checkout as the process working directory. Protected operations remain subject to `AGENTS.md`; the launcher is not an OS security sandbox.

Commit tracked source changes before dispatch or acceptance. A result records `source_revision` at the verified output HEAD, `input_source_revision` when output differs from the admitted input HEAD, matching `check_identity`, an independent `verifier`, and nonempty hashed `artifacts`. `finish` requires the output commit to descend from the admitted input, binds that source chain and records completion in the existing store. That ancestry check occurs at acceptance on the owning checkout; later receipt consumption does not require the original host path to remain available. Valid terminal results are consumed without a child; an equivalent requesting unit receives a completed result with original verifier/provenance so its dependents can advance. Missing or changed artifacts are rejected, including prerequisite results when a parent starts. Materially new work uses a new bounded unit. Equivalent reviews are identified by source, concrete input/acceptance artifacts, scope and check definition, independent of renamed assignment or attempt labels.

## Evidence-bound dependency admission

A discovered defect becomes a prerequisite only after a bounded independent review proves its connection to the parent's named acceptance requirement. Record unrelated findings separately; a real defect is not automatically a release blocker. Neither a nonempty rationale nor a passing unrelated test proves relevance.

Each dependency names `unit_id`, `requirement_id`, and `evidence`: current hashed source/runtime evidence plus the exact acceptance artifact, with `kind` identifying each. Its `review` contains the completed guarded review `unit_id` and the accepted review receipt's `path` and `sha256`. The review must have been dispatched separately with scope `dependency:<parent-assignment-key>:<dependency-unit-id>`.

The receipt binds `parent_assignment_key`, `dependency` (`unit_id`, `deliverable`, input `head_sha`), parent `source_revision`, `requirement_id`, exact `evidence_sha256`, reviewer identity, `verdict` (`required` or `unrelated`), and a concrete causal `rationale`. Normal lifecycle revision changes do not change the dependency's scope. The reviewer must be a different owner from the parent implementer. The receipt must be an artifact in that review's accepted result. The launcher checks provenance and bindings; the independent reviewer owns the semantic judgment about the actual call path, runtime failure or acceptance violation.

Before launching a referenced prerequisite, the launcher checks its parent's proposal and relevance receipt. Before launching the parent, it additionally requires successful prerequisite completion. This order prevents executing an unsupported archive redesign merely because it was listed as a worker-release dependency. Keep the semantic review bounded to that causal question, not a recursive whole-project architecture review.

## Lifecycle projections and measurements

Keep one rolling Linear comment for a Linear-backed unit. Update it at start, material scope/blocker changes, validated PR readiness, merge and verified completion. Its Plan, Acceptance Criteria and Validation remain checklists; Artifacts and Complexity Report explain current evidence and risk. Complexity alone creates no new permission requirement under `AGENTS.md`; high-impact changes require its independent review.

Use `In Progress` while admitted work is active, `Blocked` for a causal blocker, `Backlog` for deferred work, `Human Review` only when current required verification and PR evidence are complete, and `Merging` when landing is authorized (including applicable standing authorization). Use `Done` only after verified acceptance, including any post-merge requirement. A release parent stays active until its release evidence is complete; source PR merges do not close it.

The `metrics` command derives guarded launches, unsupported dependency rejections, duplicate dispatch rejections, completed-result reuse, attempted reopening and elapsed time from launch to verified artifact from existing events. Its coverage explicitly excludes historical and direct desktop dispatch that produced no guarded events. Do not report missing history as zero failures, infer time saved, or create a dashboard to collect these measures.

Run `npm run test:agent-control-plane` for both the existing store suite and subprocess launch regressions. Cases include missing receipt schema, stale/conflicting policy, unsupported archive dependency before child dispatch, genuine release blocker, superseded recovery, completed JARVIS result, renamed equivalent review, concurrent ownership, changed source/input continuation and the actual Symphony shell entrypoint. Temporary fixtures contain no customer data and launch only a marker-writing fake child.
