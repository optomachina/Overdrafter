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

## Stripe event synchronization

- Deploy `stripe-events` without Supabase JWT verification; Stripe signature verification is the only public request credential.
- Configure `STRIPE_SECRET_KEY` and the endpoint-specific `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` as server-only secrets.
- Register the environment's single monthly Pro Price ID and test/live mode
  through the service-role-only `api_configure_stripe_pro_price` function
  before accepting subscription events. Checkout and webhook configuration
  must reference that same Price ID.
- Pin the Stripe endpoint to API version `2024-11-20.acacia`.
- Subscribe the endpoint to `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.marked_uncollectible`, and `invoice.voided`.
- Inspect a stored event through the service-role-only `api_get_stripe_event_status` function.
- Replay one repaired event with `api_replay_stripe_event`; reconcile a bounded pending/failed batch with `api_reconcile_stripe_events`.
- Never replay by changing inbox or subscription/invoice projection rows directly.
