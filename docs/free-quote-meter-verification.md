# Free quote meter verification and rollback

This migration adds no enabled policy, chosen subject, cap, window, enrollment or entitlement. Free eligibility and admission wrappers are in the following separately owned migration; apply and review both before testing. Existing paid/manual entrypoints, customer confirmations, worker lease/scope, rollout and spend controls remain independent.

## Database qualification required

The authored database tests have **not been executed in the cloud development environment**: Docker is available but no database images/runtime are present. Supabase CLI is available for migration naming only. Node tests and textual migration inspection do not qualify PostgreSQL syntax, grants, trigger timing or concurrency.

On a deliberately prepared local disposable Supabase fixture with the full current schema and both migrations applied:

```
supabase test db supabase/tests/free_quote_job_meter.sql
supabase test db supabase/tests/free_confirmed_quote_access.sql
```

`free_quote_job_meter.sql` rolls back its fixtures. It covers explicit policy history constraints, revoked direct access, forced RLS metadata, actual confirmed admission, canonical offers and forced immediate constraints, zero/NaN/expired/unverified quotes, duplicate completion, cancellation/reopening, deferred failure with queue cleanup still running, atomic offer-write failure and exact retention of synthetic known and pending spend.

The dblink test commits fixtures so two sessions can see them. Prepare a fresh, exclusively owned database named `free_meter_fixture_<nonce>` with the same full schema; never reuse an existing shared/test/production database. Then invoke PostgreSQL's TAP runner on `scripts/qualification/free-quote-meter-concurrency.sql` with that explicit local fixture connection. The script lives outside automatic `supabase/tests` discovery because it commits fixtures. After the owner verifies an existing local fixture connection and cached test capacity, run it explicitly:

```
supabase test db --db-url "$FREE_METER_FIXTURE_DB_URL" scripts/qualification/free-quote-meter-concurrency.sql
```

`FREE_METER_FIXTURE_DB_URL` must identify that already prepared, exclusively owned local fixture; do not point it at a remote/shared database. This command is a handoff instruction, not authorization to install, pull images, reset a stack or configure credentials. If existing cached capacity is unavailable, keep qualification blocked.

It refuses other database names or existing meter rows. It tests same-approval replay at a full last slot, two distinct jobs racing for the last slot, and cancel/finalize in both orders. Preserve TAP output, inspect deadlocks/timeouts, and have the owning harness destroy the entire disposable database afterward. There is intentionally no evidence-deletion or trigger-disabling cleanup shortcut.

The included `.inc` file is fixture setup, not a standalone test. Its limits, addresses, users, notices, guardrail settings and costs are synthetic inputs only. It creates no paid transaction. Database-role/RLS execution must be checked in addition to catalog grants; lock ordering must be checked in actual sessions, not inferred from an authored test.

Further exact-head qualification should exercise lock waits crossing policy/offer expiry, invalid timestamp/infinite-price inputs, disabled pinned policy, cross-organization forged identities, immutable subject/source changes, and concurrent administrator invalidation. The access-owner suite covers the replay/worker/source distinction and current eligibility; do not count those authored cases as passes before execution.

## Lock graph and authority

New admission takes shared configuration lock, sorted organization/actor subject locks, then existing job/approval locks. New occupancy requires READ COMMITTED and fresh statements after waits. Policy writes use exclusive configuration lock; historical policy windows cannot overlap even if disabled. A held receipt converts to consumed without increasing occupancy; release only decreases it. Lifecycle paths never take capacity/configuration locks.

Canonical writer locks result then request, writes the full offer set, then locks the receipt. The metered result BEFORE trigger locks/rechecks request before the older AFTER status reducer. That reducer also updates the service-line-item row; retain this edge in deadlock review. Cancellation holds request, service-line-item/run/queue/jobs rows, then invokes only request-to-receipt release. Neither cancellation nor the private settlement helper locks a result/offer after request. No offer-only meter trigger exists; administrator invalidation has no reverse result/request hook.

A result's queued/running status retains a hold. Failed/manual terminal results can release while the queue task still says running during cleanup, since the released receipt prevents future execution. Deferred hooks process failure/manual states only: success/no-offer is settled only after explicit canonical offer reconciliation, even if constraints are forced immediate. A valid historical receipt is not worker execution authority; free workers require reserved state plus all existing guards.

## Safe disable and rollback

No rollout is enabled by this migration. To stop future free work, an independently authorized operator can disable the chosen policy through the existing restricted database administration process. This is not a new public administration or enrollment mechanism. Existing free receipts and attempted spend remain. Disabled policy stops future worker authorization, but terminal accounting still reconciles completed, failed and canceled work.

Do not drop lifecycle fences or receipt tables while requests remain active. Do not delete receipts, reset counters, insert an overlapping revision, reinterpret pending spend as zero or grant Pro to bypass missing policy. A rollback that removes this implementation requires a separately reviewed drain/fencing plan and restoration of both the prior canonical and cancellation definitions; preserve evidence. No live disable, migration application, deployment or rollback occurred during development.
