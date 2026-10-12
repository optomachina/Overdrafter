# OVD561 pending finalization persistence and executor

This staged source supplies the concrete private PostgreSQL persistence missing
from the default-off first prepared-dimension result bridge. It adds no active
migration, public route, role grant, key, credential, live connection or worker
activation. No SQL or native qualification is claimed by its Node tests.

## Runtime composition

`createNativeResultRepository` combines the existing trusted registered-byte
reader with `createNativeFinalizationPersistence`. The latter checks out an idle
client from an injected dedicated owner pool (structurally compatible with
node-postgres), starts its own READ COMMITTED transaction and executes exactly
one of these parameterized statements:

| Operation | Fixed private function | Parameters in order |
| --- | --- | --- |
| Load | `load_native_pending_finalization(uuid,uuid)` | task ID, attempt ID |
| Persist | `persist_native_pending_finalization(uuid,uuid,text,text,text,uuid)` | task ID, attempt ID, exact payload text, hex signature, exact candidate context text, idempotency UUID |
| Finalize | existing `finalize_native_result(text,text,text,uuid)` | exact payload text, hex signature, exact candidate context text, idempotency UUID |

All functions are in `engineering_private`. No arbitrary SQL, identifier, role,
connection string, public/service-role RPC, signing key or worker URL enters the
adapter's request interface. The SQL itself requires `current_user = postgres`;
the adapter never sets a role. An authorized deployment must separately provide
a dedicated, correctly configured owner pool and registered-object reader.
Neither that pool nor credentials are created or used by this source change.

Both the repository and existing finalizer must explicitly receive
`enabled: true` from trusted server composition. Leave both absent/false until
activation is authorized. The finalizer still receives its server-owned key;
this adapter never reads/provisions a key or changes verifier authority. Jev
has no authority over stop, retry, verification or finalization.

Each adapter invocation has a maximum/default 30-second deadline, including
pool acquisition and COMMIT. Caller cancellation also interrupts it. SQL uses
local synchronous commit (WAL flush before acknowledgment), 30-second statement
and five-second lock timeouts without changing session or global defaults. The
server's fsync/storage durability still requires operator qualification; a pool
session's asynchronous-commit default cannot silently weaken this adapter. The pool contract requires exclusive idle client leases and
`release(true)` to destroy the connection. A driver error, cancellation, invalid
SQL response or missing COMMIT acknowledgment destroys that lease instead of
returning an uncertain transaction to the pool or sending a queued rollback.
The adapter performs no retry. A late checkout is destroyed without any query;
late query completion cannot dispatch a successor statement.

## Durable state and replay

Apply `ovd561-pending-forward.sql` only after the staged OVD561 forward source
has been authorized and qualified. The pending table is private, RLS-enabled,
owner-only and immutable under UPDATE/DELETE. One row per attempt retains exact
payload/context text and signature/key. Separate retry attempts retain separate
history. Existing OVD561 still permits only one successful completion per task.

Persistence validates task/attempt and context-digest binding, inserts only if
absent, then returns the committed winner. A concurrent writer waits on the
attempt's unique index; the next READ COMMITTED statement reads its winner.
The bridge rejects a different winner and requires explicit replay. No pending
row grants native execution, qualified-stop status, result eligibility or
verification authority. The unchanged finalization SQL checks HMAC, current
attempt/fence, qualified stop, registry generations, receipt age, authority,
lineage and all atomic completion predicates.

Persistence resolves only after COMMIT acknowledgment. A lost persistence reply
may nevertheless have committed: load the existing immutable envelope and invoke
explicit bridge replay. A lost finalization reply uses the same path; the exact
existing SQL arguments return the original completion. Never regenerate a
receipt or key to recover a lost outcome. If a pending receipt has expired before
any successful finalization, OVD561 denies it; this adapter does not refresh
signatures, delete history or invent recovery authority.

## Expected outcomes

| Input/event | Expected result |
| --- | --- |
| Either default-off gate | Error before SQL dispatch |
| Load missing task/attempt envelope | `null`; no completion claim |
| First durable persist | Exact stored envelope after acknowledged COMMIT |
| Same attempt competing persist | Original winner returned; bridge detects conflict |
| Invalid/foreign envelope | Rejected before SQL or `ovd561_pending_binding_mismatch` |
| Caller is not database owner | SQL `42501`, `ovd561_pending_owner_required` |
| Repeatable-read/serializable persist | SQL `42501`, `ovd561_pending_read_committed_required` |
| Uncertain write/COMMIT | `Native SQL write outcome unknown; explicit reconciliation required.` |
| Finalize succeeds | Existing `finalized` receipt with task, attempt, fence, snapshot and successor fields |
| Exact replay after committed finalization | Original completion, even after receipt expiry |
| Conflicting/stale/expired new finalization | Existing OVD561 denial; pending history preserved |
| Reverse with retained pending row | `ovd561_pending_reverse_requires_empty_history`; no history removed |

Errors from the finalizer may wrap executor errors as unknown finalization.
Operators must not interpret either timeout/cancellation or driver rejection as
proof of rollback, stop, freed occupancy or permission to rerun native work.

## Inert checks and required SQL qualification

Run from the repository root:

```sh
./node_modules/.bin/vitest run server/engineering/native-result-persistence.test.ts server/engineering/native-result-finalization.test.ts server/engineering/native-result-receipt.test.ts server/engineering/native-result-bytes.test.ts server/engineering/native-result-registration.test.ts
./node_modules/.bin/tsc --noEmit -p tsconfig.server.json
./node_modules/.bin/eslint server/engineering/native-result-persistence*.ts server/engineering/native-result-executor.ts server/engineering/native-result-repository.ts
```

Tests use retained synthetic result bytes, ephemeral in-memory signing bytes and
a simulated SQL driver. They prove adapter ordering/binding, transaction response
handling and source composition, not PostgreSQL locking, privileges, durability
or cancellation. No SQL driver package is installed by this slice.

Before any deployment, an authorized disposable PostgreSQL qualification must:

1. Apply the reviewed staged prerequisites and this forward file as owner; verify
   the two functions are invoker-security with empty search_path, RLS is enabled,
   and PUBLIC/anon/authenticated/service_role/engineering_native_verifier lack
   effective table/function access. Test direct nonowner function calls too.
2. Persist exact UTF-8 payload/context strings (including formatting), read them
   across separate connections/restarts, and compare their hashes and signature.
   Reject null/malformed/foreign task/attempt and context substitution.
3. Race separate transactions with identical and differing envelopes for the
   same attempt. Confirm exactly one immutable row, both receive its winner and
   no duplicate automatic finalization. Reject stronger-isolation persistence.
4. Interrupt before/after persistence COMMIT and finalization COMMIT; reconnect
   and recover only via the original saved envelope/key. Prove no retry inside
   the adapter and no leaked active transaction reenters the pool.
5. Run existing OVD561 authority/stop/fence/generation/expiry/replay/concurrency
   cases through this exact executor. Assert snapshot/task/successor atomicity
   and unchanged occupancy; a simulated driver cannot establish these facts.
6. Verify UPDATE/DELETE immutability and reverse rejection with populated
   history. On an empty fixture, race insertion against reverse: the reverse's
   ACCESS EXCLUSIVE lock must precede its emptiness check, preventing lost
   committed history. Verify empty reverse/reapply and dependency ordering.

Runtime ownership, keys, driver/pool semantics and PostgreSQL behavior remain
unqualified until that evidence exists. Real credentials, security changes,
production rollout and Windows/native execution require separate authorization.
