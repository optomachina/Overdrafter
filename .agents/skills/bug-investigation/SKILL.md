---
name: bug-investigation
description: Investigate a defect and propose a minimal safe fix direction before coding.
---

# Goal

Establish evidence-backed bug diagnosis and narrow fix direction.

## Required output
- likely root cause area
- files likely in scope
- repro confidence
- missing debug data
- minimum safe fix direction

## Rules
- Do not claim root cause without evidence.
- Separate observed facts from hypotheses.
- Prefer narrow fixes over broad refactors.

## Workflow
1. Capture observed behavior and repro steps.
2. Gather evidence from logs/tests/code paths.
3. Distinguish facts vs hypotheses.
4. Identify likely files and minimum safe fix direction.
5. List missing data needed to raise confidence.
