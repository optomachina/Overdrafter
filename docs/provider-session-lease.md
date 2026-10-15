# Provider session lease (OVD-462)

Status: worker module as-built; database storage applied in migration window 1
as version `20261012212325`
([`supabase/migrations/20261012212325_ovd462_provider_session_lease.sql`](../supabase/migrations/20261012212325_ovd462_provider_session_lease.sql), recorded by #717).
The expand-phase rollback is kept as the pgTAP fixture
[`supabase/tests/fixtures/ovd462_provider_session_leases_rollback.inc`](../supabase/tests/fixtures/ovd462_provider_session_leases_rollback.inc).
The worker wires the RPC store into the generic provider route
(`worker/src/providerTaskLeasePort.ts`, OVD-381). Leases stay off until
`WORKER_PROVIDER_SESSION_LEASE=on`, which also requires
`WORKER_PROVIDER_SESSION_NAMESPACE_KEY`; see [Worker wiring](#worker-wiring).

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
  supported caller. Canonical table order: RPCs that touch both tables (acquire,
  revoke) touch `provider_session_bindings` before `provider_session_leases`;
  anything that locks both tables, such as the rollback, locks them in that
  order.
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
| `provider_blocked` | manual follow-up | yes | the provider blocked the account or session (adapter failure kind `blocked`) |
| `account_banned` | manual follow-up | yes | the provider banned the account (adapter failure kind `banned`) |
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
`challenge_required`, `provider_blocked`, `account_banned` and `corrupt_state`
(`PROVIDER_SESSION_REPORTABLE_OUTCOMES`). `PROVIDER_SESSION_ADAPTER_FAILURE_OUTCOMES`
(with `providerSessionOutcomeForAdapterFailure`) is the one total mapping from
the execution seam's terminal failure kinds to lease outcomes: `login_required`
to `login_required`, `challenge_required` (CAPTCHA and anti-bot challenges) to
`challenge_required`, `blocked` to `provider_blocked`, and `banned` to
`account_banned`. Every one blocks the binding until an operator clears it and
is never retried. `report_provider_session_lease_outcome`
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
| Postgres RPC | `worker/src/providerSessionLeaseRpcStore.ts` | production (RPCs exist since migration window 1; wired by OVD-464) |

The schema has one lease row per generation plus the
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
`ACCESS EXCLUSIVE` locks on both tables, bindings first (the canonical order,
so an in-flight RPC cannot deadlock with it), before the occupant check, so no lease
RPC can commit a new occupant between the check and the drops. The rollback
relies on the migration runner's transaction wrapper; by hand, use
`psql --single-transaction -v ON_ERROR_STOP=1`.

## Verification

- `worker/src/providerSessionLease.test.ts` and
  `worker/src/providerSessionLeaseRpcStore.test.ts`: the root `npm test`
  (vitest) runs them.
- `supabase/tests/provider_session_leases.sql` has 128 pgTAP assertions covering
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
  the drops would destroy; (f) with occupants present the guard refuses
  without the override, and refuses a table owner without `BYPASSRLS` (which
  forced RLS would show zero occupants) with or without the override; (g)
  rollback, 20 iterations: a revoke that committed first makes the rollback
  refuse; (h) rollback, 20 iterations: a rollback queued behind a revoke
  transaction that already holds the registry neither deadlocks nor drops the
  fence, and refuses once the revoke commits. CI runs it against the local Supabase stack from
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

## Worker wiring

`createSupabaseProviderTaskLeasePort` (`worker/src/providerTaskLeasePort.ts`)
adapts the lease manager to the OVD-464 pipeline port. The generic
provider route only builds it when `WORKER_PROVIDER_SESSION_LEASE=on`.

- `WORKER_PROVIDER_SESSION_NAMESPACE_KEY` holds the HMAC namespace key, hex or
  base64, at least 32 bytes. It is a secret: keep it in the secret store, and
  give every worker replica the same value so that they all derive the same
  binding. When the lease is on, the worker refuses to start without a valid
  key. If a config is built without one, no port is created and generic tasks
  stop with `session_lease_unavailable` before the preflight.
- Rotating the key derives new bindings. Any block recorded under the old
  bindings then no longer applies, so treat a rotation as an operator decision
  to clear blocks.
- Each provider has one storage-state slot per deployment, so the account
  material is the fixed slot label `default`. `accountRef` and
  `sessionBindingRef` are HMACs over provider, environment and slot, so they
  never collide across providers or environments.
- The adapter's terminal outcomes map to blocking lease outcomes:
  `blocked` becomes `provider_blocked`, `banned` becomes `account_banned`, and
  `login_required` and `challenge_required` keep their names. The binding then
  stays blocked until an operator clears it.
- Xometry keeps its specialized path and is not leased.
- Deploy wiring for the new secret belongs to the deploy track, and the
  setting stays off until it exists.

## Promotion record (migration window 1)

1. Done: the draft was promoted byte-for-byte to
   `supabase/migrations/20261012212325_ovd462_provider_session_lease.sql` (#717),
   and the draft copies were removed.
2. Done: the node-test byte-copy assertion and `scripts/ovd462-lease-race.mjs`
   read the migration file; the race test reads the rollback from its pgTAP fixture.
3. Done: applied in the window. The CI race test rehearses the rollback and
   re-apply on a scratch database.
4. Done: OVD-381 wires `createProviderSessionLeaseRpcStore(supabase)` into the
   generic provider route behind `WORKER_PROVIDER_SESSION_LEASE` (default off).
   Operator tooling alone uses `createProviderSessionLeaseOperatorRpcStore`.
   The contract phase (retention and sidecar-lock retirement) is a separate issue.
