---
name: linear-feature-scoper
description: Convert a raw issue into a minimal implementation-ready scope and test plan.
---

# Goal

Turn a Linear issue into a scoped implementation plan that can be executed safely.

## Required output
- normalized problem statement
- acceptance criteria
- likely files in scope
- dependency/risk notes
- minimal implementation plan
- test plan
- PR outline

## Rules
- Do not write code.
- Prefer minimal scope.
- Flag ambiguity explicitly.
- State if issue should be split into follow-ups.

## Workflow
1. Normalize problem statement from issue text.
2. Rewrite acceptance criteria as verifiable checks.
3. Identify likely files and systems touched.
4. Note dependencies and key risks.
5. Propose the smallest viable implementation plan.
6. Define test plan (automated + manual).
7. Draft PR outline with verification evidence expectations.
