# Extraction quality summary access

`public.extraction_quality_summary` is service/operator monitoring, not a
customer API. It preserves organization/day counters and rates from immutable
extraction-completion audit events. The forward hardening migration preserves
the ten-column contract and the service-only alert evaluator while using
`security_invoker=true` and removing PUBLIC, anon and authenticated access.

The migration checks effective column access, including inherited grants, and
fails if a client can still read the view. It also fails if service_role lacks
the existing underlying audit SELECT privilege; it never repairs monitoring by
granting customers access to audit events. Authorized internal audit-table
access and the guarded customer activity-feed RPC remain separate.

Verify with `supabase/tests/extraction_quality_summary_security.sql` in an
isolated local database containing synthetic fixtures. The tests exercise real
roles, two organizations, client denial, internal audit RLS, service aggregate
parity and the existing evaluator's idempotent behavior. TypeScript simulations
of the counters alone do not prove this privilege boundary.

Deployment requires separate qualification and authorization. Confirm
PostgreSQL 15+ support, effective view/base privileges and current ownership,
then verify the deployed view options, client-deny/service-read grants and
named advisor finding using catalog-only evidence. An unchanged total advisor
count is not proof of unchanged findings. This database fix is independent of
any frozen source-only worker image build and must not be inserted into its
approval packet.

Rollback must preserve denied client access. If monitoring fails, fix forward
after identifying the intended privileged reader; do not restore the historical
public/client grants. No provider routing, worker execution or customer data
mutation belongs to this change.
