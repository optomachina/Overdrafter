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
environment is rejected with `binding_mismatch`. In Postgres this is enforced by
a second advisory lock on the `sessionBindingRef` and by the
`provider_session_bindings` registry (primary key `session_binding_ref`, which
every lease row references), so concurrent acquires of one binding under two
keys cannot both succeed. Identity objects are parsed
exact-key, so extra fields such as storage state are rejected, not ignored.
Use `deriveProviderAccountRef` and `deriveProviderSessionBindingRef` with a
worker-held key of at least 32 bytes. Raw account material is consumed during
derivation and never returned.

## Lifecycle

```
acquire ──► active ──renew (≤ maxRenewals, ≤ maxDuration)──► active
              │                                               │
              ├─ release ──► released (idempotent)            │
              ├─ expiry (also after renewal is denied) ──► expired ◄─┘
              ├─ reportOutcome(outcome) ──► blocked ──operator clear──► cleared
              └─ operator revoke ──► revoked, plus a new blocked row (owner_revoked)
```

- **Acquire.** Atomic per binding key (Postgres: transaction advisory lock and
  the unique partial index `... where state in ('active','blocked')`). Every
  RPC sets `lock_timeout = 2s`; a lock wait beyond that is an RPC error, which
  the manager treats as unavailable or unconfirmed (fail closed).
  Possible results: `acquired`, `contended` (with `retryAfterMs` capped at the
  ttl and no owner details), `manual_follow_up`, `rejected` or `unavailable`.
  A repeated acquire with the same holder token is idempotent. The manager uses
  this to retry a lost response once without creating an orphan lease.
- **Renew.** Bounded by `ttlSeconds` (5–300), `maxRenewals` (0–720) and
  `maxDurationSeconds` (≤ 4 h). These limits are enforced on both sides. A
  renewal past the budget is denied with `renewal_exhausted` (terminal
  `lease_lost`; the worker stops), but the row stays `active` until its current
  `expires_at`. The holder may still be running up to the deadline it was given,
  so no one else is granted the binding before then; expiry recovery or the
  holder's release then ends the row.
- **Local deadline.** It is `request start + server expires_in_ms − safetyMarginMs`,
  which makes it immune to clock skew. The local holder therefore stops before
  the server could grant the binding to anyone else. Store errors during renew
  are *unconfirmed* and the lease stays usable only until that deadline.
- **One RPC per transaction.** Deadlock freedom (key lock first, then at most
  one session binding lock) assumes each lease RPC runs in its own
  transaction. PostgREST does this for every RPC call, and it is the only
  supported caller.
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

Revoking an active holder ends the holder's row as `revoked` (its renew,
report and release see `owner_revoked`) and records the block as a new
`blocked` row with a fresh generation. Revoke returns that generation, and it
is the one the clear RPC takes, so revoked authority and the authority before
revocation never share a generation.

A holder may report only `missing_session`, `login_required`,
`challenge_required` and `corrupt_state`
(`PROVIDER_SESSION_REPORTABLE_OUTCOMES`). `report_provider_session_lease_outcome`
and the memory store reject `owner_revoked` with `invalid_outcome`, so only the
operator revoke RPC can set that fence.

Operator actions (`revokeBinding`, `clearBlock`) are built only by
`createProviderSessionLeaseOperatorRpcStore`; the worker factory
`createProviderSessionLeaseRpcStore` exposes acquire, renew, release and report
only. Both operator RPCs require an `actorRef` and `reasonRef` (opaque, task-ref
format, never names or e-mail addresses), and the row records them
(`revoked_by_ref`/`revoke_reason_ref`, `cleared_by_ref`/`clear_reason_ref`).
Revocation must name the holder's `sessionBindingRef`, otherwise it is rejected
with `binding_mismatch`.

**Operator RPC decision for 1.0 (pending Blaine's confirmation).** The operator
RPCs (`revoke_provider_session_binding`, `clear_provider_session_binding_block`)
stay granted to `service_role` only and are called from the admin server path,
never from the worker. Each call requires opaque actor and reason references,
which the row records. A dedicated operator database role is deferred to 1.1,
because it adds a new credential and new deploy wiring.

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

The proposed schema has one lease row per generation plus the
`provider_session_bindings` registry, which maps each `sessionBindingRef` to
its key and holds the per-key `next_generation` counter, so generations stay
strictly increasing after lease history is deleted. On both tables RLS is
enabled and forced with no policies, and every table privilege is revoked from
`PUBLIC`, `anon`, `authenticated` and `service_role`. Six `SECURITY DEFINER` RPCs
with `set search_path = ''` and `set lock_timeout = '2s'` are executable only by
`service_role`. Because RLS is forced, the function owner must have
`BYPASSRLS` or be a superuser (Supabase `postgres` has `BYPASSRLS`); pgTAP
asserts this. The identity validator is `private.provider_session_lease_identity_ok`
and is not executable by any API role.

The rollback refuses to run while any `active` or `blocked` row exists, because
blocked rows are manual-follow-up fences. Resolve or export them first, or set
`set local ovd462.rollback_discard_occupants = 'confirmed'` in the same
transaction. The guard first refuses any running role without `BYPASSRLS` (or
superuser), because forced RLS would hide the occupants from it. It then takes
`ACCESS EXCLUSIVE` locks on both tables before the occupant check, so no lease
RPC can commit a new occupant between the check and the drops. The rollback
relies on the migration runner's transaction wrapper; by hand, use
`psql --single-transaction -v ON_ERROR_STOP=1`.

## Verification

- `worker/src/providerSessionLease.test.ts` and
  `worker/src/providerSessionLeaseRpcStore.test.ts`: the root `npm test`
  (vitest) runs them.
- `supabase/tests/provider_session_leases.sql` has 122 pgTAP assertions covering
  catalog, grants, RLS denial, owner `BYPASSRLS`, lock settings, the binding
  registry backstop, contention, isolation, wrong-owner and null fencing inputs,
  bounded renewal and the hard cap, crash/expiry recovery, idempotent release,
  blocking outcomes, cleared and revoked generations, operator attribution,
  generation monotonicity after history deletion, input rejection and the
  rollback (with the operator override; the refusal path is asserted by the
  node test). pgTAP runs in one session, so it cannot exercise races between
  connections; the next item does.
- `scripts/ovd462-lease-race.mjs` races two independent psql connections
  against the draft in a scratch database (dropped afterwards). A postgres
  coordinator holds an advisory lock as a start gate, waits until both racers
  are blocked on it, then releases them together, and checks the stored rows
  after every iteration. Scenarios: (a) same key acquire, 30 iterations: one
  `acquired`, the other `contended` or 55P03, never two active rows; (b) a
  holder keeps the key lock in an open transaction, 20 iterations: the
  contender is observed waiting on that lock and fails with 55P03 after about
  2s; (c) one `session_binding_ref` under two keys, 30 iterations: one grant,
  the other `binding_mismatch`, one registry row; (d) expiry, 30 iterations:
  a stale renew races a new acquire, the stale holder gets `lost` or
  `not_owner`, a second renew and a release change nothing, and the generation
  strictly increases; (e) rollback, 20 iterations: while a rollback
  transaction holds its table locks between the guard and the drops, a
  concurrent revoke waits and fails with 55P03 instead of committing a fence
  the drops would destroy; (f) the rollback guard refuses a role without
  `BYPASSRLS`, with or without the override. CI runs it against the local Supabase stack from
  `scripts/run-supabase-policy-tests.mjs` after pg_prove. Locally,
  `node scripts/ovd462-lease-race.mjs --target docker` runs it against a
  disposable pinned postgres container with no published port.
  - **CI without the migration.** CI stages only `supabase/tests`, and
    `scripts/run-supabase-policy-tests.mjs` rejects skipped TAP. So the test
    does not skip. It installs `fixtures/ovd462_provider_session_leases.inc`
    (a byte copy of the draft, enforced by
    `scripts/run-supabase-policy-tests.node-test.mjs`) inside its rolled-back
    transaction when `public.provider_session_leases` is absent.
    `fixtures/ovd462_provider_session_leases_rollback.inc` is a byte copy of the
    rollback, enforced the same way.
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
   Operator tooling alone uses `createProviderSessionLeaseOperatorRpcStore`.
   The contract phase (retention and sidecar-lock retirement) is a separate issue.
