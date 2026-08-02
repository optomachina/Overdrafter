# Commercial Rollout Controls

Use these controls to stop or stage commercial operations without removing Free
sourcing. All database controls are default-off and may be changed only through
the service-role API. Every operator action requires identity, reason, expected
revision, and idempotency evidence and appends an immutable audit event.

The registry alone does not gate product behavior. The OVD-315 enforcement
migration guards entitlement administration, and OVD-314 adds automatic-quote
enforcement separately. Keep every control off until its matching enforcement
migration and verification are deployed.

## Controls

| Capability | Effect when off | Safe customer behavior |
| --- | --- | --- |
| `commercial_admin_mutations` | Blocks trial/complimentary grant and revocation writes at the audited admin RPC boundary. | Existing entitlements continue to resolve from preserved history, and organization deletion cascades remain available. |
| `automatic_quote_collection` | OVD-314 stops Pro automatic requests before vendor resolution or lifecycle writes. | Free still receives the Pro upgrade prompt; manual quotes and provider recommendations remain available. |
| `promotion_codes` | Reserved for the promotion-code implementation. | No subscription or manufacturing-order discount is applied. |
| `order_administration` | Reserved for the visibility-only order ledger. | Existing customer/project access is unchanged. |

Hosted Checkout and Billing Portal use the independent server-only
`BILLING_SELF_SERVICE_ENABLED` Edge Function secret. Do not add a duplicate
database control for billing self-service.

## Inspect state

Call `public.api_get_commercial_rollout_controls()` with the service role. It
returns all four controls and the latest 100 immutable change events. Record the
current revision before proposing a change.

Never grant direct table access or update either private rollout table by hand.

## Change state

Call `public.api_set_commercial_rollout_control` with:

- the exact capability name;
- the desired boolean state;
- a specific operator reason between 3 and 500 characters;
- a verified operator identifier between 3 and 200 characters;
- the revision returned by the read API;
- an idempotency key between 8 and 200 characters that is unique across all
  rollout-control actions.

The expected revision prevents a stale operator decision from overwriting a
newer one. An exact retry returns `replayed: true` without creating another
event. A real change increments the revision. A new same-state operator action
is audited as `changed: false` without incrementing the revision.

Example service-role invocation:

```sql
select public.api_set_commercial_rollout_control(
  'automatic_quote_collection',
  true,
  'Enable audited pilot organization after production smoke checks',
  'release-manager@example.com',
  0,
  'release-2026-08-automatic-pilot'
);
```

Use the revision reported by the read API; `0` is only correct for a control
that has never changed.

## Rollout order

1. Confirm the target migration and functions are deployed without running a
   broad linked `supabase db push` while migration history remains divergent.
2. Confirm all four database controls are off and
   `BILLING_SELF_SERVICE_ENABLED=false`.
3. Confirm the OVD-315 and OVD-314 enforcement migrations are deployed before
   relying on their control values as product safety boundaries.
4. Exercise Free manual quote and Pro disabled-automatic paths. Neither may
   create vendor jobs or automatic quote lifecycle rows.
5. Enable `commercial_admin_mutations` for internal audited administration.
6. Complete Stripe test-mode replay, reorder, retry, and reconciliation checks.
7. Enable billing self-service only for the approved pilot environment.
8. Enable `automatic_quote_collection` only after worker-path production smoke
   checks pass.
9. Keep `promotion_codes` and `order_administration` off until their own
   implementations and rollout gates are complete.

## Rollback

- Automatic quote incident: turn `automatic_quote_collection` off. Manual
  quotes, uploads, and provider recommendations remain available.
- Privileged admin incident: turn `commercial_admin_mutations` off. The change
  waits for already-authorized grant/revoke transactions to finish, then blocks
  all new mutation calls, including exact retries, before delegated grant or
  revoke work begins. Do not edit or delete grants or their audit history.
- Checkout incident: set `BILLING_SELF_SERVICE_ENABLED=false`. Do not remove the
  Stripe webhook secret as a rollback because Stripe will retry configuration
  failures.
- Webhook incident: keep signed intake active when it is safe so events remain
  durable locally. If the Stripe endpoint must be disabled, repair it and use
  Stripe resend/backfill for events that never reached the inbox before using
  the local replay/reconciliation APIs. Do not delete inbox or projection rows.
- Promotion/order incident: turn only the affected reserved control off.

After rollback, verify the read API reports the intended state and the latest
event contains the expected previous state, new state, revision, reason, time,
operator, role, and idempotency key.

Schema rollback is a separate reviewed migration, not an incident response.
First roll back OVD-315, OVD-314, and every later enforcement dependency. Then
revoke and drop `api_set_commercial_rollout_control`,
`api_get_commercial_rollout_controls`, and
`private.commercial_rollout_enabled`; export the immutable event rows; drop the
event table and `private.reject_commercial_rollout_control_event_mutation`;
and finally drop the control table. Removing enforcement while a control is off
would re-enable the pre-control behavior.

Rolling back the OVD-315 linearization migration first restores the complete
wrapper definitions from `20260802011500_gate_entitlement_admin_mutations.sql`
and reintroduces the check/write race. Rolling back the underlying OVD-315
schema wrapper must still preserve every entitlement grant and
`commercial_admin_audit_events` row. Restore the private unguarded grant/revoke
implementations to their original public names and authenticated EXECUTE grants
only in a reviewed forward migration. Never use either schema rollback to
contain an incident; turning `commercial_admin_mutations` off is the safe
operational rollback.

## Monitoring and reminders

- Alert on rollout-control changes outside a release or incident window.
- Alert when automatic quote requests return `automatic_quote_disabled` after
  a planned enablement.
- Continue webhook-lag, failed-event, entitlement-drift, and grant-review
  monitoring independently of these controls.
- Preserve the control event log, Stripe inbox, subscription projections,
  entitlement grants, and commercial audit rows through every rollback.
