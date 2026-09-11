# Entitlement revocation audit scope

OVD-504 preserves revocation for valid grant UUIDs whose numeric segments happen
to pass Luhn validation. The existing audit validator exempts a whole UUID, but
the server prefixes grant IDs with `organization_entitlement_revoke:`; generic
free-text scanning can therefore mistake that structured identifier for card
data and abort the transaction.

The private audit append function recognizes only the exact combination of
`billing_admin`, `commercial.entitlement.revoke`,
`organization_entitlement_grant`, a canonical lowercase UUID target, and scope
equal to that prefix plus the target. It validates the typed UUID component.
All other scopes retain generic validation. Reasons, metadata, before/after
state and idempotency keys retain their existing checks even for this tuple.
No UUID substring is stripped from arbitrary text.

The only production caller generating this tuple is the server-owned
entitlement revocation function. The private append helper is not executable by
public, anon, authenticated or service_role API roles. Grant, manual-quote and
offer-invalidation callers do not match this exception and remain unchanged.
Other structured scope false positives, including grant scopes, are outside
this bounded repair and require their own evidence and scoped tests.

Persisted scope bytes, historical receipts, replay comparisons, public API
signatures, function security settings and permissions are unchanged. No Stripe
objects, webhooks, payment processing or subscription mapping are involved.
The authoritative change is the transactional server entitlement mutation plus
its immutable audit receipt; audit rejection still rolls back the mutation.

## Validation

`supabase/tests/commercial_audit_uuid_scopes.sql` exercises actual guarded
revocation using two deterministic colliding UUIDs, exact scope persistence,
replay, changed reason/actor, transactional rejection and absence of a failed
audit receipt. It also tests malicious scope variations, mismatched tuple
fields, card numbers beside UUIDs, nested/array/numeric card data, keys and
credential rejection. Existing commercial-admin and entitlement suites retain
capability, AAL2, access and append-only coverage.

Replay the complete migration chain only in an explicitly disposable local
database, run this suite and existing affected SQL suites, and run the required
repository checks before review. A passing retry of previously intermittent CI
is not a substitute for the deterministic regression.

## Deployment and rollback

The additive migration replaces only the existing private function; it creates
no tables, rewrites no rows and enables no rollout. Production application is a
separate exact approval. Verify the actual deployed migration suffix before
preparing that operation; do not implicitly deploy unrelated engineering work.

Rollback uses a forward migration restoring the previous function definition
and grants from `20260731015213_secure_commercial_admin_operations.sql`, without
deleting audit history. Prepare and name that forward migration only when rollback
is requested; placing it in the normal migration sequence now would undo the
repair during every deployment. It reintroduces the UUID false positive and must be
reported as such. The OVD-419 authentication proof uses read-only database
guards and does not invoke this revocation path.
