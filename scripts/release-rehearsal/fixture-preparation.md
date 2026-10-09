# Cached-only synthetic release adapter

This adapter is source for OVD-658, child of OVD-635. It does not acquire tools or
images and does not establish database rehearsal proof through fake-process tests.
Import and `inspectPrerequisites` perform no process or resource operation.
`createCachedFixtureAdapter` creates no resource until `startTarget` is called.
Only a separately admitted controller may call the runtime operations.

## Exact production input contract

```js
createCachedFixtureAdapter({
  plan,             // core.buildPlan output; canonical content hash rechecked
  sourceFiles,      // Map(relative input path, Buffer); every plan input hash checked
  platform: {
    manifestBytes,  // exact free-quote-platform-manifest.json bytes
    files,          // Map('auth/'+name or 'storage/'+name, Buffer), no extra entries
    profileBytes,   // exact pinned free-quote-ci-profile.mjs bytes
  },
  tools: {
    docker: { path, sha256 }, // absolute regular non-symlink local binary
    cli: { path, sha256, version: '2.78.1' }, // Linux/amd64 binary, staged not host-run
    socket,          // canonical local Unix socket, inode/device bound
  },
  image: { id, digest, entrypoint, cmd }, // immutable cached image receipt
  session: {
    schema: 'overdrafter.synthetic-postgres-session.v1', role: 'postgres',
    expected: { sessionUser: 'postgres', currentUser: 'postgres',
      isSuperuser: false, createRole: /* explicitly chosen boolean */,
      memberships: /* exact sorted synthetic role membership names */ },
  },
  catalog: { bytes, sha256 }, // reviewed read-only catalog.sql from integration
  races: {
    profileManifestBytes, // exact free-quote-ci-source.json bytes
    helperFiles,          // Map(path, Buffer), exact five pinned race helpers
  },
  parentDirectory,           // canonical, current-user owned mode0700 directory
  admission: {
    schema: 'overdrafter.release-rehearsal-admission.v1',
    qualification: 'synthetic-only', sourceCommit, planSha256,
    platformManifestSha256, dockerSha256, cliSha256, imageId, imageDigest,
    sessionSha256, catalogSha256, expiresAt,
  },
});
```

`sessionSha256` hashes UTF-8 `JSON.stringify(session, null, 2) + '\n'`.
The caller should serialize the exact session contract in this order and retain it.
Plan hashing canonicalizes object keys and preserves arrays as core does.
Runtime source/receipt admission and publication identity are controller duties;
matching hashes alone do not create permission to execute.

Real preflight requires candidate `bbd78c05e726ce55f4fff1e4fd5fdec7bdd33f3b`,
139 canonical migrations and 174 profile inputs. It requires platform manifest
SHA-256 `5513f6b047d5519bc8b381803b3caf483070180b88b24b486a9c1f1486315a78`
and profile SHA-256
`3e91b9e2dc4ff47c0531a0a3c54b5f8e41cb6b5458f08b68824fc8f5565c89c6`.
Platform input is authentic 68 auth plus 56 storage migration files, matching every
manifest hash. The adapter copies bytes before use, not mutable input references.
No private owner ledger, production endpoint, customer data or real credential is
an input. Unknown option fields such as connectionUrl or env are rejected.

The only test pin override is a programmatic `validatePins` function in the second
dependency argument, paired with a non-default injected process executor. It cannot
be selected via configuration JSON or the default real executor. Such receipts
say `fake-transport-only`; invented SQL in these tests is not platform schema proof.
The production `inspectPrerequisites` never accepts this override. Any injected
dependency, including an executor without a pin override, forces every transport
receipt to `fake-transport-only`. A programmatic monotonic `now` test hook likewise
requires an injected non-default executor; no clock override is accepted by JSON
or the real executor.

## Runtime API and receipt semantics

- `startTarget(label)` returns `{target, session, receipts}`. The opaque `target`
  object must be retained; copying or reconstructing it is rejected. Each target is
  a separate fresh database container/cluster, preserving role/default-ACL isolation.
- `apply(target, {files, expectedPending, cliMode:'apply'|'dry-run', fault:null|descriptor})`
  stages exact selected history bytes into a fresh synthetic CLI project. `files`
  contains the full local history for this stage, including already-applied baseline
  migrations; `expectedPending` separately lists expected new entries. Both use
  `{path,version,sha256}`. Baseline first, then full/cumulative canonical history
  with absent entries pending, preserves a non-prefix synthetic baseline.
  Every actual apply first runs real CLI dry-run and compares exact ordered filenames.
  A failed dry-run, mismatch or failed apply freezes the target against later apply.
  It returns passed/failed plus actual dryRun/execution receipts; admission failures
  throw. It never decides that a ledger prefix authorizes retry.
- `snapshot(target)` observes ledger presence first. An absent ledger yields `[]`
  only with that actual absence receipt; otherwise actual version/name/statements
  rows are returned unchanged. It also runs hash-bound catalog SQL and observes the
  same-credential TCP psql session. Measured psql identity and source-inferred CLI
  route are distinct fields; `directCliSessionObserved:false` remains explicit.
- `runChecks(target, checks)` accepts `{kind:'sql',path,sha256}` only from the bound
  input set, `{kind:'ensure-pgtap'}`, `{kind:'candidate-precheck'}`, or a separate
  complete batch of 18 `{kind:'race',name}` requests in the pinned profile order.
  SQL exit0 means executed, not TAP acceptance: integration must parse complete,
  unskipped TAP/required assertion output. Candidate precheck uses the pinned profile
  query and its exact booleans. One complete race batch invokes `races.mjs` once;
  partial, duplicate, reordered or mixed requests fail admission. That module binds
  the five helper bytes and uses independent framed psql sessions through this
  adapter's absolute Docker binary and exact owned target. After engine shutdown,
  the adapter separately observes that all other client backends are absent and
  retains that owner inventory receipt. Integration still validates the complete
  race assertion, overlap and shutdown evidence. Failed targets accept only
  snapshot and cleanup; arbitrary post-failure SQL checks cannot hide residual state.
- `stopTarget(target)` removes the exact owned container and verifies actual absence
  before releasing capacity. Stopping a process alone does not free a slot. Removing
  the reference can allow a fresh rebuild beside the retained failed target; it never
  makes the failed target replayable. `cleanup()` removes all owned resources and
  verifies absence. An ownership mismatch or unconfirmed deletion remains failure.
  Final cleanup records each target failure and attempts healthy siblings once
  within the same aggregate deadline. It retains the network when any target is
  unconfirmed, observing attached IDs if the remaining budget permits. Structured
  per-target/network outcomes persist in state.json and on the thrown error as
  cleanupOutcome. Repeated calls after failed final cleanup return that failure
  without retrying any refused target or issuing further commands.
- `abort()` cancels active non-cleanup commands and refuses new ones. Cleanup uses
  its reserved aggregate window after cancellation. Intermediate `stopTarget`
  removals for rebuild use normal-work time and do not start final cleanup. Once
  final cleanup starts, new normal work is refused. SIGKILL cannot promise cleanup; the
  persisted owned IDs remain necessary for a separately reviewed cleanup attempt.

Command receipts retain redacted argv/stdout/stderr, numeric-or-null exit status,
raw termination signal (or null), transport failure, elapsed time and input SHA-256.
Any signal is a transport failure even if diagnostics already contain the expected
SQL marker; a null exit without a signal is exit_unconfirmed. Timeout/abort/output
failures retain their original reason and signal. Only an ordinary numeric nonzero
exit with signal:null and failure:null can supply the normal SQL error part of the
caller's fault gate; marker/SQLSTATE and actual state evidence remain required. Generated ephemeral secrets are never persisted in those receipts.
Evidence and project copies remain in the owned private output directory. Original
source files are never modified, ledger rows are never hand-inserted/repaired, and
no generic SQL or shell command input is exposed.

Fault descriptors use the core schema and fixed deliberate-error SQL. The adapter
independently recomputes prefix + inserted error + suffix and checks resulting bytes,
SHA-256, anchor and insertion position. For inside/post-COMMIT modes it requires a
unique terminal COMMIT anchor. This is a placement check, not an SQL parser or proof
that a syntactic COMMIT is outside all SQL quoting; source review binds the selected
release129 anchor. Actual error marker, SQLSTATE, catalog and ledger observations
must establish the runtime boundary. Every failure target stays frozen.

## Executable preparation path and unperformed actions

No prerequisites are acquired by this module. The last retained host inventory had
Docker28.4.0 Linux/amd64, no cached images and no Supabase CLI/psql/pg_dump in PATH.
That inventory is historical evidence, not a fresh runtime observation.

1. A separately authorized acquisition step supplies CLI **2.78.1**, release/source
   provenance and binary checksum for Linux/amd64, plus the exact cached database
   image `public.ecr.aws/supabase/postgres:17.6.1.095`. Pin the actual immutable image
   ID and repository digest, OS/architecture, entrypoint and command. The adapter
   never runs `pull`, uses `create --pull=never`, and rechecks local inspect identity.
   Tags are source selectors, not immutable qualification.
2. Supply authentic platform SQL matching the fixed manifest. Its reviewed origin is
   `public.ecr.aws/supabase/gotrue:v2.187.0:/usr/local/etc/auth/migrations` and
   `public.ecr.aws/supabase/storage-api:v1.41.8:/app/migrations/tenant`. If extraction
   is needed, separately acquire/cache/inspect those images, then use the pinned
   `free-quote-platform-sources.mjs` stopped-container extraction/ownership algorithm
   with pull removed in a separately admitted preparation operation. Extract sources
   sequentially and remove/verify each source container before creating DB targets.
   This adapter consumes the resulting hash-bound existing bundle; it does not fake
   auth/storage tables or invoke the old CI-only provisioner.
3. Bind the exact source, catalog SQL, tool bytes, daemon socket, image, synthetic
   session contract and private parent directory into an expiring controller receipt.
   Observe baseline postgres membership/CREATEROLE explicitly; do not substitute a
   convenient superuser. Pinned platform bootstrap remains supabase_admin via Unix
   socket and validates the pinned empty auth baseline/owners before and after replay.
4. On admitted execution, mount only the adapter-owned CLI bundle read-only. Copy
   each synthetic project into container tmpfs. CLI runs through docker exec inside
   its own database container against generated postgres credentials at 127.0.0.1;
   no host-published port or third helper container exists. Its HOME/config/env are
   clean, so host tokens are not read. Real `--version` and `db push --help` must pass
   inside the actual image before applying migrations; a Linux binary checksum alone
   does not prove Nix/image ABI compatibility. No `supabase start`, `link`, repair or
   arbitrary connection URL is used.
5. Run admitted stage ordering/checks and retain real observations. The one internal
   network prevents CLI update/telemetry egress. At most two containers, one network;
   each DB has2CPUs/3GiB/256PIDs, tmpfs data1536MiB and tmp256MiB, no privileged mode,
   extra devices/capabilities, host namespace, persistent volume or sensitive mount.
   Each command has at most60s execution and a separately accounted2s termination
   grace, with8MB per stream. One absolute30minute deadline starts at initialization;
   normal work reserves the final60s for aggregate cleanup. Final cleanup shares one
   deadline, min(first-cleanup time+60s, absolute deadline), across every command
   and subsequent attempt. Every command subtracts2s grace from its remaining
   window before launch. Exhaustion records unconfirmed cleanup and cannot count a
   successful removal as verified absence or release its ownership slot. The
   persisted state retains both deadlines and cleanup status. Controller unit
   budget remains60minutes. Cleanup touches only created IDs with exact fixture labels.
6. Supply the exact five race helpers from the candidate: `free-quote-psql-races`,
   `ovd591-psql-concurrency`, `ovd591-sql-qualification`, `ovd591-libpq-environment`
   and `ovd591-qualification-paths` (all under `scripts/`, extension `.mjs`). Their
   SHA-256 identities are fixed in adapter and race-module source. The source profile
   manifest must hash to
   `58404b1a4747e141df1a18e4615b5e52027815d3bc1a5e288e61eef2bb440713`.
   Separately bind the runner/module revision; it need not equal the data candidate
   checkout revision. Execute the real independent-session races only after runtime
   admission. Node fake-process tests establish no race/database qualification.
7. Any required direct in-CLI session observation remains a separate qualification
   gap: psql plus pinned CLI source inference is not direct CLI observation.
   Preserve each failed target's observations before any separately reviewed rebuild.

## Reused source and causal limits

Platform preflight/postcheck, role/search-path/auth-template expansion and candidate
precheck are copied from pinned release `free-quote-ci-profile.mjs` (SHA above).
The ownership/cap/cache design follows existing local fixture contracts without
weakening CI-only admission or importing its pull path.

CLI2.78.1 upstream source at commit
`3db642adde91f7f784437dd54af863791375411e` queues split migration statements then
migration-history insertion in `pkg/migration/file.go`. Its
`internal/utils/connect.go` distinguishes local routing and conditionally switches
role for other login identities; this adapter explicitly uses postgres and labels
that inference. Pinned pgconn1.14.3 allows explicit transaction-control statements
to alter batch transaction boundaries. These facts support the reviewed terminal
COMMIT/error fault design, not a claim that runtime effects have been observed.
See [CLI migration source](https://github.com/supabase/cli/blob/v2.78.1/pkg/migration/file.go)
and [CLI connection source](https://github.com/supabase/cli/blob/v2.78.1/internal/utils/connect.go).
