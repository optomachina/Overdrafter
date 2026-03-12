OverDrafter Improvement Plan (delete me later)

This plan outlines the steps to align the OverDrafter repository and workflow with current best practices for AI‑assisted engineering.  It is based on recommendations from OpenAI and Anthropic, distilled from public blog posts, documentation and community experience.  Each checkbox represents a discrete action to perform.  Once a task is completed, check it off and commit the change.

1. Canonical planning artifacts
	•	Create /PRD.md at repo root using docs/reconstruction‑prd.md as a source for stable requirements.  The goal is to have a single canonical product spec.
	•	Create /PLAN.md for the current build phase.  Keep this document focused on the upcoming milestones and tasks.
	•	Add acceptance criteria either as a standalone ACCEPTANCE_CRITERIA.md or as blocks within PLAN.md.
	•	Add ARCHITECTURE.md describing system boundaries such as the web app, Supabase, worker, quote adapters, auth and storage.
	•	Add TEST_STRATEGY.md explaining the different test lanes (fixture‑mode, Vitest, Playwright) and what belongs in each.

2. Upgrade AGENTS.md
	•	Expand AGENTS.md to include coding standards, verification commands, package manager policy, branch naming conventions, test‑first rules, migration rules, documentation update rules and protected paths.
	•	Add nested AGENTS.override.md files in directories like /worker, /supabase, or /src/features/quotes to define folder‑specific rules.

3. Standardise package and build tooling
	•	Choose a single package manager and remove unused lockfiles.  Rename the package from vite_react_shadcn_ts to overdrafter.
	•	Remove generated output directories that should not be in version control (e.g., apps/web/.next).
	•	Add scripts like typecheck, format:check and verify that run all required checks in sequence.

4. Tighten CI
	•	Extend the GitHub Actions workflow to run lint, typecheck, Vitest and Playwright smoke tests, and migration validation in addition to build.
	•	Fail CI if required checks are skipped or if generated files are modified.

5. Make testing agent‑friendly
	•	Adopt a tests‑first workflow: write failing tests before implementing features or bug fixes.
	•	Define which UI regressions require Playwright coverage and document this in the test strategy.
	•	Ensure fixture‑mode can run locally without Docker so that UI tests can run in isolation.
	•	Add a PR checklist requiring new behaviour to have tests or an explicit justification for why tests are omitted.

6. Document source‑of‑truth hierarchy
	•	Update AGENTS.md to declare the hierarchy of truth: PRD.md > PLAN.md > route docs > README.
	•	Mark docs/reconstruction‑prd.md and feature plans as archival or source material once canonical docs exist.
	•	Date and status stamp plan documents; add a “Repo map” section to README that links to canonical docs.

7. Worktree policy
	•	Use Git worktrees by default for any change that affects behaviour, schema or more than one file.
	•	Reserve direct local edits for trivial one‑file fixes.
	•	Adopt a naming convention for worktrees/branches (feature/..., fix/..., spike/..., etc.) and enforce one problem per branch.
	•	Add cleanup instructions for stale worktrees.

8. PR discipline
	•	Introduce a PR template requiring: problem description, scope, acceptance criteria, test evidence, migration notes, screenshots, rollback risk and a summary of changes.
	•	Require documentation updates in PRs when behaviour changes.
	•	Require a summary of what was verified locally with exact commands run.

9. Reusable skills
	•	Create a .codex/skills directory with scripts for recurring tasks, e.g., $feature‑plan, $ui‑regression‑check, $supabase‑migration‑review, $quote‑workspace‑change, $pr‑ready‑summary.
	•	Encapsulate fixed shell mechanics inside these skills rather than repeating instructions in prompts.

10. Codex configuration
	•	Configure Codex to default to gpt‑5.4 for build and review profiles.
	•	Set reasoning effort (model_reasoning_effort and plan_mode_reasoning_effort) appropriately.
	•	Use sandbox_mode = workspace‑write with no network by default.
	•	Define named profiles for planning, building, reviewing, UI work and migrations.
	•	Place permanent guidance (e.g., always summarise the plan, run lint/typecheck/tests before finishing, prefer worktrees, avoid lockfile edits, update docs when behaviour changes) in your global ~/.codex/AGENTS.md.
	•	Remove dependence on giant custom prompts; rely on skills and plan mode.

11. MCP servers and tools
	•	Enable GitHub MCP and OpenAI Docs MCP for repository and documentation access.
	•	Add Supabase MCP when focusing on database schema and migrations.
	•	Consider Figma MCP if UI design integration becomes active.
	•	Use /plan‑mode and /review commands for multi‑step tasks.
	•	Set default branch naming and commit/PR prompts in Codex app settings.