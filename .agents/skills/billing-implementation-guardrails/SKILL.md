---
name: billing-implementation-guardrails
description: Enforce strict implementation checks for billing and entitlements changes.
---

# Goal

Apply mandatory safeguards for Stripe/billing and entitlement work.

## Required output
- Stripe objects involved
- source-of-truth definition
- webhook/event map
- failure-state checklist
- logging/audit checklist
- idempotency/replay considerations

## Rules
- Do not trust client-only redirects for entitlements.
- Prefer webhook-driven state synchronization.
- Require explicit failure-state handling.
- Require logging/audit considerations.
- Verify org/customer/subscription mapping.
- Flag idempotency and replay concerns.

## Workflow
1. Enumerate Stripe entities and local data mappings.
2. Define authoritative entitlement state owner.
3. List required events and handlers.
4. Verify failure and recovery behavior.
5. Verify logs/audit traceability.
6. Validate idempotency and replay resilience.
