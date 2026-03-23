---
name: linear-triage-router
description: Classify incoming work and produce a safe next step for Linear issue intake.
---

# Goal

Classify an incoming request into one category and produce a practical intake output for a solo developer using free Linear.

## Categories
- bug
- ui-feature
- billing-feature
- research-spike
- qa-regression
- documentation
- refactor
- unknown

## Required output
- category
- suggested title
- suggested priority
- suggested labels
- missing information
- recommended next action
- whether implementation should start now

## Rules
- Do not implement code.
- Do not over-design the solution.
- Do not silently guess critical missing info.
- Route conservatively when billing/auth/data integrity is involved.

## Workflow
1. Read request and extract the concrete problem.
2. Select one category from the allowed list.
3. Suggest a concise issue title in "<ISSUE-TYPE>: <intent>" form.
4. Assign a priority (`P0` to `P3`) with brief rationale.
5. Suggest up to three labels.
6. List blocking missing information.
7. Recommend immediate next action and whether coding should start.
