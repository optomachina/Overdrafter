# AGENTS.override.md

Applies to the `worker/` area.

## Purpose

This override defines extra rules for asynchronous processing and long-running job behavior.

## Extra rules

- Preserve explicit status transitions.
- Do not hide failures.
- Prefer fail-closed behavior over silent partial success.
- Keep retry behavior intentional.
- Do not blur orchestration logic and product-state mutation without clear reasoning.
- Preserve observability where possible.

## Verification emphasis

For worker changes, prioritize:
- job status progression
- failure-path behavior
- retry behavior
- relevant integration checks
- any worker-specific verification scripts
