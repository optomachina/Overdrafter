# Claude Code Adapter

Repo operating policy lives in `AGENTS.md`.
Claude Code must treat `AGENTS.md` as the canonical behavioral contract for planning, Linear updates, rolling progress comments, validation gates, complexity classification, demo artifacts, status transitions, and handoff.

Claude-specific notes:
- Read `AGENTS.md` before implementation or review work.
- Do not duplicate policy from `AGENTS.md` here.
- If Claude-specific behavior needs to become durable repo policy, update `AGENTS.md` first and keep this file as a pointer.

## Skill routing

This repo uses two skill systems that coexist:

1. **Agentation skills** — in-repo at `.agents/skills/` (e.g. `bug-investigation`,
   `qa-regression-check`, `implement-linear-issue`, `linear-triage-router`,
   `linear-feature-scoper`, `release-note-writer`, `billing-implementation-guardrails`,
   `agentation`, `agentation-self-driving`). These ship with the repo and are versioned
   alongside the code.
2. **Gstack skills** — globally installed at `~/.claude/skills/gstack/`, invoked
   via their short names (e.g. `/investigate`, `/qa`, `/ship`). These are dev-workflow
   tooling (not repo-specific) and do NOT live under `.agents/skills/`.

Routing rules below refer to **gstack** skills unless noted. When the user's request
matches an available skill, ALWAYS invoke it using the Skill tool as your FIRST action.
Do NOT answer directly, do NOT use other tools first. The skill has specialized
workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke gstack `office-hours`
- Bugs, errors, "why is this broken", 500 errors → invoke gstack `investigate` (not to be confused with agentation's `bug-investigation`, which is triggered from a Linear ticket)
- Ship, deploy, push, create PR → invoke gstack `ship`
- QA, test the site, find bugs → invoke gstack `qa` (agentation's `qa-regression-check` runs on a Linear-ticket context instead)
- Code review, check my diff → invoke gstack `review`
- Update docs after shipping → invoke gstack `document-release`
- Weekly retro → invoke gstack `retro`
- Design system, brand → invoke gstack `design-consultation`
- Visual audit, design polish → invoke gstack `design-review`
- Architecture review → invoke gstack `plan-eng-review`
- Save progress, checkpoint, resume → invoke gstack `checkpoint`
- Code quality, health check → invoke gstack `health`

## Design System

Read `docs/DESIGN.md` before any visual or UI decision.
All font choices, colors, spacing, layout patterns, and aesthetic direction are defined there.
Do not deviate without explicit user approval and a logged Decisions row in `docs/DESIGN.md`.
In QA and review modes, flag any code that doesn't match `docs/DESIGN.md`.

## Health Stack

- typecheck: npm run typecheck
- typecheck-worker: npm --prefix worker run typecheck
- lint: npm run lint
- test: npm test
