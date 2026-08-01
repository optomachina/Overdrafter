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
- Before enabling Checkout, verify the fixed monthly and annual lookup-key
  catalog in the intended Stripe mode. The billing boundary registers both
  exact Price IDs in the historical webhook entitlement allowlist; catalog
  rotations must never remove Price IDs still referenced by subscriptions.
- Pin the Stripe endpoint to API version `2024-11-20.acacia`.
- Subscribe the endpoint to `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.marked_uncollectible`, and `invoice.voided`.
- Inspect a stored event through the service-role-only `api_get_stripe_event_status` function.
- Replay one repaired event with `api_replay_stripe_event`; reconcile a bounded pending/failed batch with `api_reconcile_stripe_events`.
- Never replay by changing inbox or subscription/invoice projection rows directly.

## Pro billing database foundation

- Each organization billing account stores one explicit client membership as
  its stable billing owner. Ordinary members and internal platform staff cannot
  prepare customer billing state. Removing that membership clears billing
  authority and requires an explicit owner assignment before billing can resume;
  authority never transfers to another member implicitly.
- The active Checkout catalog has monthly and annual slots for
  `overdrafter_pro_monthly_v1` and `overdrafter_pro_annual_v1`. Configuring a
  new active Price adds it to the webhook entitlement allowlist without removing
  historical Price IDs that may still back subscriptions.
- A durable per-organization, per-mode Checkout intent serializes monthly and
  annual races. Same-plan retries resume its UUID for downstream Stripe
  idempotency; another interval remains blocked while the intent is pending or
  open and unexpired.
- Checkout success is never an access signal. Eligible signed-webhook
  projections resolve active, trialing, and seven-day past-due grace states;
  cancellation at period end retains Pro only through the paid boundary.
- `billing.upgrade_started` and `billing.subscription_activated` are recorded
  in the existing server-side audit event stream. Guard triggers prevent
  clients and the legacy generic audit function from forging those billing
  event types, and protected billing history is append-only.
