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
- manual checks to run
- pass/fail summary

## Rules
- Do not assume success because builds pass.
- Verify intended behavior and likely breakpoints.
- Apply stricter scrutiny to billing/auth/data/file handling.

## Workflow
1. Map acceptance criteria to evidence.
2. Identify neighboring areas likely to regress.
3. Evaluate test coverage and gaps.
4. Propose manual checks for risky paths.
5. Return clear pass/fail status with rationale.
