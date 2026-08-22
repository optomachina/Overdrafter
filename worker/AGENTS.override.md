# AGENTS.override.md

Applies to the `worker/` area.

## Purpose

This override defines extra rules for asynchronous processing and long-running job behavior.

## Extra rules

- Preserve explicit status transitions.
- Do not hide failures.
- Prefer fail-closed behavior over silent partial success for production queue
  work. The explicit `live_evaluation` harness defined by OVD-407 may bypass
  production provider-admission, disclosure, entitlement/rollout,
  dispatch-permit/preflight, anti-bot-certification, and order-prevention
  dependencies; keep that exception direct, local-evidence-only, and separate
  from customer persistence. It does not bypass the file-bound
  non-export-controlled confirmation.
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
