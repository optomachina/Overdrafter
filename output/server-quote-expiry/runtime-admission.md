# Local runtime admission result

Source under test: d68aafbf54b13f7f51cbaa7b45437cf33f9cdc8c.
No database or container was created; no migration or SQL fixture was executed.
No full application suite was rerun.

Docker is available (server 29.6.2), after read-only socket permission was granted.
All required images are cached:
- postgres 17.6.1.095: sha256:965e2dfb5a23a0d6541b6106541e777b303656ebabd4e878746b189d550c0a66
- storage-api v1.41.8: sha256:e43d86f81570b58e2a5d048d32694635f467cfd34348ede6fd7ceeb89825d842
- gotrue v2.187.0: sha256:8b0b3f68d9a8667e183b481ff74f5d72eedc1e8b70f6bde2aab1e5d79d16df62

The maintained runner in this branch is scripts/ovd510-disposable-replay.mjs.
It has fixed named suites; no arbitrary pgTAP or quote-selection-expiry mode.
The newer runner inspected read-only at task-2/release-next (HEAD 278122145914dadb1e0f7c89385d764965f9762f)
exports immutable source only under --ovd570-minimal-112. That mode rejects
additional flags and excludes migrations later than 20260924014552, including
20261002041305_enforce_quote_selection_expiry.sql. Running that mode would not
qualify this change. Neither runner was edited; runner ownership remains with
the integration lead.

## Exact dependency for the integration lead

Add a quote-expiry qualification stage to the maintained immutable runner, with
its pinned migration scope including 20261002041305 and its existing ownership,
resource-cap, internal-network, timeout, diagnostics, and cleanup checks intact.
After bootstrap/migration replay, run the committed fixture bytes using the
runner-owned psql connection (not a hosted URL):

    const test = readFileSync(join(root, "supabase/tests/quote_selection_expiry.sql"), "utf8");
    const tap = psql(test);

Require plan 32, exactly 32 `ok` lines, zero `not ok`, and successful finish and
rollback. Save the transcript, source SHA, image identities, runner hash, and
cleanup result. This is an invocation inside the existing runner, not a new CLI
flag already supported by the checked-out runner.

The equivalent psql command, ONLY inside that runner's newly created owned local
container, is:

    docker exec -i "$OWNED_FIXTURE_CONTAINER" psql -U postgres -d postgres -X -Atq -v ON_ERROR_STOP=1 < supabase/tests/quote_selection_expiry.sql

Container name/ephemeral authentication must come from the runner. Do not point
this command at an existing shared container or supply real credentials.

## Concurrency qualification still needed

In the same owned database, use committed synthetic fixture setup in a separate
transaction; do not merely repeat the rollback suite concurrently. Hold a job row
FOR UPDATE in session A. Set its offer deadline sufficiently ahead to start the
selection, then launch each RPC separately in session B before that deadline.
Observe session B waiting for session A's lock (pg_stat_activity/pg_locks), wait
past the deadline, release A, and assert B reports expiry and leaves the selection,
job status/pointer, and audit snapshot unchanged. Repeat independently for both
RPCs. Also race invalidation against selection and verify serializable outcomes.
Record server timestamps and observed lock waits, not sleeps alone as evidence.

Additional runtime controls: anonymous/service-role RPC denial, direct insert and
job pointer guard behavior, null clearing, unchanged pointer updates, unrelated
job updates, inclusive helper boundary, rollback and owned-resource cleanup.
None of these runtime outcomes is claimed by this admission check.
