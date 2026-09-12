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
and 1–2,000 rows. Each row has only nonempty string `kind`, `identity` and
`definition` fields. This is structural validation, not validation of definitions,
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

Successful results are immutable, preserve exact payload text, and record UTF-8
byte counts, SHA256 digests, timestamps, elapsed time and pinned provenance.
`compatibilityValidated`, `privateBindingReady` and `sqlRuntimeQualified` always
remain false. Echoed provenance proves consistency with caller-supplied pins,
not independently authenticated origin. B1 does not run the separate semantic
compatibility validator or qualify a complete acquisition sequence.

## Focused verification and next gate

Run `npm test -- scripts/ovd419-synthetic-catalogue-reader.test.mjs`.
The suite uses only injected in-memory responses and timers. It covers immutable
pins/results, the request budget, failed and late responses, envelope/provenance
rejection, ambiguous JSON, byte/structure limits and catalogue shape.

Complexity: **Medium — proceed with caution**. The regression surface is this
internal helper and its tests; no dependency or existing execution path changes.
No UI demo applies. Rollback is removal of these standalone files.

The next gate is independent review of this exact B1 commit and a separately scoped
synthetic integration with the semantic compatibility validator. A B1 pass alone
does not satisfy that gate.
