# Billing Workflow (Solo + Free Linear)

Use this for Stripe checkout, subscriptions, invoicing, entitlements, plan state, and billing-related access.

1. Create issue from `billing-feature-template.md`.
2. Route as high-risk using `linear-triage-router`.
3. Scope using `linear-feature-scoper` + `billing-implementation-guardrails`.
4. Confirm Stripe objects and org/customer mapping.
5. Confirm webhook events required for state sync.
6. Define entitlement source-of-truth (server-side).
7. Implement minimal slice and verify idempotency/replay handling.
8. Validate failure states and logging/audit trail.
9. Run targeted and broader regression checks.
10. Open PR with explicit risk + rollback notes; update Linear manually.
