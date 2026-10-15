# OVD-591 disposable SQL qualification

The new SQL files are acceptance inputs, **not executed database evidence**.
The cloud environment's official ECR request was forbidden. This runner never
requests an image or creates, resets, migrates or deletes a database. It must not
be used to route around that restriction. Parent may run it on an independently
authorized machine whose official image is already cached.

## Prerequisite and exact inputs

Use an exclusively owned synthetic fixture created by the authorized provisioning
owner from `public.ecr.aws/supabase/postgres:17.6.1.095`, with no published ports,
bind mounts or volumes; internal Docker networking, at most 2 CPUs, 3 GiB and 256
PIDs, bounded tmpfs storage. The complete selected baseline, existing canonical
ledger/resolver migrations and new CLI-generated OVD-591 migration must already
have applied successfully. Preserve application stdout/stderr and catalog/ACL
receipts. Do not use a shared or hosted Supabase database.

Container name must match `ovd591-[a-z0-9-]+`, labels must include
`ovd591.owner=ovd591-disposable` and `ovd591.source=<exact combined git commit>`.
The clean combined commit must contain both backend and these fixtures. A source
label is an admission assertion, not proof that SQL was applied: supply a retained
provisioning JSON receipt with `source`, `containerId`, `imageId`,
`migrationVerdict:"passed"`, `catalogVerdict:"passed"`, and `appliedInputs` array
of `{path,sha256}` for every actually submitted migration, `baselineSelection` describing the selected schema scope, and `evidence` with
`migration` and `catalog` objects `{path,sha256}` pointing to nonempty raw execution
and catalog receipts. The runner checks and copies those evidence bytes. The runner matches supplied hashes to
committed files and requires the canonical ledger migration, OVD-513 record/resolver migration and
exact generated `20261002090339_add_atomic_capability_window_attention_persistence.sql`.
This establishes qualification of the selected baseline, not every current schema
branch. All actually applied migration paths/hashes must be retained. The independent reviewer must
check completeness of baseline selection and raw successful application records;
a self-asserted JSON verdict is not database proof.

```
node --test scripts/ovd591-sql-qualification.node-test.mjs
node scripts/ovd591-sql-qualification.mjs ovd591-<owned-id> /absolute/new/evidence-directory /absolute/provisioning.json
```

The output directory must not exist. The runner records exact commit, all
migration/fixture/runner SHA-256 inputs, runtime/container image identity,
provisioning receipt, timestamps, raw stdout, assertion counts and final status.
A failed SQL process preserves stdout/stderr; a failed, incomplete, skipped or
TODO TAP transcript never passes. `psql -X`, ON_ERROR_STOP, bounded statement
and host timeouts are mandatory. No ambient URL or credential is consulted.
Concurrency connections use IPv4 loopback inside that same fixture only. The
runner passes the existing container `POSTGRES_PASSWORD` through a session-only
base64 setting, without credential values in host arguments or submitted SQL.
No credential is generated or changed. Normal `dblink_connect` must authenticate
with that password; missing credentials, unavailable password-authenticated TCP,
or missing dblink/pgTAP fail qualification. Roles and authentication settings are
never changed, and there is no non-password fallback.

## What the fixtures check

The runner first executes the unchanged historical
`capability_observation_ledger.sql` and `capability_observation_rpcs.sql` rollback
suites to protect the replaced canonical primitive and existing service boundary.
Their exact bytes/hashes are included in the input manifest. Every psql process
receives the recorded `PGOPTIONS` value
`-csearch_path=public,extensions,pg_catalog -ctimezone=UTC -cstatement_timeout=20000`;
SQL files are submitted unchanged, without an untracked prefix. Existing historical
concurrency is not claimed; six new actual-overlap scenarios are recorded below.

`capability_runtime_persistence.sql` wraps all changes in rollback. It checks
claim replay/status recovery without another grant, cross-window resource
exclusion, canonical window alias rejection, fence mismatch, exact completion
replay and changed replay conflict. A test-only trigger fails the **terminal**
window update after append; row absence proves append rollback. Catalog and actual
role calls independently check forced RLS, private table/helper denial, service
RPC grant and denied client calls. Attention checks required/null/malformed
payloads, canonical expiry binding, retained evidence, separate CAS version,
replay, stale version rejection, cursor/evaluation rollback and outbox insertion
rollback followed by one retained intent. A two-second canonical expiry makes
current evidence due; stale CAS reuses identical evidence/revision, repeated stale
evaluation emits nothing and leaves the due list, then new canonical evidence
causes recovery and a subsequent expiry causes a distinct recurrence. Test-only
nontransactional sequence markers prove suffix injection actually ran after the
cursor/outbox writes; rollback restores both and permits exact-input retry. Test-only triggers are never production
migration features.

`capability_runtime_persistence_concurrency.sql` uses two asynchronous dblink
sessions and the real `(591,1)` lock. It requires actual `pg_blocking_pids` evidence
that both contenders are blocked by the coordinator before release; fixed sleep
alone cannot establish overlap. Cases cover duplicate claim grants, reservation
completion against a legacy writer attempting the reserved revision, unchanged
generation CAS, and completion whose lease expires **after** its observed lock
wait, an admissible legacy writer racing a distinct reservation, and a delayed
attention evaluation blocked while a newer ledger append commits. The expiry case deliberately waits 2.2 seconds on a two-second lease and proves its initial observed wait preceded expiry.
Raw PID/blocker/wait/timestamp/result records are retained as TAP comments.
Helpers are dropped; immutable synthetic ledger/window records remain for the
fixture owner to destroy with the entire owned fixture. Failed runs may retain
helpers too; do not rerun against that dirty fixture.

## Separate verdicts and remaining requirements

Report migration/catalog, ACL/RLS, transactional rollback/replay, each real race,
transport readiness and cleanup independently. Preserve failed attempts and exact
inputs. Node harness tests establish admission/accounting behavior only. Static
SQL review establishes no database behavior. This suite does not prove provider
resource disposal (it accepts the trusted worker assertion), account session
isolation beyond the persistence key, actual probe safety, external delivery,
production PostgREST configuration or hosted migration safety.

Additional composed-source qualification remains required: these persistence
transitions through the real provider bridge. The SQL fixture covers the storage
invariants independently, alongside the required historical ledger/RPC regressions.
Do not call this subset full 1.1 qualification. Apply operational
disable by disabling consumers and revoking new RPC execute privileges while
preserving history; never restore an old writer while reservations remain.

The provisioning owner owns exact fixture cleanup. Attach an observed post-cleanup
inventory for container/network/storage identities; this runner does not claim
cleanup merely because tests ended. No production migration or live enablement is
authorized by this document.

## Explicit persistent psql transport (source-only until independently qualified)

The original dblink SQL, password wrapper and failed dblink receipts remain
unchanged. A separate reviewed transport can be selected only by the explicit
`--concurrency=psql` argument after the three required arguments. Omitting it
still selects dblink. There is no retry or automatic fallback between modes.
This choice does not authorize provisioning or execution and establishes no
password-authenticated TCP, dblink or hosted/PostgREST readiness.

The alternative passes the identical clean-source/container/network/provisioning
admission before any database process starts. The first three suites are submitted
unchanged. The concurrent stage uses three persistent `docker exec -i` psql
processes with the same container-default OS identity, explicit `postgres` role
and database, existing default Unix socket, `-X -Atq -w` and `ON_ERROR_STOP=1`.
It does not inspect or configure credentials, use the password wrapper, change
roles/HBA, or obtain a different connection. It rejects non-null server/client
network addresses, wrong session/current role/database, and duplicate backend
PIDs. If the existing direct route does not work, qualification fails.

`scripts/ovd591-psql-concurrency.mjs` drives the checked-in closed phase manifest
`supabase/tests/capability_runtime_persistence_psql.phases.json`. It checks the
original SQL hash and records the phase/runner hashes. The synthetic preservation
test compares every retained SQL byte range, all 28 full assertion expressions,
fixed helper bodies, six actor operations and result associations with the original.
There is no runtime regex rewriting of SQL. The removed parts are exclusively
the dblink extension/connection/send/result/disconnect transport. Original comments
mentioning dblink are retained as provenance, not executed dblink machinery.

All three sessions must return independent identity receipts before fixture setup
or the two-second lease. Each actor operation is an autonomous statement. A random
per-command acknowledgment follows executed SQL; setup and each preceding phase
end only after the coordinator's `BEGIN` and advisory lock execute. Both actor
commands are submitted before waiting for results. The original overlap helper,
150×20ms SQL observation loop, `pg_blocking_pids`, database timestamps, 2-second
lease and 2.2-second locked sleep remain intact. In addition to original pgTAP,
the host requires exactly the expected actor PIDs blocked by the coordinator.
The delayed-evaluator append stays on the locked coordinator connection before
commit. Actor results are inserted through escaped PostgreSQL text COPY data;
actor output is never interpolated as executable SQL or psql commands.

Only the coordinator produces TAP. All 28 ordered assertions must pass, with no
skip/TODO. Actor business SQLSTATE is retained separately from process failure.
Stderr, malformed/duplicate/stale acknowledgment, missing or extra result rows,
premature exit, phase timeout, incorrect identity/overlap or remaining actor
backend fails the run. Each statement keeps its 20-second database timeout;
the concurrent stage has a 120-second deadline, 25-second phase bounds, and an
8,000,000-byte aggregate session output ceiling. Shutdown has its own bounded
25-second observation interval. No host sleep is used as race evidence.

Raw submitted commands, stdout/stderr, identities, exit statuses, overlap/result
receipts and shutdown disposition are retained in `psql-concurrency-evidence.json`
and `psql-{coordinator,a,b}.{stdout,stderr}`. Original coordinator `# overlap` and
`# result` lines remain in the normal concurrent-suite stdout artifact. Helpers
are dropped only after both actors exit and the coordinator observes their PIDs
absent. Coordinator's normal psql exit is recorded separately; final backend and
fixture inventory is still the runtime owner's responsibility. On failure the
runner closes its own inputs, awaits bounded process exits and records unresolved
termination. A last-resort signal to its own Docker CLI is containment only,
never proof that the backend stopped. Failed or unconfirmed shutdown cannot be
reported as a race pass or clean fixture; no helpers are dropped after failed
race evidence and no rerun against a possibly dirty fixture is authorized here.

Source-only checks:

```
node --test --test-isolation=none --test-reporter=tap scripts/ovd591-psql-concurrency.node-test.mjs scripts/ovd591-sql-qualification.node-test.mjs
```

The new tests use inert Node child processes for framing, stderr, premature exit,
timeout, overflow and duplicate/stale responses; a simulated session topology
checks ordering, actor identity rejection and cleanup denial. Simulated PID/socket
receipts are explicitly test data. They prove neither database authentication nor
lock overlap. Future execution needs a separately admitted fixture, independent
review of this exact source, real identity/overlap receipts and separate cleanup
qualification. Existing unresolved Mac environment inventory questions remain.
