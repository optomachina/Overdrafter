# OverDrafter Repository Hardening Plan

Last updated: March 13, 2026

> Status: Archived transitional planning checklist. This file is retained as source material for the hardening effort.
>
> `PLAN.md` is the active execution plan. The root canonical docs replace this file as the source of truth for current repository guidance.

## Purpose

This document is the broad execution checklist for making the OverDrafter repository easier to operate, safer to modify, and much more reliable for both human contributors and AI coding agents. It is intentionally comprehensive. It should be treated as a temporary working checklist and later folded into canonical repo documentation and issue tracking.

## Why this exists

The repository already has real product depth, but the control plane around the codebase is weaker than it should be. Product intent exists in multiple places. Agent instructions are partial. CI is present but likely not yet authoritative. Tooling signals are mixed. The repo needs a stronger spine so future work does not depend on re-explaining the same rules every session.

This plan is about turning the repo into an AI-native engineering environment where:
- the source of truth is explicit
- instructions live in the repository instead of in giant prompts
- verification is standardized
- work can be sliced cleanly into backlog items
- PRs, tests, and CI reflect the actual quality bar

## Success criteria

This effort is successful when:
- canonical root docs exist and are linked
- `AGENTS.md` can guide work without a giant custom prompt
- one package manager is authoritative
- local verification is clear and repeatable
- CI is stronger and more representative
- PR structure is standardized
- test expectations are explicit
- nontrivial work is expected to happen in isolated branches or worktrees
- repo workflow guidance is stable enough to support repeated Codex use

## Workstream 1 — Canonical root documents

### Goals
Create the permanent top-level documents that define product intent, active execution sequencing, architecture boundaries, test expectations, and completion criteria for the current hardening phase.

### Tasks
- [ ] Create `/PRD.md` at repo root using `docs/reconstruction-prd.md` as source material.
- [ ] Convert the reconstruction document from a reverse-engineered artifact into a canonical product document.
- [ ] Create `/PLAN.md` as the active execution plan for the current hardening phase.
- [ ] Create `/ARCHITECTURE.md` describing subsystem boundaries and protected seams.
- [ ] Create `/TEST_STRATEGY.md` defining local, CI, and agent-driven verification expectations.
- [ ] Create `/ACCEPTANCE_CRITERIA.md` that defines when the hardening phase is actually done.
- [ ] Update `README.md` with a short repo map that points to the canonical docs.
- [ ] Mark older planning and reconstruction docs as source material, archived, or superseded where appropriate.

### Done when
- Root docs exist.
- They do not materially conflict with one another.
- The repo clearly indicates which docs are canonical.
- A new contributor or agent can find the source of truth immediately.

## Workstream 2 — Expand `AGENTS.md` into a real operating manual

### Goals
Turn `AGENTS.md` from a narrow instruction surface into a full operating guide for contributors and agents.

### Tasks
- [ ] Add a source-of-truth hierarchy: `PRD.md` > `PLAN.md` > specialized docs > `README`.
- [ ] Add required verification commands.
- [ ] Add package manager policy.
- [ ] Add branch and worktree policy.
- [ ] Add test-first expectations for nontrivial bug fixes and feature work.
- [ ] Add migration policy for schema or data-boundary changes.
- [ ] Add doc update expectations when behavior changes.
- [ ] Add protected/generated path guidance.
- [ ] Identify sensitive or specialized folders that need nested `AGENTS.override.md`.
- [ ] Add directory-level override files only where they provide real clarity.

### Candidate directories for overrides
- `/supabase`
- `/worker`
- `/src/features/...`
- any quoting or sourcing-specific area with unique rules

### Done when
- An agent can work effectively from repo instructions alone.
- Specialized areas have local rules where needed.
- The repo no longer depends on repeated chat-level instruction dumping.

## Workstream 3 — Tooling and package standardization

### Goals
Remove ambiguity that causes human and agent confusion.

### Tasks
- [ ] Choose one package manager and make it authoritative.
- [ ] Remove the unused lockfile.
- [ ] Rename the package from `vite_react_shadcn_ts` to `overdrafter`.
- [ ] Remove committed generated artifacts that do not belong in git.
- [ ] Standardize scripts:
  - [ ] `lint`
  - [ ] `typecheck`
  - [ ] `test`
  - [ ] `build`
  - [ ] `verify`
- [ ] Ensure the `verify` command is the normal local gate for nontrivial changes.

### Done when
- Package manager choice is unambiguous.
- Script names are obvious and consistent.
- Generated junk is not part of the normal repo state.
- “What should I run before opening a PR?” has one answer.

## Workstream 4 — CI hardening

### Goals
Make CI reflect the actual repository quality bar.

### Tasks
- [ ] Expand CI beyond minimal build/test behavior.
- [ ] Add lint to CI.
- [ ] Add typecheck to CI.
- [ ] Ensure tests run in CI in the intended way.
- [ ] Add a lightweight smoke path if practical.
- [ ] Add worker verification if the worker is active and independently meaningful.
- [ ] Add migration validation if schema changes are part of normal work.
- [ ] Align CI with the documented local verification path.

### Done when
- CI catches the main classes of preventable breakage.
- CI aligns with repo docs and local workflow.
- Passing CI actually means something substantial.

## Workstream 5 — Testing policy and enforcement

### Goals
Make test expectations explicit by change type.

### Tasks
- [ ] Define which kinds of changes require automated tests.
- [ ] Require bug fixes to add or update tests when practical.
- [ ] Require behavior-changing work to include test evidence or a reason it does not.
- [ ] Document fixture-mode or lightweight verification paths if they exist.
- [ ] Define when smoke or end-to-end checks are expected.
- [ ] Reflect these expectations in `TEST_STRATEGY.md`, `AGENTS.md`, and PR structure.

### Done when
- Contributors know when tests are mandatory.
- PRs cannot silently change behavior without evidence.
- There is less guesswork around how much validation is enough.

## Workstream 6 — PR, branch, and worktree discipline

### Goals
Standardize how changes are isolated, reviewed, and merged.

### Tasks
- [ ] Add a PR template.
- [ ] Require problem statement, scope, verification evidence, migration notes where relevant, and rollback/risk notes where relevant.
- [ ] Define branch naming conventions.
- [ ] Define when worktrees should be used.
- [ ] Set expectation that nontrivial changes happen in isolated branches or worktrees.
- [ ] Define local verification evidence to include in PRs.
- [ ] Require doc updates to be called out when behavior changes.

### Done when
- PR structure is consistent.
- Reviewers see the same categories of information every time.
- Work isolation is the default for meaningful changes.

## Workstream 7 — Codex skills and workflow guidance

### Goals
Move repeatable repo motions out of giant prompts and into reusable assets.

### Tasks
- [ ] Define an initial set of repo skills for repeated work.
- [ ] Candidate skills:
  - [ ] feature planning
  - [ ] UI regression verification
  - [ ] migration review
  - [ ] PR-ready summary generation
  - [ ] repo verification before handoff
- [ ] Document the preferred Codex workflow for this repo:
  - [ ] when to use plan mode
  - [ ] when to use worktrees
  - [ ] what must be verified before a task is complete
- [ ] Keep durable instructions in the repo rather than in ad hoc prompts.

### Done when
- Repeated setup and explanation burden is lower.
- Agent sessions start from repo context instead of rebuilding operating assumptions each time.

## Workstream 8 — Future-track configuration and MCP follow-up

### Goals
Track higher-order workflow improvements without blocking repository hardening.

### Tasks
- [ ] Document recommended Codex profiles.
- [ ] Document recommended split between global `~/.codex/AGENTS.md` and repo-local `AGENTS.md`.
- [ ] Evaluate GitHub MCP usage.
- [ ] Evaluate OpenAI Docs MCP usage.
- [ ] Evaluate Supabase MCP usage.
- [ ] Define when each should be adopted.
- [ ] Keep these as lower-priority backlog items until repo fundamentals are stable.

### Done when
- The follow-up path is clear.
- Optional platform improvements are tracked without distracting from repo hardening.

## Execution order

1. Canonical root docs
2. `AGENTS.md` expansion
3. Package/tooling cleanup
4. Verification scripts and CI hardening
5. Testing and PR discipline
6. Codex skills and workflow guidance
7. Config and MCP follow-up

## Risks

### Documentation drift
If old docs are left unlabeled, contributors and agents may not know what is authoritative.

### Tooling ambiguity
Mixed package managers, inconsistent scripts, or committed generated artifacts create friction and false failures.

### Weak CI
If CI does not reflect the intended quality bar, passing checks become misleading.

### Prompt dependence
If instructions remain primarily in chat instead of in the repo, every session pays setup tax.

### Over-scoping
It is easy to blur repo-hardening work into broad product redesign. Avoid that in this phase.

## Out of scope for this phase

- major product-surface redesign
- new pricing models
- billing implementation
- procurement workflow expansion
- large vendor-integration expansion
- native app work
- speculative architecture rewrites without a concrete operational need

## Maintenance rule

Update this plan whenever:
- milestone sequencing changes
- scope is added or removed
- a major workstream completes
- canonical repo guidance changes materially
