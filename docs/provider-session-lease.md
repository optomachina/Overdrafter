# Provider session lease (OVD-462)

Status: worker module as-built; database storage **proposed, not applied**.
The migration needs Blaine's migration window 1 (`blaine-window`). It is
intentionally outside `supabase/migrations/` and lives at
[`docs/migration-drafts/ovd-462.sql`](migration-drafts/ovd-462.sql) with its
[rollback](migration-drafts/ovd-462.rollback.sql).

## Purpose

A provider session binding (one provider-local browser storage/profile slot
for an approved account in one runtime environment) must have exactly one
owning task at a time. The lease stops two tasks, or two routes, from using
the same credentials and browser state at once. Losing the lease is terminal
for the task, and the task never falls back to another session.

Out of scope: authentication recovery, MFA entry, CAPTCHA bypass, account
creation, live provider probes, permit authorization, adapter routing and
central worker integration (OVD-464).

## Identity

| Field | Format | Meaning |
| --- | --- | --- |
| `provider` | `^[a-z][a-z0-9_]{1,31}$` | provider slug (`xometry`, `fictiv`, ...) |
| `accountRef` | `acct_<32 hex>` | HMAC-SHA256 of the approved account, namespaced by provider |
| `environment` | `production` / `staging` / `development` / `test` | runtime environment |
| `sessionBindingRef` | `sb_<32 hex>` | HMAC-SHA256 of provider + accountRef + environment + slot |
| `taskRef` | `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` | owning task; for dispatch it is the permit's reserved `lease:<permit id>` |
| `holderToken` | random UUID per acquire | proof of the exact owning process; never logged |
| `generation` | strictly increasing per binding | fencing token |

The exclusive key is `(provider, accountRef, environment)`. A `sessionBindingRef`
belongs to exactly one key: reusing it under another provider, account or
environment is rejected with `binding_mismatch`. Identity objects are parsed
exact-key, so extra fields such as storage state are rejected, not ignored.
Use `deriveProviderAccountRef` and `deriveProviderSessionBindingRef` with a
worker-held key of at least 32 bytes. Raw account material is consumed during
derivation and never returned.

## Lifecycle

```
acquire ──► active ──renew (≤ maxRenewals, ≤ maxDuration)──► active
              │                                               │
              ├─ release ──► released (idempotent)            │
              ├─ expiry / renewal exhausted ──► expired ◄─────┘
              ├─ reportOutcome(outcome) ──► blocked ──operator clear──► cleared
              └─ operator revoke ──► blocked (owner_revoked)
```

- **Acquire.** Atomic per binding key (Postgres: transaction advisory lock and
  the unique partial index `... where state in ('active','blocked')`).
  Possible results: `acquired`, `contended` (with `retryAfterMs` capped at the
  ttl and no owner details), `manual_follow_up`, `rejected` or `unavailable`.
  A repeated acquire with the same holder token is idempotent. The manager uses
  this to retry a lost response once without creating an orphan lease.
- **Renew.** Bounded by `ttlSeconds` (5–300), `maxRenewals` (0–720) and
  `maxDurationSeconds` (≤ 4 h). These limits are enforced on both sides. The
  renewal past the budget ends the lease.
- **Local deadline.** It is `request start + server expires_in_ms − safetyMarginMs`,
  which makes it immune to clock skew. The local holder therefore stops before
  the server could grant the binding to anyone else. Store errors during renew
  are *unconfirmed* and the lease stays usable only until that deadline.
- **Release.** Idempotent for the exact owner. A stale owner's release after a
  regrant is a no-op.
- **`runWithLease`.** Acquires the lease and sends a heartbeat every
  `heartbeatIntervalMs`. A watchdog fires at the local deadline. The
  operation's `AbortSignal` aborts on loss, the operation calls `assertHeld()`
  before every provider action, and the lease is released in `finally`.

## Outcomes

| Outcome | Disposition | Blocks binding | Source |
| --- | --- | --- | --- |
| `missing_session` | manual follow-up | yes | adapter `ProviderSessionOutcomeError` |
| `login_required` | manual follow-up | yes | `VendorAutomationError("login_required")` or explicit |
| `challenge_required` | manual follow-up | yes | MFA/CAPTCHA/challenge; `captcha`, `anti_detection_block` |
| `owner_revoked` | manual follow-up | yes | operator `revoke_provider_session_binding` |
| `corrupt_state` | manual follow-up | yes | adapter `ProviderSessionOutcomeError` |
| `lease_lost` | terminal | no | expiry, renewal exhausted, fencing, unconfirmed past deadline |

A blocked binding answers every acquire with `manual_follow_up` until an
operator clears that exact generation (`clear_provider_session_binding_block`).

## Redaction

Logs, permits (`lease.toJSON()`), `util.inspect`, errors and diagnostics carry
only `provider`, `environment`, `generation`, `taskRef` and a 12-hex
`bindingTag`, a one-way SHA-256 of the identity. They never carry `accountRef`,
`sessionBindingRef`, holder tokens, raw account material, cookies, storage
state or profile paths. The RPC store replaces client errors with a fixed
message, because PostgREST details can echo arguments.

## Storage

| Implementation | File | Use |
| --- | --- | --- |
| In-memory | `worker/src/providerSessionLeaseMemoryStore.ts` | tests and local fakes. It mirrors SQL semantics but is not a cross-process lock |
| Postgres RPC | `worker/src/providerSessionLeaseRpcStore.ts` | production after migration window 1 |

The proposed schema has one row per generation. RLS is enabled and forced with
no policies, and every table privilege is revoked from `anon`, `authenticated`
and `service_role`. Six `SECURITY DEFINER` RPCs with `set search_path = ''`
are executable only by `service_role`.

## Verification

- `worker/src/providerSessionLease.test.ts` and
  `worker/src/providerSessionLeaseRpcStore.test.ts`: the root `npm test`
  (vitest) runs them.
- `supabase/tests/provider_session_leases.sql` has 73 pgTAP assertions covering
  catalog, grants, RLS denial, contention, isolation, wrong-owner mutations,
  bounded renewal, crash/expiry recovery, idempotent release, blocking outcomes
  and input rejection.
  - **CI without the migration.** CI stages only `supabase/tests`, and
    `scripts/run-supabase-policy-tests.mjs` rejects skipped TAP. So the test
    does not skip. It installs `fixtures/ovd462_provider_session_leases.inc`
    (a byte copy of the draft, enforced by
    `scripts/run-supabase-policy-tests.node-test.mjs`) inside its rolled-back
    transaction when `public.provider_session_leases` is absent.
  - **After promotion.** The psql `\if` guard is false and the same assertions
    run against the migrated schema. When promoting, keep the fixture as a byte
    copy of the migration (as OVD-684 does), or drop the include and the guard.

## Promotion checklist (migration window 1)

1. `npm run migration:next` and copy `docs/migration-drafts/ovd-462.sql`
   byte-for-byte to `supabase/migrations/<ts>_ovd462_provider_session_leases.sql`.
2. Repoint the node-test byte-copy assertion at the migration file.
3. Apply in the window, run the pgTAP suite, and run the rollback rehearsal
   (`ovd-462.rollback.sql` then re-apply) on a disposable database first.
4. OVD-464 wires `createProviderSessionLeaseRpcStore(supabase)` into the worker.
   The contract phase (retention and sidecar-lock retirement) is a separate issue.
