# OverDrafter Acceptance Criteria

Last updated: March 11, 2026

## Purpose

This document defines what it means for the current repository-hardening phase to be complete.

## Acceptance criteria

### 1. Canonical root documentation
- `PRD.md` exists at repo root.
- `PLAN.md` exists at repo root.
- `ARCHITECTURE.md` exists at repo root.
- `TEST_STRATEGY.md` exists at repo root.
- `ACCEPTANCE_CRITERIA.md` exists at repo root.
- `README.md` points to the canonical docs.

### 2. Source-of-truth hierarchy is explicit
- The repo clearly states the hierarchy of truth.
- `AGENTS.md` names the hierarchy explicitly.

### 3. `AGENTS.md` is a real operating manual
- Root `AGENTS.md` is sufficient to guide an agent or contributor.
- It includes verification expectations.
- It includes package manager policy.
- It includes branch/worktree guidance.

### 4. Package and tooling ambiguity is removed
- One package manager is authoritative.
- The unused lockfile is removed.
- Standard local verification scripts are present and documented.

### 5. Local verification is standardized
- Lint is runnable locally.
- Typecheck is runnable locally.
- Tests are runnable locally.
- Build is runnable locally.

### 6. CI is stronger than build-only validation
- CI runs more than just a basic build.
- CI includes the key static checks and automated verification expected by the repo.

### 7. Testing policy is explicit and enforceable
- The repo defines when tests are expected by change type.
- Bug fixes require tests when practical.
- Behavior-changing changes require test evidence or an explicit rationale for omission.

### 8. PR discipline is standardized
- A PR template exists.
- The template requests problem, scope, verification evidence, and risk notes.

### 9. Branch and worktree discipline is documented
- The repo states when worktrees should be used.
- Branch naming conventions are documented.
- Nontrivial work is expected to happen in isolated branches or worktrees.
