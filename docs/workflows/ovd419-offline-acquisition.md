# OVD-419 offline acquisition tooling — Slice A

Status: Slice A source consolidated, reviewed and merged in PR #496. The B1
catalogue seam has structural and semantic constructors; the full finite B reader
and C writer/integration remain incomplete. Production HOLD.

The B2 inventory helper, `validateSyntheticAcquisitionInventory(raw, { mode:
"TEST_ONLY" })`, interprets the pinned `fullInventory` JSON projection. It requires
1–1000 unique Execution names and UIDs, exact projected fields, the expected Job
label, valid UTC creation/completion timestamps and zero running tasks. A missing
zero `runningCount` is supported; missing completion is rejected. Additional label
metadata is retained in exact raw bytes. Empty or saturated inventories never
select a fallback Execution. Selection uses newest creation time at nanosecond
precision, then ascending code-unit name for ties, independent of list order.

Its frozen result binds the exact raw bytes, sorted IDs and selected name/UID.
It does not prove that a transport returned the complete list or that the snapshot
is fresh, and always marks transport/private-binding readiness false. The complete
reader must establish those properties within its original acquisition budget,
compare opening and closing observations, and validate the selected full Execution.
This helper performs no I/O and does not activate the existing diagnostic adapter.

B2 also provides pure `validateSyntheticPrincipal`,
`validateSyntheticSnapshotMetadata`, and `validateSyntheticSecretVersionMetadata`
helpers in `scripts/ovd419-acquisition-metadata.mjs`. Each accepts only TEST_ONLY
options and bounded raw JSON, rejects unknown or decoded duplicate fields, and
returns exact bytes/hash plus a frozen projection. Principal metadata must contain
one ACTIVE account. Snapshot metadata retains positive decimal generation strings
and the v2 binding schema's ETag shape without coercing large numbers to JavaScript
numbers. Secret metadata must identify the fixed global secret in the named project
or a supplied project-number binding, with ENABLED state and a positive numeric
version matching an explicitly numeric reference; `latest` resolves to that number.

The complete reader must establish the project-number binding from its attributable
full Job, validate the Service's existing secret reference, and compare opening and
closing principal/snapshot/version observations. These helpers do not establish
those bindings, transport completeness, timing, freshness or live compatibility.
They always deny transport/private-binding readiness and perform no I/O. Extra
secret payload fields reject. The retained v2 field bounds remain authoritative;
public [Storage JSON metadata](https://docs.cloud.google.com/storage/docs/json_api/v1/objects)
and [SecretVersion metadata](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions)
describe the resource representations, not permission to collect them.

`validateSyntheticRuntimeIamEvidence` is the pure B2 interpreter for the P2 E05
project-policy response and its derived role reads. It selects only exact bindings
for the fixed runtime service account, rejects public members and conditional,
duplicate, malformed, foreign-project, or more-than-50 matching roles, and emits
the exact source-derived argv for global and project-local role metadata. Local
commands use the custom-role ID with the fixed project flag while retaining the
full project role resource as evidence identity. It
requires one exact projected `includedPermissions` response per selected role,
no missing or extra response, and a validated union containing `run.jobs.get` and
`run.executions.list`. Each body stays within 4 MiB and the complete policy/role
set within the acquisition's 32 MiB aggregate bound.

The frozen result retains exact policy/role bytes and hashes, deterministic role,
argv and permission ordering, measured bytes, and false transport/acquisition/
private-binding flags. It does not call IAM, establish that E05 or any role command
ran, or prove the responses came from the fixed project. The complete reader must
bind the command sequence, raw replies, settlement, timing and aggregate transport
accounting to this interpretation. Unrelated policy roles are never projected into
derived role reads; their presence confers no discovery authority.

The shared `validateOvd419ProbeTaskContract` helper is an extraction of the
existing reviewed diagnostic Job task allowlist. The manifest writer remains its
only production caller. It produces a credential-free frozen projection and exact
task fingerprint so a future completed Execution validator can compare the same
task contract without copying it. It does not validate a full Job, Service or
Execution, add accepted cloud fields, or establish transport or private-binding
readiness. Full outer resource shapes still require separately reviewed evidence.

The pure `validateSyntheticFullJob(raw, { mode: "TEST_ONLY", packet,
projectNumber })` helper is the first outer-resource contract based on the twice
observed D089 structure. It requires the full v1 Job root, exact project-number
namespace/self-link identity, positive generation, fixed Job name, closed spec and
status shapes, one supported task, one-at-a-time task configuration, coherent
completed latest-Execution timestamps, and bounded unique conditions. It returns
the exact input bytes/hash plus frozen identity, task, snapshot, resource,
configuration and status fingerprints. A failed, cancelled, or successful latest
historical Execution can be represented; completion is not authentication proof.

Job metadata maps remain closed to source-defined keys. Location/PZS labels,
existing gcloud lifecycle annotations, exact Direct VPC annotations and the two
adapter-known creator/last-modifier keys have bounded semantics. Other labels or
annotations reject. The sanitized D089 HMAC map-key placeholders establish only
that entries existed and never act as wildcard approval. Fields supported by the
outgoing manifest but absent from the twice-observed read shape also reject in this
read-side contract. The helper performs no transport or I/O and always leaves
transport, full-acquisition and private-binding readiness false. Actual production
compatibility remains unproved until the later attributable reader validates its
full read; the completed Execution outer contract remains separate work.

The pure `validateSyntheticFullService(raw, { mode: "TEST_ONLY", packet,
projectNumber })` helper applies the separately reviewed D089 full-Service shape.
It binds the fixed Service identity and project-number namespace, exact immutable
worker image and build, closed Direct VPC/runtime configuration, bounded snapshot
scope, secret reference, one-container resources and revision traffic. Service
readiness requires a unique `Ready=True` condition, equal latest-created and
latest-ready revisions, and coherent status traffic and URL. Missing, false or
unknown Ready states reject even when the revision names agree.

Service metadata maps remain closed to source-defined keys; fields absent from the
twice-observed shape reject instead of inheriting authority from sanitized map-key
placeholders. The returned projection retains the exact input bytes/hash and frozen
configuration/status fingerprints without exposing attribution annotations or any
secret value. The helper performs no I/O and leaves transport, full-acquisition and
private-binding readiness false. Cross-resource agreement remains later-reader work.

The pure `validateSyntheticCompletedExecution(raw, { mode: "TEST_ONLY",
packet, projectNumber, selected })` helper applies the D089 selected terminal
failed-Execution shape. It binds the exact inventory-selected name/UID and
project namespace, fixed parent Job ownership, source-defined labels and Direct
VPC/provenance annotations, one realized task and a coherent failed terminal
status. It reconstructs the underlying reviewed probe task only after validating
the source-defined inline-module and precondition overrides; decoded bytes are
hashed and inspected as data and are never executed.

The Execution projection retains exact input bytes/hash and frozen owner, task,
invocation, runtime, precondition, configuration, status and log-URI fingerprints.
It does not expose the encoded module or precondition body. The observed failed
count and `Completed=False` condition establish historical failure only, not its
authentication classification. Current-Job revision equality is intentionally a
later-reader concern because a completed Execution retains its creating Job
revision. Inventory attribution, cross-resource snapshot/image/configuration
agreement, transport/freshness, full-acquisition qualification and private binding
also remain later-reader work.

The original Slice A assignment and initial evidence below are historical. They do
not replace the current repository workflow or grant protected operation authority.

The implementation is scoped by proposal
`38bd1f69a8db62684322e91ea6a6b8cfb7e5fe2a582f8eef59df9331f546e71b`, accepted design
manifest `6de8011d06b46410d981ad7e184668b6ee96fcc456b80ca149f11f36a9dab5f3` and the
Chief-of-staff's explicit Medium/30-minute Slice A assignment. One release executor
owns the new source. Accepted S3 `e9c1073c` and all earlier evidence remain unchanged.

## Contract and proof boundary

`scripts/ovd419-acquisition-compatibility.mjs` exports
`validateAcquisitionCompatibility(raw, qualification)`. It is synchronous and pure:
no filesystem, transport, SDK, environment/credential discovery, SQL execution,
server/container, timer, writer or production entrypoint. It imports the existing
pure diagnostic digest and reviewed parser support copied byte-identically into
`ovd419-acquisition-support/`. The copied support budget is not invoked here.

Only `TEST_ONLY` input mode is accepted. The caller supplies a separately trusted
qualification tuple: exact acquisition source SHA, input-manifest SHA and numeric
current time. The validator compares evidence against that tuple and fixed accepted
diagnostic/read-plan/query identities. It cannot independently prove the caller's
qualification or the on-disk source/import tree without I/O. A future qualified
reader must establish that trust before invoking it; this is not self-attestation.

The v2 provenance separates `acquisitionSourceCommit` and `diagnosticSourceCommit`
from `inputManifestSha256` and the fixed accepted `readPlanSha256`. Historical c355
is not emitted as new-code provenance. The accompanying separate
`private-bindings-v2.schema.json` proposes those successor identity fields for
later full private bindings; this slice does not implement that complete private
binding object, validate its full resource fields or change a diagnostic consumer.

The result schema is `OVD419-COMPATIBILITY-RESULT-NOT-AUTHORITY-v2`. It is frozen,
contains fixed fingerprints and the exact immutable input string/hash, and always
sets `privateBindingReady:false` and `sqlRuntimeQualified:false`. Accepted raw bytes
are transient in-memory evidence, not a permission to persist or log them. Errors
are always the fixed `acquisition_compatibility_rejected`, with no raw payload.

This result closes only the catalogue, containment, opening/closing NAT and declared
provenance/budget predicates. It does not claim all cloud resources were collected,
that a transport was authentic, that every declared call/byte was actually observed,
or that no resource changed after the final observation. The B1 semantic constructor
uses the separate pure `validateCatalogueCompatibility(raw)` entrypoint for C1-C4
only and never supplies invented observations. A future complete reader must
independently collect and attribute complete Job/Service/Execution/snapshot/principal/
version/egress evidence, enforce real call/body/deadline accounting and supply an
opaque same-invocation result. Neither that reader nor a binding writer exists here.

## Supported evidence

The closed input envelope holds provenance, exact numeric limits, declared usage
and five complete/settled observation records in order: catalogue, opening
containment, opening E13, closing containment and final closingE13. Each record has
an exact ID, sequence, request hash, start/end time and raw payload. The minimal
complete declared acquisition is 34 cloud plus 3 SQL calls; up to 50 role reads produce
84 cloud plus 3 SQL. Catalogue sequence 0, opening containment 1, initial E13 sequence 14,
closing containment at cloudCalls-7 and closingE13 at cloudCalls+2 match the accepted
serial read plan. Other resource observations are deliberately not claimed proven.

SQL payloads support the exact anchored official inner wrapper or a legacy JSON
array containing exactly one `{evidence:...}` row. MCP outer-envelope/transport
unwrapping belongs to the future reader; arbitrary objects, prefixes, multiple
rows and guessed JSON substrings reject. Bounded parsing rejects decoded duplicate
keys, including Unicode equivalents, before full interpretation. Every object
shape uses exact key membership and count, never separator-joined key names.
Accepted whitespace, key order and embedded strings are returned byte-for-byte.

Catalogue C1–C4 requires four ordinary named tables; public queue UUID IDs and
non-null enum statuses with exact labels; the private columns actually referenced
by the pinned RPC; its one zero-argument SQL/STABLE/security-definer JSONB contract,
exact source-body bytes and fixed search path; service-role-only effective execute,
public schema/column privileges and unfiltered caller; and exactly two private
RPC-owner visibility records with USAGE, SELECT and unfiltered visibility strictly
true. The bound query evaluates USAGE against each private relation namespace for
the same RPC owner. A public namespace substitute, duplicate/missing record or
false/null/string/unknown permission field rejects.

All returned catalogue rows use a known kind, scoped identity and exact typed
metadata shape. Non-required column/index/constraint/policy/trigger metadata for
the four named relations is retained in accepted bytes and checked for scope/shape;
it is not silently stripped, nor claimed globally equivalent to a production schema.
Duplicate row identities or column numbers reject. A client marked superuser while
its effective EXECUTE is reported denied is contradictory and rejects. SQL runtime
qualification remains necessary to establish that actual rows represent those
privileges and the same source/query, rather than merely fixture claims.

C5–C6 requires two identical containment projections: read-only/unfiltered SQL
caller, exactly four sorted disabled controls, bounded nonnegative queue totals,
zero active/invalid counts and valid fingerprints. Empty queues require the empty
string hash. The controls hash uses only the exact sorted `{capability,enabled}`
array with the existing digest. Queue fingerprints are SQL stability evidence, not
runtime row fingerprints; uniqueness/non-null/status checks are encoded in the
pinned SQL summary and are not independently reconstructed from absent queue rows.

Both E13 observations must be complete, settled, strictly valid empty arrays. Nonzero
closing mappings reject regardless of unchanged configuration; malformed/unknown
results are never treated as zero. No raw mapping identifiers are returned separately.

## Limits and failure behavior

The accepted design limits are fixed, not caller-adjustable: one attempt, zero
retries; 84 cloud / 3 SQL / 87 combined calls; 900000 ms aggregate and 30000 ms per read;
4 MiB cloud replies; 2 MiB SQL payload plus 64 KiB wrapper allowance; 32 MiB aggregate;
1000 list entries, 50 matching roles, 2000 catalogue rows, 100000 queue rows; 1 MiB private
and sanitized output caps for the later writer. The parser also enforces the
unchanged depth 16 / key 32768 / token 131072 bounds. Slice A performs no writes.

Each supplied observation must have monotonic start/end times within the declared
invocation and per-read bound. The qualification clock must not precede completion;
completion and last closing observation must be at most 30000 ms old. Supplied usage
must cover at least all retained payload bytes and match the elapsed interval.
Lost/incomplete/unsettled/out-of-order/stale records and extended caps reject.
These are pure checks of declared evidence; actual timeout cancellation, streaming
byte accounting and late-response exclusion are B's required executable tests.

On rejection no input is mutated, no response is repaired and no I/O is performed.
There is no cleanup or rollback operation in A. Abandoning this local source
successor preserves the accepted S3/design packages; it never restores the rejected
old S3 version into runtime use or creates new live authority.

## Historical Slice A verification and remaining work

Fixtures are generated in memory with TEST_ONLY identities, synthetic catalogue
metadata and the already approved non-secret RPC source bytes. They contain no
actual response, customer row, snapshot, credential or private resource state.
Tests replace filesystem creation/subprocess functions with forbidden spies and
assert no calls for acceptance/rejection. Tests cover ordinary/escaped duplicates,
unknown/missing keys/rows, stale/mismatched provenance, lost/unsettled observations,
query changes, closing nonzero mappings, permission contradictions, queue changes,
byte/row/depth/count bounds and exact accepted bytes/wrappers.

A test-first missing-module failure was expected before implementation. Seventy
initial focused cases passed. An extra adversarial case then exposed a joined-key
comparison collision (`acl|default`); it failed before the field-membership repair
and passes afterward. Preserve both red logs. Independent review must judge the
final exact source and complete evidence, not the earlier green snapshot.

Local verification results and exact hashes live in the immutable Slice A evidence
package. The support package is rerun unchanged under network denial; those tests
prove the original support behavior plus copy-byte equality, not transport behavior
of an acquisition reader. No SQL parser/runtime qualification, installation,
protected read, application/provider action, publication, merge or deployment occurs.

Remaining: full B/C implementation and independent reviews, SQL runtime
qualification, production transport/consumer integration,
actual private bindings/resource compatibility and final immutable action packet.
No successful fixture result admits any of those operations. Demo not applicable;
no migration, dependency or worker change. The external tracker projection remains
with the coordinator under this source-only/no-publication assignment.

Final local evidence:71 Slice A cases are included in526 passing affected tests
across12files, with network denied. The unchanged original support package also
passes174tests under network denial, and its two copied module hashes match.
Explicit recommended-rule source lint, root lint, application typecheck/build,
repository preflight and diff checks passed. The existing build chunk-size warning
remains. No hosted checks or live tests were run. These results await independent
review of the exact committed successor and do not close later execution gates.
