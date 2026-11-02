# Commercial Rollout Controls

Use these controls to stop or stage commercial operations without removing
provider recommendations. All database controls are default-off and may be changed only through
the service-role API. Every operator action requires identity, reason, expected
revision, and idempotency evidence and appends an immutable audit event.

Use the [Commercial Account Administration Guide](./commercial-account-administration.md)
for the day-to-day browser workflow after an operator has been provisioned and
the relevant controls have been enabled.

The registry alone does not gate product behavior. The OVD-315 enforcement
migrations guard entitlement administration, and the OVD-314 enforcement
migration guards automatic quote collection separately. Keep every control off
until its matching enforcement migration and verification are deployed.

## Controls

| Capability | Effect when off | Safe customer behavior |
| --- | --- | --- |
| `commercial_admin_mutations` | Blocks trial/complimentary grant and revocation writes at the audited admin RPC boundary. | Existing entitlements continue to resolve from preserved history, and organization deletion cascades remain available. |
| `automatic_quote_collection` | Stops entitled automatic requests before vendor resolution or lifecycle writes. | Clients receive a neutral unavailable response; manual quotes and provider recommendations remain available. |
| `promotion_codes` | Reserved for the promotion-code implementation. | No subscription or manufacturing-order discount is applied. |
| `order_administration` | Reserved for the visibility-only order ledger. | Existing customer/project access is unchanged. |
| `controlled_beta_user_quantity` | The Xometry controlled beta admits only quantity `1`. | Other quantities receive `xometry_beta_quantity_one_required` before a lane or task is created. |

Hosted Checkout uses the independent server-only
`BILLING_SELF_SERVICE_ENABLED` Edge Function secret. Billing Portal access is
reserved for authorized owners of a bound Customer with a nonterminal existing
subscription, so turning off new Checkout does not remove their cancellation
path. Do not add a duplicate database control for Checkout.

## Provision billing administrators

Commercial-account access is a server-provisioned capability, not an
organization role. Being a platform viewer or an organization administrator
does not imply `billing_admin` access. Provisioning and revocation must run
through a trusted service-role or database-operator connection. Never expose
these writes through browser code.

First resolve and independently verify the intended auth user ID. Do not grant
access from an unverified email copied from a support request.

Before inserting the capability, independently confirm the operator's identity
and ownership of an already verified authenticator factor. The password-only
browser session that will receive the capability is not sufficient evidence.
If the operator has no independently established factor, stop; do not use the
commercial interface's AAL1 enrollment path to bootstrap commercial access.
No compliant in-product bootstrap path exists yet, so capability provisioning
is temporarily limited to approved operators whose factor was established and
verified before this workflow. Do not improvise a replacement procedure.

```sql
select id, email, created_at
from auth.users
where lower(email) = lower('operator@example.com');
```

Inspect existing assignments for that user before inserting. An expired row
with no `revoked_at` value still occupies the one-active-assignment slot; revoke
that historical assignment in place before creating a replacement.

Create one reasoned assignment. Use an expiration for temporary operator
access. `granted_by_user_id` may be `null` only for a documented bootstrap
operation that has no authenticated granting user.

```sql
insert into private.platform_admin_capabilities (
  user_id,
  capability,
  granted_by_user_id,
  grant_reason,
  expires_at
)
values (
  'operator-auth-user-id',
  'billing_admin',
  'granting-auth-user-id',
  'Commercial account administration for approved operations rotation',
  '2026-09-01T00:00:00Z'
)
returning id, user_id, capability, expires_at, created_at;
```

Verify the operator can open `/internal/commercial`, then verify an AAL2
authenticator session before enabling mutation access. The application must
still reject organization administrators, platform viewers, expired grants,
and revoked grants that lack the capability.

Revoke an assignment in place with an actor and reason. Never delete capability
history or reuse an old row for a different person or capability.

```sql
update private.platform_admin_capabilities
set
  revoked_at = timezone('utc', now()),
  revoked_by_user_id = 'revoking-auth-user-id',
  revocation_reason = 'Operator rotated out of commercial administration'
where id = 'capability-assignment-id'
  and user_id = 'intended-auth-user-id'
  and capability = 'billing_admin'
  and revoked_at is null
returning id, user_id, capability, revoked_at, revocation_reason;
```

Treat a zero-row result as an unsuccessful revocation and stop. Re-resolve the
assignment, intended auth user, and capability before attempting a new action;
do not weaken the predicates to make an unexpected identifier succeed.

Capability assignment does not enable customer-access mutations by itself.
The independent `commercial_admin_mutations` control must also be on, and each
grant or revocation still requires AAL2, a reason, idempotency, and an appended
commercial audit event.

## Inspect state

Call `public.api_get_commercial_rollout_controls()` with the service role. It
returns all five controls (the four commercial controls plus OVD-987's
`controlled_beta_user_quantity`) and the latest 100 immutable change events.
Record the current revision before proposing a change. Change one capability
per transaction; see [Controlled beta user quantity](#controlled-beta-user-quantity)
for the lock order and turn-off semantics. Historical four-control release
packets are not evidence of the current five-control state. The OVD-987 notes
identify consumers that pin four controls, including the OVD-410 collector and
OVD-419 callers, which fail closed on a five-control response unless separately
updated. Check the [consumer inventory](../migration-drafts/ovd-987-notes.md#known-findings)
before reusing those tools.

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

## Controlled beta user quantity

Migration `20261101130000_ovd987_controlled_beta_user_quantity` is applied in
production and `controlled_beta_user_quantity` is **OFF**. It is the fifth
control, seeded off at revision 0; a missing row also reads as off. Turning it
on is a separate decision (`OVD-1000`). The scoped grant (`OVD-1007`) is a
separate path; this migration supplies only the global switch. Before
switch-on, resolve the prerequisites recorded in the
[OVD-987 known findings](../migration-drafts/ovd-987-notes.md#known-findings),
including the quantity-1 literal in fenced result acceptance.

While off, the Xometry controlled beta requires exactly `[1]`. While on, it
admits exactly one normalized positive integer quantity, default `1`, bounded
only by the database integer range. See the
[runbook quantity rule](../1-0-beta-runbook.md#quantity-in-controlled-beta-requests).

After the separate enablement decision, use
`public.api_set_commercial_rollout_control` through the service-role API as in
[Change state](#change-state), naming `controlled_beta_user_quantity`, passing
`true` to turn it on or `false` to turn it off, with the current revision,
verified operator, specific reason and unique idempotency key. Read back the
state and retain the revision and immutable audit event in the owning issue.

- **One capability per transaction.** The setter holds that capability's
  exclusive advisory lock until transaction end. Worker authorization takes
  the shared `automatic_quote_collection` lock first, then the shared quantity
  lock for a lane above `1`. Setting quantity then automatic collection in one
  transaction can deadlock with authorization. Use separate transactions; if
  both must change in one transaction, change `automatic_quote_collection` first.
- **Turn-off boundary.** Lanes already authorized still launch. Lanes above
  quantity `1` that have not been authorized are refused at worker preflight
  with `dispatch_quantity_not_admitted`, before browser launch. Use the
  [provider kill switch](../runbooks/provider-cease-and-desist.md) procedure to
  contain already-authorized traffic; turning this control off is insufficient.
- **Replay and settlement.** Replaying a committed quantity-N request after
  turn-off raises `xometry_beta_quantity_one_required` before the deduplicated
  return. Its permit and hold remain intact. Reserved holds at N still settle
  normally because settlement does not read the switch.
- **Worker reporting.** The migration does not change the worker's bounded
  reason list; it maps `dispatch_quantity_not_admitted` to the generic
  `dispatch_authorization_denied` until a worker change adds the reason.

Use turn-off for incident containment, not a migration rollback. Schema
rollback is a separate reviewed operation: turn the switch off, drain all
Xometry permits above quantity `1`, and follow the guarded rollback and
read-only checks in [OVD-987 notes](../migration-drafts/ovd-987-notes.md).
Those notes and the migration header contain historical pre-apply status;
the current production status is applied and OFF, as stated above.

## Rollout order

1. Confirm the target migration and functions are deployed without running a
   broad linked `supabase db push` while migration history remains divergent.
2. Confirm all five database controls are off and
   `BILLING_SELF_SERVICE_ENABLED=false`.
3. Confirm the OVD-315 and OVD-314 enforcement migrations are deployed before
   relying on their control values as product safety boundaries.
4. Exercise Free manual quote and Pro disabled-automatic paths. Neither may
   create vendor jobs or automatic quote lifecycle rows.
5. Enable `commercial_admin_mutations` for internal audited administration.
6. Complete Stripe test-mode replay, reorder, retry, and reconciliation checks.
7. Enable new-subscription Checkout only for a later approved paid pilot; keep
   it disabled for the Founding Beta.
8. Enable `automatic_quote_collection` only after worker-path production smoke
   checks pass.
9. Keep `promotion_codes` and `order_administration` off until their own
   implementations and rollout gates are complete.

## Rollback

- Automatic quote incident: turn `automatic_quote_collection` off. The change
  waits for an already-authorized automatic request transaction to finish, then
  returns the bounded manual fallback for every new Pro request. Manual quotes,
  uploads, and provider recommendations remain available.
- Privileged admin incident: turn `commercial_admin_mutations` off. The change
  waits for already-authorized grant/revoke transactions to finish, then blocks
  all new mutation calls, including exact retries, before delegated grant or
  revoke work begins. Do not edit or delete grants or their audit history.
- Checkout incident: set `BILLING_SELF_SERVICE_ENABLED=false`. This blocks new
  subscriptions while preserving the verified Billing Portal cancellation
  path. Do not remove the Stripe webhook secret as a rollback because Stripe
  will retry configuration failures.
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

Rolling back OVD-314 restores the entitlement-only wrapper from
`20260731015240_gate_automatic_quotes_by_entitlement.sql` and drops
`private.automatic_quote_rollout_enabled_with_lock`. That makes eligible Pro
requests bypass the rollout registry, so use only a reviewed forward migration;
turning `automatic_quote_collection` off is the safe operational rollback.

Rolling back the OVD-315 linearization migration first restores
`private.require_commercial_admin_mutation` from the review-hardening migration
without its shared transaction lock and reintroduces the check/write race.
Rolling back the underlying OVD-315 schema wrapper must still preserve every
entitlement grant and `commercial_admin_audit_events` row. Restore the private
unguarded grant/revoke implementations to their original public names and
authenticated EXECUTE grants, then drop
`private.require_commercial_admin_mutation`, only in a reviewed forward
migration. Never use either schema rollback to contain an incident; turning
`commercial_admin_mutations` off is the safe operational rollback.

## Monitoring and reminders

- Alert on rollout-control changes outside a release or incident window.
- Alert when automatic quote requests return `automatic_quote_disabled` after
  a planned enablement.
- Continue webhook-lag, failed-event, entitlement-drift, and grant-review
  monitoring independently of these controls.
- Preserve the control event log, Stripe inbox, subscription projections,
  entitlement grants, and commercial audit rows through every rollback.
