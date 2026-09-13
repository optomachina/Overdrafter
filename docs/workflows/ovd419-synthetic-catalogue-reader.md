# OVD-419 B1 synthetic catalogue reader

`scripts/ovd419-synthetic-catalogue-reader.mjs` is an isolated, test-only acquisition
seam. It has no default transport, command-line entrypoint, environment lookup, or
application wiring. The caller supplies an inert fixture callback. That callback
is trusted code; this module does not sandbox arbitrary callback behavior.

## Contract

Construct `createSyntheticCatalogueReader({ transport, qualification })` and call
the returned `read()` once. Qualification has exactly `mode: "TEST_ONLY"`, a full
lowercase `acquisitionSourceCommit`, a lowercase SHA256 `inputManifestSha256`, and
an `invocationId` matching `TEST_ONLY_` followed by 1–80 letters, digits, underscores
or hyphens. The reader snapshots these pins and adds the fixed diagnostic source
and read-plan identities in `SYNTHETIC_CATALOGUE_CONTRACT`.

The callback receives an immutable request with schema, test mode, catalogue ID,
sequence zero, query digest and provenance, plus `{ signal, maxBytes }`. It must
return a string serialized with `JSON.stringify` with exactly these fields:

- `schema`: `OVD419-SYNTHETIC-CATALOGUE-RESPONSE-v1`
- `mode`: `TEST_ONLY`; `id`: `catalogue`; `sequence`: `0`
- `requestSha256` and `provenance`: exact echoes of the request
- `complete: true`, `settled: true`, `isError: false`
- `payload`: a second `JSON.stringify` string containing one `{ evidence }` row

Evidence has exactly schema
`OVD419-DIAGNOSTIC-CATALOGUE-COMPATIBILITY-NOT-AUTHORITY-v1`, `relationCount: 4`,
and 1–2,000 rows. Each row has only nonempty string `kind` and `identity` fields
and an object-valued `definition`, matching the pinned catalogue SQL's
`jsonb_build_object` metadata. Null, arrays and scalar definitions reject.
Definition contents remain subject to the same JSON byte/depth/structure bounds;
their typed semantic fields belong to the separate compatibility validator.
This is structural validation, not validation of definitions,
identities or the truth of the reported relation count. Wrapped prose and other
connector response formats are outside B1.

## Bounds and failure behavior

Each reader instance admits at most one callback invocation, with zero retries.
The budget is consumed synchronously before dispatch; concurrent calls, calls
after success, and calls after failure are rejected. Creating another reader is
a new caller-controlled fixture instance, not permission for another acquisition.

The deadline is 30 seconds; the response ceiling is 2 MiB + 64 KiB and the payload
ceiling is 2 MiB. Optional `timeoutMs` and `maxResponseBytes` may only tighten the
first two limits. Each JSON string is limited to nesting depth 16 and 131,072
structural tokens before parsing. Canonical reserialization rejects duplicate
keys, escaped duplicate aliases, alternate encodings and trailing content.

The callback must honor the abort signal and enforce its own allocation limits.
The reader bounds returned text at the callback boundary; it cannot preempt a
synchronously blocking callback or undo callback side effects. It rejects overdue
responses even if the timer was delayed, aborts on failure, and never admits a late
result after timeout. Transport errors are replaced with a fixed error message.
Deadline checks follow validation and result hashing. Successful elapsed time and
completion timestamps include that metadata work; completion at the deadline is rejected.

Successful results are immutable, preserve exact payload text, and record UTF-8
byte counts, SHA256 digests, timestamps, elapsed time and pinned provenance.
`compatibilityValidated`, `privateBindingReady` and `sqlRuntimeQualified` always
remain false in both constructors. Echoed provenance proves consistency with caller-supplied pins,
not independently authenticated origin. The original structural constructor does
not run catalogue semantics. Neither constructor qualifies a complete acquisition
sequence.

## Catalogue semantic acquisition

`createSyntheticCatalogueAcquisition({ transport, qualification, ...limits })`
uses the same private one-use engine and fixed request envelope. It applies the
retained `validateCatalogueCompatibility(payload)` predicate to the exact captured
payload after structural/provenance checks. That pure entrypoint reuses Slice A's
C1-C4 catalogue checks; it does not manufacture containment, NAT, or resource
observations to satisfy the complete compatibility validator.

A successful result uses schema
`OVD419-SYNTHETIC-CATALOGUE-ACQUISITION-NOT-AUTHORITY-v1`, adds
`catalogueCompatibilityValidated:true` and the `catalogueFingerprint`, and preserves
response/payload bytes, hashes, provenance and immutable metadata. All three broader
readiness flags remain false. The original structural result schema and fields are
unchanged. Neither a result nor its fingerprint authenticates fixture claims.

Semantic validation and fingerprinting occur before the original deadline and
metadata checks finish. Elapsed time and completion timestamps include that work;
completion at the deadline rejects and aborts the same signal. A semantic denial
returns the fixed `acquisition_compatibility_rejected`, consumes the attempt, and
aborts the signal. Transport failure, malformed provenance, late completion and
all existing structural limits retain their original rejection behavior.

## Synthetic acquisition prefix

`createSyntheticAcquisitionPrefix({ transport, qualification })` extends the same
injected `TEST_ONLY` seam through the locally specified portion of B3. It performs
the semantic catalogue read at sequence 0, validates opening containment at
sequence 1, then passes the exact source-derived E01-E18 argv through the stable
egress collector at sequences 2-19. Every emitted argv must match its pinned
SHA256 from source catalogue
`8bfe1fb3b1499e2ed3b5983719e1e0fd132b9298574aeeeb6db64a8dd52197ba`.
After stable-egress evaluation passes, the E05 policy is parsed by the shared IAM
selector and its one to fifty role descriptions run at sequences 20-69. The
shared IAM validator must accept the exact retained policy and role payloads.

The callback receives an immutable request and `{ signal, maxBytes }`. Prefix
responses are canonical `JSON.stringify` strings with schema
`OVD419-SYNTHETIC-ACQUISITION-PREFIX-RESPONSE-v1`, exact request identity,
sequence, digest and provenance echoes, `complete:true`, `settled:true`,
`isError:false`, and an exact raw payload string. Catalogue responses retain the
original catalogue response schema. The prefix has no default transport,
environment lookup, CLI or executable entrypoint.

One prefix instance admits one attempt and consumes it before the catalogue
dispatch. All 21-70 calls are awaited serially with zero retries. Each read is
limited to 30 seconds within one 15-minute total deadline. SQL payloads retain the
2 MiB plus 64 KiB wrapper ceiling, cloud payloads retain the 4 MiB ceiling, and
accepted payload bytes share the 32 MiB aggregate ceiling. Each observation
preserves its exact response and payload bytes, hashes, argv, timestamps,
sequence, completion and settlement evidence. Any transport, envelope,
provenance, deadline, catalogue, containment, argv, egress, IAM or aggregate
failure terminates the attempt.

A successful immutable result uses schema
`OVD419-SYNTHETIC-ACQUISITION-PREFIX-NOT-AUTHORITY-v1`, records exact usage and
catalogue, containment, controls, egress and IAM fingerprints, and sets
`prefixQualified:true`. `transportQualified`, `fullAcquisitionQualified` and
`privateBindingReady` remain false. The reader stops immediately after IAM. It
does not request full Job, Service or Execution resources and cannot issue the
opaque B3 handoff.

## Focused verification and next gate

Run `npm test -- scripts/ovd419-synthetic-catalogue-reader.test.mjs scripts/ovd419-catalogue-semantic-acquisition.test.mjs scripts/ovd419-synthetic-acquisition-prefix.test.mjs scripts/ovd419-acquisition-compatibility.test.mjs scripts/ovd419-acquisition-iam.test.mjs scripts/verify-xometry-stable-egress.test.mjs`.
The suite uses only injected in-memory responses and timers. It covers immutable
pins/results, the request budget, failed and late responses, envelope/provenance
rejection, ambiguous JSON, byte/structure limits and catalogue shape.

Complexity: **High — decomposed before full-resource acquisition**. The prefix
adds bounded async sequencing and shared budget accounting across existing pure
validators, without a dependency or existing execution-path change.
No UI demo applies. Rollback is removal of these standalone files.

PR #496 closed the inherited source review and consolidation gate. The full-resource
shape evidence, remaining finite reader, same-invocation opaque handoff, private
fixture writer, SQL runtime qualification and protected acquisition remain separate
incomplete gates. A prefix result does not satisfy them.
