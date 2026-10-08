# Offline quote selection expiry qualification

Run from a clean tracked checkout with the existing cached Docker fixture images:

```sh
node scripts/ovd510-disposable-replay.mjs --quote-selection-expiry
```

This exclusive mode exports committed source before fixture admission. It accepts
only the hash-bound 112-migration source baseline, task4's exact
`20261002041305_enforce_quote_selection_expiry.sql`, and the exact existing
32-assertion `quote_selection_expiry.sql`. It does not accept extra flags, arbitrary
SQL paths, database URLs, image builds, credentials, or production destinations.
This is a synthetic baseline qualification, not a production schema/data or image
qualification. The final source manifest and submitted-input inventory bind the
helper, fixture, migration, and exact generated concurrency SQL.

The existing rollback fixture covers deadline boundaries, future/null validity,
missing/invalidated sources, direct-write guards, authenticated effects and audit
counts. Eleven supplementary rollback assertions execute anon/service RPC denial,
service direct-write denial, and internal-member unchanged-pointer, unrelated edit
and null-clearing controls. These reuse the original fixture's setup bytes.

Six committed synthetic concurrency cases use distinct IDs/emails and one
container-local dblink session each. Each case requires an observed PostgreSQL
lock wait with the main session in `pg_blocking_pids`; a sequential call cannot
pass. For each selection RPC, the deadline case holds the job row, observes the
request waiting before its deadline, releases only after server wall time passes,
and asserts the expiry error and unchanged complete job/selection/audit state.
Both invalidation orderings are exercised: administrative invalidation commits
before selection resumes (selection rejects without further writes); selection
commits before invalidation resumes (invalidation succeeds, clears the pointer,
and preserves the expected historical selection/audit count). The actual guarded
administrative RPC uses only fixture-local capability/rollout rows.

Receipts in `output/ovd510-replay-<id>` retain TAP, race SQL digests/transcripts,
server timestamps, blockers, outcomes and state snapshots. Each remote session is
disconnected and checked absent. Committed race rows exist only in the owned
tmpfs database until the maintained runner removes its container. A failed check
never earns a passing receipt; cleanup status must be inspected independently.
No production migration activation or rollback is authorized by this fixture.
