# AGENTS.md

Last updated: March 26, 2026

## Purpose

This file is the canonical operating system for human contributors and coding agents working in the OverDrafter repository.
Its job is to define:
- how work is chosen
- how work is shaped
- how work is implemented
- how work is verified
- how work is handed off
- how parallel agents avoid colliding

Durable repo instructions belong here, not in repeated prompts.
If a rule should still be true next week, it belongs in this file or a local override file.

---

## Canonical instruction hierarchy

When instructions overlap, use this order:

1. `PRD.md`
2. `PLAN.md`
3. `ARCHITECTURE.md`
4. `TEST_STRATEGY.md`
5. `ACCEPTANCE_CRITERIA.md`
6. specialized docs for the specific area
7. `README.md`
8. local mirrored tool files such as `CLAUDE.md`, `.github/copilot-instructions.md`, or prompt files

Mirrored tool-specific instruction files may restate this file for compatibility, but they may not override it.

If documents conflict:
- do not guess
- prefer the higher-priority document
- flag or update the lower-priority document if it drifted

---

## Workspace identity check

Before doing issue work, confirm this is the actual OverDrafter repo.

Minimum fingerprints of the correct repo root:
- `README.md` starts with `# OverDrafter`
- root contains `PRD.md`, `PLAN.md`, `AGENTS.md`, and `package.json`
- root contains `worker/` and `supabase/`

If those fingerprints do not match, stop and fix workspace selection before changing code.

---

## Linear issue creation

Use the `linear-issue-creator` skill whenever the task involves any of the following:

- creating Linear issues
- decomposing product discussions into backlog items
- turning roadmap / PRD / architecture docs into implementation cards
- generating epics, features, or child issues for Symphony / OverDrafter
- updating backlog planning artifacts to match new issue decomposition

Default behavior:

- Treat the repository as the source of truth first.
- Read relevant planning docs before drafting issues:
  - `README.md`
  - `PRD.md`
  - `PLAN.md`
  - `ARCHITECTURE.md`
  - `ACCEPTANCE_CRITERIA.md`
  - `TEST_STRATEGY.md`
  - `roadmap.md`
  - `horizon1-6.md`
  - `capabilitymap.md`
- Preserve product intent from repo docs and conversation context.
- Prefer a small number of high-signal issues instead of vague tickets.
- Every issue must contain implementation-ready acceptance criteria.
- If Linear CLI or tooling exists locally, use it.
- Otherwise emit markdown drafts that can be pasted into Linear.

---

## Core operating principles

- Preserve product intent.
- Do not silently change requirements.
- Prefer the smallest safe change.
- One problem per branch or worktree whenever practical.
- One writer per file at a time.
- Do not make drive-by fixes unrelated to the task.
- Do not claim completion based only on a successful build.
- Do not rely on prior chat memory when the repo should contain the instruction.
- When behavior changes, update the docs that describe the behavior.
- If recurring guidance is needed, update this file or the nearest override file.

---

## Tooling posture

Use tools by role, not by novelty.
- Use repo-aware coding agents for implementation, review, and PR cleanup.
- Use planning-oriented agents for decomposition, architecture synthesis, and requirements shaping.
- Use orchestration tools only for bounded delegation, not for duplicate integration.
- Keep one canonical integrator for any given task.
- Do not let multiple tools produce competing final patches for the same scope.

Canonical rule:
- one planner
- one integrator
- many bounded helpers if needed
- one reconciliation pass

---

## Work modes

### 1. Planning mode

Use for:
- new features
- backlog decomposition
- ambiguous implementation work
- architecture-impacting changes

Required outputs:
- problem statement
- constraints
- acceptance criteria
- affected areas
- risks
- smallest viable implementation slice

If the task involves Linear issue creation or backlog shaping, use the repo's issue workflow conventions and available tooling.

### 2. Analysis mode

Before changing code:
- read the relevant source-of-truth docs
- inspect the local area to be changed
- identify touched boundaries
- identify likely tests
- identify migration, auth, billing, ingestion, and quote-path risk if relevant

Do not start implementing until the likely blast radius is understood.

### 3. Implementation mode

Implement in a focused way:
- touch the minimum number of files needed
- preserve existing UX and layout contracts unless the task explicitly changes them
- avoid opportunistic refactors
- avoid unrelated renames, moves, or formatting churn
- do not add dependencies without a task-linked reason

### 4. Review mode

Review order:
1. security, auth, privacy, data loss
2. broken contracts, schema drift, migration risk
3. validation gaps on external input
4. async workflow and quote-path risk
5. test coverage gaps on changed critical paths
6. undocumented behavior changes
7. maintainability and clarity

Prefer minimal, localized fixes over broad rewrites.

### 5. Handoff mode

Every nontrivial task must end with a concrete handoff including:
- what changed
- why it changed
- files changed
- tests and verification run
- docs updated or why not
- known risks
- follow-ups if any

---

## Required output contract for nontrivial tasks

Before implementation starts, restate:
- issue or task ID if available
- acceptance criteria
- intended scope
- excluded scope

At completion, provide:
- implementation summary
- verification evidence
- docs impact
- migration impact if any
- rollback considerations if any
- known risks or follow-ups

No vague "done" claims.

---

## Parallel agent and subagent rules

Use delegation only for bounded work.

Allowed:
- isolated file discovery
- isolated test discovery
- isolated code review on a bounded diff
- isolated issue drafting
- isolated investigation of one subsystem

Not allowed:
- multiple agents editing the same file concurrently
- multiple agents independently integrating the same feature
- running a second integration layer after the main agent already integrated
- duplicate broad analysis passes without a specific unresolved ambiguity

Required subagent return format:
- goal
- files inspected or changed
- result
- open questions
- commit or patch reference if applicable

Integration rule:
- subagents may analyze or prepare
- one integrator owns the final patch
- reconcile once

---

## Branch and worktree policy

Use an isolated branch or worktree for:
- behavior changes
- schema or migration changes
- changes touching multiple files
- risky refactors
- concurrent efforts

Direct local edits are acceptable only for:
- trivial one-file fixes
- typo or copy changes
- clearly safe non-behavioral edits

Recommended naming:
- `feature/...`
- `fix/...`
- `refactor/...`
- `spike/...`
- `docs/...`

When a Linear issue exists, include the issue ID in branch names and PR titles.

Examples:
- `feature/OD-123-quote-comparison-empty-state`
- `fix/OD-241-worker-timeout-retry`
- `OD-123: improve quote comparison empty state`

---

## Blast-radius control

Before editing, set the intended blast radius.

Default rules:
- change only what is needed to satisfy acceptance criteria
- do not mix schema work into unrelated feature work
- do not mix cleanup into implementation unless the cleanup is required
- do not let lockfiles change unless dependencies truly changed
- do not edit generated artifacts directly unless the task explicitly requires it

If the diff grows beyond the original scope, stop and either split the work or restate the new scope explicitly.

---

## Package manager policy

- `npm` is the authoritative package manager for this repo
- use the committed `package-lock.json` files at repo root and in `worker/`
- do not introduce Bun, pnpm, or Yarn lockfiles without explicit repo-wide approval
- inspect scripts and existing lockfiles before changing dependency-related files
- do not add dependencies casually

---

## Verification policy

Run the narrowest sufficient verification early, then the broader required verification before handoff.

Canonical local commands:
- repo gate: `npm run verify`
- root app loop: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`
- worker loop: `npm run verify:worker` or `npm --prefix worker run verify`

### Verification lanes

#### Lane 0 — docs / copy / non-behavioral changes
Run only what is needed to confirm no unintended breakage.

#### Lane 1 — isolated local behavior change
Run targeted checks first, then the minimum broader checks for confidence.

#### Lane 2 — shared behavior or cross-file change
Run targeted checks plus broader affected-area checks, then `npm run verify` unless clearly unnecessary.

#### Lane 3 — high-risk change
Required for:
- auth
- access control
- billing
- file/PDF ingestion
- quote logic
- async workflows
- publication paths
- migrations
- external API contracts

Run targeted checks early and the full required repo verification before handoff.

Do not skip verification silently.
If verification is not feasible, state why.

---

## Testing policy

Follow `TEST_STRATEGY.md`.

High-level rules:
- bug fixes should be test-first when practical
- behavior changes should include test evidence or an explicit rationale for omission
- auth, access control, async workflows, quote logic, and publication paths are high-risk areas
- cosmetic-only changes may not need automated tests, but still require appropriate verification

---

## Migration and schema policy

For schema, migration, or data-boundary changes:
- inspect related schema and migration files before editing
- make the smallest intentional change
- document migration implications in the PR
- include rollback notes where meaningful
- do not mix unrelated schema work into a feature branch

If a local override exists for database-related files, follow it.

---

## Documentation update policy

When changing any of the following, update the relevant docs in the same change or explicitly state why no doc update is needed:
- product behavior
- workflow expectations
- test expectations
- repo operating rules
- architecture boundaries

Common doc targets:
- `PRD.md`
- `PLAN.md`
- `ARCHITECTURE.md`
- `TEST_STRATEGY.md`
- `ACCEPTANCE_CRITERIA.md`
- `README.md`
- `CONTRIBUTING.md`

---

## Review guidelines

Always flag first:
- P0/P1 security, auth, privacy, and data-loss regressions
- broken API or schema contracts
- missing validation on external inputs
- risky dependency additions or permission expansions
- changed critical paths without adequate tests
- undocumented behavior changes
- logging of secrets, tokens, or PII
- authorization boundary regressions

Also flag:
- missing TSDoc on shared exported utilities, worker orchestration helpers, repo scripts, and non-obvious domain helpers when behavior is not clear from the signature alone

Do not require boilerplate docstrings for trivial components or obvious local helpers.

For recurring review expectations and GitHub-side Codex guidance, also read `docs/code-review.md`.
This repo uses subscription-backed local Codex CLI review and native GitHub Codex review, not API-key Codex Actions.

---

## Pull request standard

PRs must include:
- problem
- scope
- verification evidence
- tests added or updated
- migration notes where applicable
- rollback or risk notes where applicable
- docs updated or reason none were needed

Every required section from `.github/pull_request_template.md` must be filled with concrete content — do not leave template boilerplate, partial sections, or autogenerated summaries as the only content.

PR body helpers:
- prefer `npm run render:pr-body -- <path-to-json>` plus `gh pr create --body-file` or `gh pr edit --body-file` for a structured PR body flow
- `npm run validate:pr-body` is an optional local hygiene check, not a required branch-protection gate

See `.github/pull_request_template.md`.
For recurring Codex and Symphony issue motions, use `docs/recurring-workflows.md` as the concise cross-reference for planning, verification-lane selection, skill usage, and handoff evidence.

Before publishing:
- ensure the branch is coherent
- ensure the PR exists
- ensure the title is concrete
- ensure the body reflects actual work performed

---

## Task completion standard

A task is not complete until:
1. the requested change is implemented
2. relevant verification has been run
3. the diff is coherent
4. docs are updated if needed
5. important risks or follow-ups are noted
6. the result matches the source-of-truth docs

---

## Stop-and-flag conditions

Stop and surface the issue instead of improvising when:
- source-of-truth docs conflict materially
- the task implies a product decision not documented anywhere
- migration behavior is risky or unclear
- access-control behavior is ambiguous
- a requested shortcut bypasses a protected workflow boundary
- two agents would need to touch the same file at the same time
- the task's blast radius is expanding beyond original intent without explicit approval
- mirrored instruction files disagree

---

## Efficiency rules

Use these rules to preserve context and reduce unnecessary tool churn:
- run one primary analysis pass
- delegate only bounded tasks
- require compact structured subagent outputs
- default to low-volume git inspection first (`--name-only`, `--oneline`, `--stat`, JSON summaries)
- pull full patch or log output only after a concrete target is identified
- keep command output scoped to the decision at hand
- prefer targeted verification before full-repo verification
- use one watcher for CI or checks instead of repeated polling
- set explicit work budgets for analysis, implementation, and verification
- avoid redundant integration layers

Speed without control is waste.
Control without throughput is also waste.
The target is narrow, verified motion.

---

## Repository routing

Before structural changes:
- read `README.md`, `ARCHITECTURE.md`, and `TEST_STRATEGY.md`

For UI changes:
- inspect existing component and layout patterns first

For backend or data changes:
- inspect schema, migrations, and authorization rules first

For PR review:
- apply the closest matching `AGENTS.override.md` file for the area touched by the diff

---

## Directory-local overrides

If present, local override files take precedence for their directory:
- `supabase/AGENTS.override.md`
- `worker/AGENTS.override.md`
- `src/features/quotes/AGENTS.override.md`

If no override exists, follow this root file.

---

## Solo Linear workflow addendum

- Treat Linear as the system of record for issue ID, acceptance criteria, status, and priority
- Restate acceptance criteria before implementation starts
- Prefer the smallest safe change that satisfies the issue
- Do not invent APIs, routes, database fields, or contracts without checking code first
- For billing, auth, data import, PDF/file ingestion, and quote logic, include failure-state handling and logging
- Run relevant tests before marking work complete
- Use repeatable skills and helpers for recurring workflows
- If recurring review feedback repeats, update this file or the nearest local instruction file
