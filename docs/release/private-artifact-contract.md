# Private first-loop artifact adapter (source only)

`createPrivateNativeArtifactHandler` composes the existing OVD-519 handler with
concrete parameterized SQL and conditional immutable Storage operations. It is
default-off, creates isolated per-request state, accepts no path/bucket from the
worker, and has no network driver, credentials, deployment or worker activation.
This is for the existing prepared-dimension v2 three-input/seven-output loop.

## Explicit missing mapping contract

The active ownership schema stores an input admission's snapshot, producer and
manifest digests, but no opaque artifact ID to Storage generation mapping.
`private-artifact-forward.sql` therefore stages two private immutable tables:

- Three `native_artifact_inputs` rows per input admission, ordinals 0..2, binding
  opaque ID to existing Storage object ID, version, updated time, byte length and
  SHA-256. A trusted admission writer must independently verify the bytes and
  bind these rows to the admitted manifest. The adapter requires all three rows
  and checks their lengths/hashes against the attempt's frozen job. It never
  populates mappings from worker headers.
- Seven `native_artifact_outputs` rows per exact attempt, one per fixed role,
  with a private bucket selected by a trusted admission writer and a generated
  `native-results/<attempt UUID>/<role>` object name. The adapter requires all
  seven rows, and never creates a mapping from an upload request.

No admission writer/provisioning is supplied or run. No rows, buckets, grants,
roles, credentials or active migrations are added. Both tables have RLS, no
runtime grants, and immutable update/delete triggers. The staged reverse script
requires READ COMMITTED and locks both tables before checking emptiness, then
refuses nonempty mappings. These scripts require existing ownership and staged
OVD-560 schema and must be independently qualified in a disposable database.
They have not been executed in this environment.

## Authority and phase ordering

The adapter compares the whole requested scope with the authoritative attempt,
paired worker/installation/current boot/current enabled session, task's current
attempt, tenant/project/owner and input admission producer. The predecessor is
`native_input_admissions.producer_attempt_id`, not the retry's previous attempt.
It checks the hashed paired credential, current actor access, no admission
revocations, session expiry and pause/revocation on every authorization read.

Input reads additionally require the existing `native_attempt_reason` to be
eligible, retaining lease/deadline/slot ownership checks. Output delivery instead
requires `awaiting_result`, result eligibility, a stop admission and stopped
timestamp, and unverified/checking verification state. It does not require a
live native lease: stopped attempts cannot renew one. Therefore freeze outputs
before stop, obtain independent qualified stop admission, then explicitly replay
the retained output bytes. No retry of native execution is part of this adapter.

## Exact driver operations

The injected SQL driver must execute the supplied parameterized statements,
return JSON values without coercing booleans/numbers, bound each query to its
signal and 30-second maximum, and provide a same-connection READ COMMITTED transaction which
rolls back errors and never retries automatically. The final transaction calls
the existing `lock_native_task(worker, credentialHash, task, false)`, rechecks
the actual transaction isolation, takes the attempt lock and SHARE locks on
admission revocations, operators, organization/project memberships and projects,
and locks the exact Storage object and bucket before rechecking output authority
and exact Storage generation. It then calls the existing staged
`register_native_result_object` with all 15 measured identity parameters. The write statement also includes the
full fresh authority predicate and exact scope binding, preventing session expiry
between the preceding adapter check and write from acknowledging delivery. It
uses the established slot/worker/conversation/task lock order. There is no
invented RPC or service-role shortcut. The existing registration function
requires the private database owner's capability; provisioning or changing that
boundary is a separate authorized deployment task.

The injected Storage driver receives concrete GET operations with private
bucket/name/object ID/version/updated time and required `ifMatch=version`, and
PUT operations with `ifNoneMatch=*`, application/octet-stream and measured
bytes. It must enforce exact-generation reads and atomic conditional creation;
upsert is forbidden. No claim is made that an unqualified SDK supports those
semantics. Its implementation and actual provider semantics remain to qualify.
A create conflict follows exact readback; unknown outcomes throw without retry.
The adapter rehashes retained bytes, checks generation after readback, and then
uses the existing independent measured registration reader. Identical replay
returns delivered=true when registration reports its existing row (`false`).
Delivery does not imply verification/finalization.

Storage I/O is outside database locks. A revocation during a create may leave an
unregistered immutable object; it cannot produce a successful registration
without the fresh locked checks. Retain it for exact replay/qualified recovery.
Never overwrite it, silently select another name or restart CAD.

## Verification limits

Run existing installed dependencies only:

```
./node_modules/.bin/vitest run server/engineering/native-artifact-runtime.test.ts server/engineering/native-artifact-transport.test.ts server/engineering/native-result-registration.test.ts
./node_modules/.bin/tsc --noEmit -p tsconfig.server.json
./node_modules/.bin/eslint server/engineering/native-artifact-{repository,runtime,runtime.test}.ts
```

Node tests use inert fake SQL/Storage drivers. They exercise real handler and
adapter code, statement parameter order, locked registration, every output role,
phase/scope denial, unchanged response-loss replay, generation/byte substitution,
authority loss and request isolation. They do not execute PostgreSQL or qualify
its grants/locks, an actual Storage provider, Windows, Edge or any native CAD.
Before deployment, add disposable SQL schema/constraint/grant/rollback and
concurrency proofs, real driver conditional-object proofs and separately
approved current-head connected Windows qualification. No tool installations or
container pulls were performed for these tests.
