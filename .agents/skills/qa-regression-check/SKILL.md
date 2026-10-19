---
name: qa-regression-check
description: Validate acceptance criteria and regression risk after implementation.
---

# Goal

Review completed work for correctness and likely regressions before merge.

## Required output
- acceptance criteria status
- likely regression surfaces
- tests missing
- checks run (command, exit status, log hash) and additional checks proposed
- pass/fail summary

## Rules
- Run the named acceptance commands at the head SHA under review and record each command, its exit status and a log hash (for example `sha256sum` of the saved output). Propose additional manual checks only in addition to running them, never instead.
- Never report PASS without an executed check. Report FAIL when a check ran and failed. Report BLOCKED, with the blocker class (`access:`, `infra:`, ...) and the exact missing access, when a check cannot be executed.
- Do not assume success because builds pass.
- Verify intended behavior and likely breakpoints.
- Apply stricter scrutiny to billing/auth/data/file handling.

## Workflow
1. Map acceptance criteria to evidence.
2. Identify neighboring areas likely to regress.
3. Evaluate test coverage and gaps.
4. Run the named acceptance commands and record the results; then propose further manual checks for risky paths.
5. Return a clear PASS, FAIL or BLOCKED status for the head SHA with rationale.
